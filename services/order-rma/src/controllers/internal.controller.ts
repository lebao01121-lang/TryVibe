import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Post,
  Query,
} from '@nestjs/common';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { assertInternalSecret } from '../common/api-exception';
import { ORDER_CONFIG_TOKEN, SERVICE_NAME, type OrderRmaConfig } from '../config/env';
import { OrderRmaService } from '../services/order-rma.service';

@Controller('internal')
export class InternalOrderController {
  constructor(
    @Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig,
    private readonly orderRmaService: OrderRmaService,
  ) {}

  @Post('events/payment-succeeded')
  @HttpCode(HttpStatus.OK)
  async handlePaymentSucceeded(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.handlePaymentSucceededEvent(body, {
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('orders/test-expire')
  @HttpCode(HttpStatus.OK)
  async testExpireOrder(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<{ orderId: string; orderCode: string; reservationExpiresAt: string }>
  > {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.orderRmaService.testExpireOrder(body);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('orders/run-expire')
  @HttpCode(HttpStatus.OK)
  async runExpireSweep(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<{ expiredCount: number; expiredOrderCodes: string[] }>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.orderRmaService.runExpirySweep({
      correlationId,
      traceparent,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('orders/delivered-check')
  async checkDeliveredPurchase(
    @Query('userId') userId: string | undefined,
    @Query('productId') productId: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<{ eligible: boolean; orderCode?: string; orderId?: string }>> {
    assertInternalSecret(headers, this.config.internalServiceSecret);
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.orderRmaService.checkDeliveredPurchase(userId, productId);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
