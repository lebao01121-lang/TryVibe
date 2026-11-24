import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import {
  createApiResponse,
  type ApiResponse,
  type PaymentIntentResponseDTO,
  type RefundResponseDTO,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import {
  PaymentsService,
  type DevSimulateWebhookResult,
  type PaymentOpsMetrics,
  type PaymentTransactionView,
  type WebhookProcessResult,
} from './payments.service';

function readSingleHeader(headers: HeaderBag, name: string): string | null {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  const candidate = Array.isArray(raw) ? raw[0] : raw;
  if (typeof candidate !== 'string') {
    return null;
  }
  const trimmed = candidate.trim();
  return trimmed.length > 0 ? trimmed : null;
}

@Controller('v1')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('payments/intents')
  async createIntent(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PaymentIntentResponseDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const idempotencyKey = readSingleHeader(headers, 'idempotency-key');
    const data = await this.paymentsService.createPaymentIntent(body, idempotencyKey);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('webhooks/payments/:provider')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ApiResponse<WebhookProcessResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const signature =
      readSingleHeader(headers, 'x-webhook-signature') ??
      readSingleHeader(headers, 'x-hub-signature-256') ??
      readSingleHeader(headers, 'x-vnp-signature');

    const rawBodyString = Buffer.isBuffer(req.rawBody)
      ? req.rawBody.toString('utf8')
      : typeof req.rawBody === 'string'
        ? req.rawBody
        : JSON.stringify(body ?? {});

    const data = await this.paymentsService.processPaymentWebhook(
      provider,
      rawBodyString,
      signature,
      body,
      correlationId,
      traceparent,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('payments/dev-simulate-webhook')
  @HttpCode(HttpStatus.OK)
  async devSimulateWebhook(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<DevSimulateWebhookResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.paymentsService.devSimulateWebhook(body, correlationId, traceparent);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('payments/refunds')
  @HttpCode(HttpStatus.OK)
  async createRefund(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<RefundResponseDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const idempotencyKey = readSingleHeader(headers, 'idempotency-key');
    const data = await this.paymentsService.createRefund(body, idempotencyKey);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/ops/metrics')
  async getOpsMetrics(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PaymentOpsMetrics>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.paymentsService.getOpsMetrics();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/transactions/:orderCode')
  async getTransactions(
    @Param('orderCode') orderCode: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PaymentTransactionView[]>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.paymentsService.getTransactionsByOrderCode(orderCode);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }
}
