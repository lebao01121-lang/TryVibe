import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
  type RawBodyRequest,
} from '@nestjs/common';
import type { Request } from 'express';
import { createApiResponse, type ApiResponse } from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { SERVICE_NAME } from '../config/env';
import {
  PaymentsService,
  type AdminPaymentTransactionsListResult,
  type AdminPaymentWebhooksListResult,
  type DevSimulateWebhookResult,
  type PaymentOpsMetrics,
  type PaymentReturnVerificationDTO,
  type PaymentTransactionView,
  type RichPaymentIntentResponseDTO,
  type RichRefundResponseDTO,
  type VnpayIpnResponseDTO,
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

function extractClientIp(headers: HeaderBag, req?: Request): string | null {
  return (
    readSingleHeader(headers, 'x-client-ip') ??
    readSingleHeader(headers, 'x-forwarded-for') ??
    req?.ip ??
    req?.socket?.remoteAddress ??
    null
  );
}

@Controller('v1')
export class PaymentsController {
  constructor(private readonly paymentsService: PaymentsService) {}

  @Post('payments/intents')
  async createIntent(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
    @Req() req: Request,
  ): Promise<ApiResponse<RichPaymentIntentResponseDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const idempotencyKey = readSingleHeader(headers, 'idempotency-key');
    const clientIp = extractClientIp(headers, req);
    const data = await this.paymentsService.createPaymentIntent(
      body,
      idempotencyKey,
      clientIp,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/return')
  @HttpCode(HttpStatus.OK)
  async verifyPaymentReturn(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<PaymentReturnVerificationDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.paymentsService.handlePaymentReturn(
      query,
      correlationId,
      traceparent,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/vnpay/ipn')
  @HttpCode(HttpStatus.OK)
  async handleVnpayIpnGet(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<VnpayIpnResponseDTO> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    return this.paymentsService.handleVnpayIpn(query, correlationId, traceparent);
  }

  @Post('payments/vnpay/ipn')
  @HttpCode(HttpStatus.OK)
  async handleVnpayIpnPost(
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<VnpayIpnResponseDTO> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const bodyRec =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    return this.paymentsService.handleVnpayIpn(
      { ...query, ...bodyRec },
      correlationId,
      traceparent,
    );
  }

  @Post('payments/momo/ipn')
  @HttpCode(HttpStatus.OK)
  async handleMomoIpn(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<WebhookProcessResult & { resultCode: number; message: string }>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.paymentsService.handleMomoIpn(
      body,
      correlationId,
      traceparent,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('payments/payos/webhook')
  @HttpCode(HttpStatus.OK)
  async handlePayOsWebhook(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<WebhookProcessResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const data = await this.paymentsService.handlePayOsWebhook(
      body,
      correlationId,
      traceparent,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  async handlePaymentsWebhookGetAlias(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<VnpayIpnResponseDTO | ApiResponse<PaymentReturnVerificationDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    if (provider.trim().toLowerCase() === 'vnpay') {
      return this.paymentsService.handleVnpayIpn(query, correlationId, traceparent);
    }
    const data = await this.paymentsService.handlePaymentReturn(
      query,
      correlationId,
      traceparent,
    );
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('webhooks/payments/:provider')
  @HttpCode(HttpStatus.OK)
  async handleWebhook(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ApiResponse<WebhookProcessResult> | VnpayIpnResponseDTO> {
    return this.dispatchLegacyWebhook(provider, query, body, headers, req);
  }

  @Post('payments/webhooks/:provider')
  @HttpCode(HttpStatus.OK)
  async handlePaymentsWebhookAlias(
    @Param('provider') provider: string,
    @Query() query: Record<string, unknown>,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
    @Req() req: RawBodyRequest<Request>,
  ): Promise<ApiResponse<WebhookProcessResult> | VnpayIpnResponseDTO> {
    return this.dispatchLegacyWebhook(provider, query, body, headers, req);
  }

  private async dispatchLegacyWebhook(
    provider: string,
    query: Record<string, unknown>,
    body: unknown,
    headers: HeaderBag,
    req: RawBodyRequest<Request>,
  ): Promise<ApiResponse<WebhookProcessResult> | VnpayIpnResponseDTO> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const signature =
      readSingleHeader(headers, 'x-webhook-signature') ??
      readSingleHeader(headers, 'x-hub-signature-256') ??
      readSingleHeader(headers, 'x-vnp-signature');

    const normalized = provider.trim().toLowerCase();
    const bodyRec =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};

    // Auto-dispatch native provider webhook formats when no custom x-webhook-signature header is set
    if (!signature) {
      if (normalized === 'vnpay' && (query.vnp_SecureHash || bodyRec.vnp_SecureHash)) {
        return this.paymentsService.handleVnpayIpn(
          { ...query, ...bodyRec },
          correlationId,
          traceparent,
        );
      }
      if (normalized === 'momo' && bodyRec.partnerCode && bodyRec.signature) {
        const data = await this.paymentsService.handleMomoIpn(
          body,
          correlationId,
          traceparent,
        );
        return createApiResponse(data, { correlationId, service: SERVICE_NAME });
      }
      if (
        (normalized === 'payos' || normalized === 'vietqr') &&
        bodyRec.data &&
        typeof bodyRec.data === 'object' &&
        typeof bodyRec.signature === 'string'
      ) {
        const data = await this.paymentsService.handlePayOsWebhook(
          body,
          correlationId,
          traceparent,
        );
        return createApiResponse(data, { correlationId, service: SERVICE_NAME });
      }
    }

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
    @Req() req: Request,
  ): Promise<ApiResponse<RichRefundResponseDTO>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const idempotencyKey = readSingleHeader(headers, 'idempotency-key');
    const clientIp = extractClientIp(headers, req);
    const data = await this.paymentsService.createRefund(body, idempotencyKey, clientIp);
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

  @Get('payments/transactions')
  async listTransactions(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<AdminPaymentTransactionsListResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.paymentsService.listAdminTransactions(query);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('payments/webhooks')
  async listWebhooks(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<AdminPaymentWebhooksListResult>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.paymentsService.listWebhookLogs(query);
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
