import * as crypto from 'node:crypto';
import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Post,
  Req,
} from '@nestjs/common';
import {
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  type ApiResponse,
} from '@atelier/contracts';
import {
  createLogger,
  getOrCreateCorrelationId,
  type HeaderBag,
  type Logger,
} from '@atelier/observability';
import type { Request } from 'express';
import { BffRedisService } from '../common/redis.service';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';
import {
  RealtimeGateway,
  recordOrderEventForReplay,
  recordTryOnEventForReplay,
  RootRealtimeGateway,
  type OrderRealtimeEventName,
  type TryOnRealtimeEventName,
} from './realtime.gateway';

const ALLOWED_TRYON_EVENTS: ReadonlySet<string> = new Set([
  'tryon:progress',
  'tryon:completed',
  'tryon:failed',
]);

const ALLOWED_ORDER_EVENTS: ReadonlySet<string> = new Set([
  'order:paid',
  'order:updated',
  'order:packed',
  'order:shipped',
  'order:delivered',
  'payment:late-alert',
]);

export interface InternalTryOnEventBody {
  event?: string;
  sessionId?: string;
  errorCode?: string | null;
  providerDisplayBadge?: string | null;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface InternalOrderEventBody {
  event?: string;
  orderId?: string;
  orderCode?: string;
  status?: string;
  shipment?: Record<string, unknown> | null;
  payload?: Record<string, unknown>;
  [key: string]: unknown;
}

function timingSafeSecretEqual(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Controller('internal/realtime')
export class InternalRealtimeController {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(RealtimeGateway) private readonly realtimeGateway: RealtimeGateway,
    @Inject(RootRealtimeGateway) private readonly rootRealtimeGateway: RootRealtimeGateway,
  ) {}

  @Post('tryon-event')
  @HttpCode(HttpStatus.OK)
  async broadcastTryOnEvent(
    @Body() body: InternalTryOnEventBody | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<{ broadcasted: boolean; room: string; event: TryOnRealtimeEventName }>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertInternalSecret(req, correlationId);

    const eventName = typeof body?.event === 'string' ? body.event.trim() : '';
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';

    if (!ALLOWED_TRYON_EVENTS.has(eventName) || !sessionId) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Body must include valid event (tryon:progress | tryon:completed | tryon:failed) and non-empty sessionId.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.BAD_REQUEST,
      );
    }

    const typedEvent = eventName as TryOnRealtimeEventName;
    const nestedPayload: Record<string, unknown> =
      body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};
    const flatRest: Record<string, unknown> = {};
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) {
        if (k !== 'event' && k !== 'sessionId' && k !== 'payload') {
          flatRest[k] = v;
        }
      }
    }

    const mergedPayload: Record<string, unknown> = {
      ...flatRest,
      ...nestedPayload,
    };
    if (mergedPayload.errorCode === undefined && typeof mergedPayload.error_code === 'string') {
      mergedPayload.errorCode = mergedPayload.error_code;
    }
    if (
      mergedPayload.providerDisplayBadge === undefined &&
      typeof mergedPayload.provider_display_badge === 'string'
    ) {
      mergedPayload.providerDisplayBadge = mergedPayload.provider_display_badge;
    }

    const eventData = await recordTryOnEventForReplay(
      sessionId,
      typedEvent,
      mergedPayload,
      this.redis,
    );
    this.realtimeGateway.emitTryOnEvent(sessionId, typedEvent, eventData);
    this.rootRealtimeGateway.emitTryOnEvent(sessionId, typedEvent, eventData);

    const room = `tryon:${sessionId}`;
    this.logger.info(
      { room, event: typedEvent, correlationId },
      'Broadcasted AI Try-On realtime event to Socket.io rooms (/realtime and /)',
    );

    return createApiResponse(
      {
        broadcasted: true,
        room,
        event: typedEvent,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  @Post('order-event')
  @HttpCode(HttpStatus.OK)
  async broadcastOrderEvent(
    @Body() body: InternalOrderEventBody | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<{ broadcasted: boolean; rooms: string[]; event: OrderRealtimeEventName }>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertInternalSecret(req, correlationId);

    const eventName = typeof body?.event === 'string' ? body.event.trim() : '';
    const orderId = typeof body?.orderId === 'string' ? body.orderId.trim() : '';
    const orderCode = typeof body?.orderCode === 'string' ? body.orderCode.trim() : '';

    if (!ALLOWED_ORDER_EVENTS.has(eventName) || (!orderId && !orderCode)) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Body must include valid order event (order:paid | order:updated | ...) and orderCode or orderId.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.BAD_REQUEST,
      );
    }

    const typedEvent = eventName as OrderRealtimeEventName;
    const keys = [orderCode, orderId].filter((k) => k.length > 0);
    const rooms = Array.from(new Set(keys.map((k) => `order:${k}`)));

    const nestedPayload: Record<string, unknown> =
      body?.payload && typeof body.payload === 'object' && !Array.isArray(body.payload)
        ? body.payload
        : {};
    const flatRest: Record<string, unknown> = {};
    if (body && typeof body === 'object') {
      for (const [k, v] of Object.entries(body)) {
        if (k !== 'event' && k !== 'payload') {
          flatRest[k] = v;
        }
      }
    }

    const mergedPayload: Record<string, unknown> = {
      ...flatRest,
      ...nestedPayload,
      ...(orderId ? { orderId } : {}),
      ...(orderCode ? { orderCode } : {}),
      timestamp: new Date().toISOString(),
    };

    const eventData = await recordOrderEventForReplay(keys, typedEvent, mergedPayload, this.redis);
    this.realtimeGateway.emitOrderEvent(keys, typedEvent, eventData);
    this.rootRealtimeGateway.emitOrderEvent(keys, typedEvent, eventData);

    this.logger.info(
      { rooms, event: typedEvent, correlationId },
      'Broadcasted Order realtime event to Socket.io rooms (/realtime and /)',
    );

    return createApiResponse(
      {
        broadcasted: true,
        rooms,
        event: typedEvent,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  private assertInternalSecret(req: Request, correlationId: string): void {
    const rawSecret = req.headers['x-internal-secret'];
    const providedSecret = Array.isArray(rawSecret) ? rawSecret[0] : rawSecret;

    if (
      typeof providedSecret !== 'string' ||
      providedSecret.length === 0 ||
      !timingSafeSecretEqual(providedSecret, this.config.internalServiceSecret)
    ) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Invalid or missing x-internal-secret header.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }
  }
}
