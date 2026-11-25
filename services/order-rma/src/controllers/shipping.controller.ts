import {
  Body,
  Controller,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';
import type { RawBodyRequest } from '@nestjs/common';
import type { Request } from 'express';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import {
  OrderRmaService,
  type ShippingQuoteResponseDto,
  type ShippingWebhookProcessResult,
} from '../services/order-rma.service';

@Controller('v1/shipping')
export class ShippingController {
  constructor(private readonly orderRmaService: OrderRmaService) {}

  @Post('quote')
  @HttpCode(HttpStatus.OK)
  async quoteShipping(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<ShippingQuoteResponseDto>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.orderRmaService.quoteShipping(body);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  async handleShippingWebhook(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ApiResponse<ShippingWebhookProcessResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const rawBody =
      req.rawBody ??
      Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}), 'utf8');

    const data = await this.orderRmaService.handleShippingWebhook(
      provider,
      body,
      rawBody,
      headers,
      { correlationId, traceparent },
    );

    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
