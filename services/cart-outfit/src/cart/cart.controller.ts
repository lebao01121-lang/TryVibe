import * as crypto from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
} from '@nestjs/common';
import {
  createApiResponse,
  ErrorCode,
  type ApiResponse,
  type CartDto,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { CartApiException } from '../common/cart-api.exception';
import {
  CART_CONFIG_TOKEN,
  SERVICE_NAME,
  type CartOutfitConfig,
} from '../config/env';
import { CartOutfitService, type CartActorContext } from './cart-outfit.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readSingleHeader(headers: HeaderBag, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function extractCartActor(headers: HeaderBag): CartActorContext {
  const correlationId = getOrCreateCorrelationId(headers);
  const traceparent = getOrCreateTraceparent(headers);
  const rawUserId = readSingleHeader(headers, 'x-user-id');
  const rawGuestId = readSingleHeader(headers, 'x-guest-session-id');

  const userId = rawUserId && UUID_REGEX.test(rawUserId) ? rawUserId : null;
  const guestSessionId = rawGuestId ? rawGuestId.slice(0, 120) : null;

  return {
    correlationId,
    traceparent,
    userId,
    guestSessionId,
  };
}

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Controller('v1/cart')
export class CartController {
  constructor(
    @Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig,
    private readonly cartService: CartOutfitService,
  ) {}

  @Get()
  async getCart(@Headers() headers: HeaderBag): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.getCart(actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('items')
  async addItem(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.addItem(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('outfit-bundle')
  async addOutfitBundle(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.addOutfitBundle(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Patch('items/:itemId')
  async updateItem(
    @Param('itemId') itemId: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.updateItem(itemId, body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Delete('items/:itemId')
  async deleteItem(
    @Param('itemId') itemId: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.deleteItem(itemId, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Put('packaging')
  async updatePackaging(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.updatePackaging(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('merge')
  @HttpCode(HttpStatus.OK)
  async mergeGuestCart(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CartDto>> {
    const actor = extractCartActor(headers);
    const data = await this.cartService.mergeGuestCart(body, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('internal/clear')
  @HttpCode(HttpStatus.OK)
  async clearCartInternal(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CartOutfitService['clearCartInternal']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const providedSecret = readSingleHeader(headers, 'x-internal-secret');
    const expectedSecret = this.config.internalServiceSecret;
    if (!providedSecret || !expectedSecret || !timingSafeSecretEquals(providedSecret, expectedSecret)) {
      throw new CartApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Invalid or missing x-internal-secret header',
      );
    }
    const data = await this.cartService.clearCartInternal(body, correlationId);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
