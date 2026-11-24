import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
} from '@nestjs/common';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { extractHeader, timingSafeSecretEqual } from '../common/api-exception';
import { ORDER_CONFIG_TOKEN, SERVICE_NAME, type OrderRmaConfig } from '../config/env';
import {
  OrderRmaService,
  type CheckoutOrderResult,
  type ExtendedOrderDTO,
  type OrderActorContext,
  type OrderOpsMetricsDto,
} from '../services/order-rma.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function extractOrderActor(
  headers: HeaderBag,
  internalServiceSecret?: string,
): OrderActorContext {
  const correlationId = getOrCreateCorrelationId(headers);
  const traceparent = getOrCreateTraceparent(headers);
  const rawUserId = extractHeader(headers, 'x-user-id');
  const rawGuestId = extractHeader(headers, 'x-guest-session-id');
  const rawLoyaltyTier = extractHeader(headers, 'x-loyalty-tier');
  const rawRoles = extractHeader(headers, 'x-actor-roles');
  const providedInternalSecret = extractHeader(headers, 'x-internal-secret');

  const actorRoles = rawRoles
    ? rawRoles
        .split(',')
        .map((role) => role.trim().toUpperCase())
        .filter((role) => role.length > 0)
    : [];

  const isInternal = Boolean(
    internalServiceSecret &&
      providedInternalSecret &&
      timingSafeSecretEqual(providedInternalSecret, internalServiceSecret),
  );

  return {
    userId: rawUserId && UUID_REGEX.test(rawUserId) ? rawUserId : null,
    guestSessionId: rawGuestId ? rawGuestId.slice(0, 128) : null,
    loyaltyTier: rawLoyaltyTier ? rawLoyaltyTier.toUpperCase() : null,
    actorRoles,
    isInternal,
    correlationId,
    traceparent,
  };
}

@Controller()
export class OrdersController {
  constructor(
    @Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig,
    private readonly orderRmaService: OrderRmaService,
  ) {}

  @Post('v1/orders')
  @HttpCode(HttpStatus.CREATED)
  async createOrder(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<CheckoutOrderResult>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const idempotencyKey =
      extractHeader(headers, 'idempotency-key') ?? extractHeader(headers, 'Idempotency-Key');
    const data = await this.orderRmaService.createOrder(body, idempotencyKey, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/orders/me')
  async listMyOrders(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO[]>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.listMyOrders(actor.userId);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/orders/:orderCode')
  async getOrderByCode(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO>> {
    const actor = extractOrderActor(headers, this.config.internalServiceSecret);
    const data = await this.orderRmaService.getOrderByCode(orderCode, actor);
    return createApiResponse(data, {
      correlationId: actor.correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/admin/orders/ops-metrics')
  async getOrderOpsMetrics(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<OrderOpsMetricsDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.orderRmaService.getOrderOpsMetrics();
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('v1/admin/orders')
  async listAdminOrders(
    @Query('status') status: string | undefined,
    @Query('q') q: string | undefined,
    @Query('limit') limitRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsedLimit = limitRaw ? Number.parseInt(limitRaw, 10) : undefined;
    const data = await this.orderRmaService.listAdminOrders({
      status,
      q,
      limit: Number.isFinite(parsedLimit) ? parsedLimit : undefined,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/orders/:orderCode/pack')
  @HttpCode(HttpStatus.OK)
  async packOrder(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.packOrder(orderCode, body, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/orders/:orderCode/ship')
  @HttpCode(HttpStatus.OK)
  async shipOrder(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.shipOrder(orderCode, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/orders/:orderCode/deliver')
  @HttpCode(HttpStatus.OK)
  async deliverOrder(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ExtendedOrderDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.deliverOrder(orderCode, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('v1/admin/orders/:orderCode/refund-late-payment')
  @HttpCode(HttpStatus.OK)
  async refundLatePayment(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<OrderRmaService['refundLatePayment']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.refundLatePayment(orderCode, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
