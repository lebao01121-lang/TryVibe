import { randomUUID } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { z } from 'zod';
import {
  ErrorCode,
  PaymentProvider,
  PaymentTransactionStatus,
  RefundRequestDtoSchema,
  type PaymentIntentResponseDTO,
  type RefundResponseDTO,
} from '@atelier/contracts';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import { PaymentApiException } from '../common/payment-api.exception';
import {
  PAYMENT_CONFIG_TOKEN,
  SERVICE_NAME,
  type PaymentPromoConfig,
} from '../config/env';
import { PaymentDbService } from '../db/payment-db.service';
import { PaymentEventPublisherService } from '../messaging/payment-event-publisher.service';
import {
  buildMomoSandboxUrl,
  buildVietQrPayload,
  buildVietQrSvgDataUrl,
  buildVnpaySandboxUrl,
  computeHmacSha256Hex,
  normalizeWebhookProviderParam,
  verifyHmacSha256Signature,
} from './payment-helpers';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const ExtendedCreateIntentSchema = z.object({
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  provider: z.enum([
    PaymentProvider.VIETQR,
    PaymentProvider.VNPAY,
    PaymentProvider.MOMO,
    PaymentProvider.COD,
  ]),
  amountVnd: z.number().int().nonnegative(),
  expiresAt: z.string().optional(),
  returnUrl: z.string().url().optional(),
  customerEmail: z.string().email().nullable().optional(),
  idempotencyKey: z.string().min(1).max(128).optional(),
});

const FlexibleWebhookBodySchema = z.object({
  eventId: z.string().min(1).optional(),
  providerEventId: z.string().min(1).optional(),
  provider: z.string().optional(),
  orderId: z.string().min(1).optional(),
  orderCode: z.string().min(1).optional(),
  providerTransactionId: z.string().min(1).optional(),
  providerTxId: z.string().min(1).optional(),
  amountVnd: z.number().int().nonnegative(),
  status: z.enum(['SUCCEEDED', 'FAILED']).default('SUCCEEDED'),
  paidAt: z.string().optional(),
});

const FlexibleDevSimulateSchema = z.object({
  orderId: z.string().min(1).optional(),
  orderCode: z.string().min(1).optional(),
  provider: z.string().optional(),
  eventId: z.string().min(1).optional(),
  providerEventId: z.string().min(1).optional(),
  amountVnd: z.number().int().nonnegative().optional(),
  simulateLate: z.boolean().optional(),
});

interface PaymentTransactionRow {
  id: string;
  order_id: string;
  order_code: string;
  provider: PaymentProvider;
  tx_type: 'CHARGE' | 'REFUND';
  amount_vnd: string | number | bigint;
  status: PaymentTransactionStatus;
  provider_tx_id: string | null;
  idempotency_key: string;
  qr_payload: string | null;
  payment_url: string | null;
  signature_verified: boolean;
  raw_payload_jsonb: Record<string, unknown> | string | null;
  expires_at: Date | string | null;
  created_at: Date | string;
  paid_at: Date | string | null;
}

export interface PaymentTransactionView {
  id: string;
  orderId: string;
  orderCode: string;
  provider: PaymentProvider;
  txType: 'CHARGE' | 'REFUND';
  amountVnd: number;
  status: PaymentTransactionStatus;
  providerTxId: string | null;
  idempotencyKey: string;
  qrPayload: string | null;
  paymentUrl: string | null;
  signatureVerified: boolean;
  expiresAt: string | null;
  createdAt: string;
  paidAt: string | null;
}

export interface WebhookProcessResult {
  ok: true;
  deduplicated: boolean;
  processed: boolean;
  provider: 'VIETQR' | 'VNPAY' | 'MOMO';
  providerEventId: string;
  transactionId: string;
  orderId: string;
  orderCode: string;
  amountVnd: number;
  status: string;
  orderStatus?: string | null;
}

export interface DevSimulateWebhookResult extends WebhookProcessResult {
  simulated: true;
  signatureHeader: string;
}

export interface PaymentOpsMetrics {
  totalChargeTransactions: number;
  succeededCharges: number;
  refundedTransactions: number;
  totalPaidVnd: number;
  totalRefundedVnd: number;
  processedWebhooksCount: number;
  activePromotionsCount: number;
}

function toIso(value: Date | string | null | undefined): string {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    return value;
  }
  return new Date().toISOString();
}

function parseJsonRecord(
  raw: Record<string, unknown> | string | null | undefined,
): Record<string, unknown> | null {
  if (!raw) {
    return null;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return raw;
}

@Injectable()
export class PaymentsService {
  private readonly logger = createLogger(SERVICE_NAME);

  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
    private readonly db: PaymentDbService,
    private readonly eventPublisher: PaymentEventPublisherService,
  ) {}

  private mapTransactionToIntentDto(row: PaymentTransactionRow): PaymentIntentResponseDTO {
    const qrPayload = row.qr_payload ?? null;
    const rawMeta = parseJsonRecord(row.raw_payload_jsonb);
    let vietQrImageUrl =
      typeof rawMeta?.vietQrImageUrl === 'string' ? rawMeta.vietQrImageUrl : null;
    if (!vietQrImageUrl && row.provider === PaymentProvider.VIETQR && qrPayload) {
      vietQrImageUrl = buildVietQrSvgDataUrl(
        row.order_code,
        Number(row.amount_vnd),
        qrPayload,
      );
    }

    return {
      transactionId: row.id,
      orderId: row.order_id,
      orderCode: row.order_code,
      provider: row.provider,
      paymentUrl: row.payment_url ?? null,
      vietQrPayload: qrPayload,
      vietQrImageUrl,
      amountVnd: Number(row.amount_vnd),
      expiresAt: toIso(row.expires_at ?? new Date(Date.now() + 15 * 60 * 1000)),
    };
  }

  private mapTransactionView(row: PaymentTransactionRow): PaymentTransactionView {
    return {
      id: row.id,
      orderId: row.order_id,
      orderCode: row.order_code,
      provider: row.provider,
      txType: row.tx_type,
      amountVnd: Number(row.amount_vnd),
      status: row.status,
      providerTxId: row.provider_tx_id ?? null,
      idempotencyKey: row.idempotency_key,
      qrPayload: row.qr_payload ?? null,
      paymentUrl: row.payment_url ?? null,
      signatureVerified: Boolean(row.signature_verified),
      expiresAt: row.expires_at ? toIso(row.expires_at) : null,
      createdAt: toIso(row.created_at),
      paidAt: row.paid_at ? toIso(row.paid_at) : null,
    };
  }

  async createPaymentIntent(
    rawBody: unknown,
    idempotencyHeader: string | null,
  ): Promise<PaymentIntentResponseDTO> {
    const parsed = ExtendedCreateIntentSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu khởi tạo phiên thanh toán không hợp lệ. / Invalid payment intent payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!UUID_REGEX.test(input.orderId)) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'orderId phải là UUID hợp lệ. / orderId must be a valid UUID.',
      );
    }

    const idempotencyKey =
      input.idempotencyKey?.trim() || idempotencyHeader?.trim() || `pay-intent:${input.orderId}`;

    // Idempotent replay by idempotency_key
    const existingRes = await this.db.query<PaymentTransactionRow>(
      'SELECT * FROM payment_transactions WHERE idempotency_key = $1 LIMIT 1',
      [idempotencyKey],
    );
    if (existingRes.rows[0]) {
      return this.mapTransactionToIntentDto(existingRes.rows[0]);
    }

    const txId = randomUUID();
    const expiresAt = input.expiresAt ?? new Date(Date.now() + 15 * 60 * 1000).toISOString();
    const returnUrl =
      input.returnUrl ??
      `${this.config.storefrontPublicUrl}/don-hang/${encodeURIComponent(input.orderCode)}`;

    let qrPayload: string | null = null;
    let vietQrImageUrl: string | null = null;
    let paymentUrl: string | null = null;

    if (input.provider === PaymentProvider.VIETQR) {
      qrPayload = buildVietQrPayload(input.orderCode, input.amountVnd);
      vietQrImageUrl = buildVietQrSvgDataUrl(input.orderCode, input.amountVnd, qrPayload);
    } else if (input.provider === PaymentProvider.VNPAY) {
      paymentUrl = buildVnpaySandboxUrl(
        input.orderCode,
        input.amountVnd,
        returnUrl,
        this.config.webhookSecrets.VNPAY,
      );
    } else if (input.provider === PaymentProvider.MOMO) {
      paymentUrl = buildMomoSandboxUrl(
        input.orderCode,
        input.amountVnd,
        returnUrl,
        this.config.webhookSecrets.MOMO,
      );
    }

    const rawMeta = {
      returnUrl,
      customerEmail: input.customerEmail ?? null,
      ...(vietQrImageUrl ? { vietQrImageUrl } : {}),
    };

    const inserted = await this.db.query<PaymentTransactionRow>(
      `
      INSERT INTO payment_transactions (
        id, order_id, order_code, provider, tx_type, amount_vnd,
        status, idempotency_key, qr_payload, payment_url,
        signature_verified, raw_payload_jsonb, expires_at
      )
      VALUES ($1, $2, $3, $4, 'CHARGE', $5, 'PENDING', $6, $7, $8, FALSE, $9::jsonb, $10)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
      `,
      [
        txId,
        input.orderId,
        input.orderCode,
        input.provider,
        input.amountVnd,
        idempotencyKey,
        qrPayload,
        paymentUrl,
        JSON.stringify(rawMeta),
        expiresAt,
      ],
    );

    if (inserted.rows[0]) {
      return this.mapTransactionToIntentDto(inserted.rows[0]);
    }

    // Handle race condition on idempotency_key
    const replayRes = await this.db.query<PaymentTransactionRow>(
      'SELECT * FROM payment_transactions WHERE idempotency_key = $1 LIMIT 1',
      [idempotencyKey],
    );
    if (!replayRes.rows[0]) {
      throw new PaymentApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        ErrorCode.INTERNAL_ERROR,
        'Failed to create or reload payment intent transaction.',
      );
    }
    return this.mapTransactionToIntentDto(replayRes.rows[0]);
  }

  private async notifyOrderRmaPaymentSucceeded(
    payload: {
      eventId: string;
      orderId: string;
      orderCode: string;
      paymentId: string;
      provider: 'VIETQR' | 'VNPAY' | 'MOMO';
      providerTransactionId: string;
      amountVnd: number;
      paidAt: string;
    },
    correlationId: string,
    traceparent?: string,
  ): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(
        `${this.config.upstreams.orderRmaServiceUrl}/internal/events/payment-succeeded`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-internal-secret': this.config.internalServiceSecret,
            'X-Correlation-Id': correlationId,
            [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
          },
          body: JSON.stringify(payload),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        this.logger.warn(
          {
            status: response.status,
            orderCode: payload.orderCode,
            body: text.slice(0, 300),
            correlationId,
          },
          'order-rma payment-succeeded internal callback returned non-OK',
        );
        return null;
      }

      const json = (await response.json()) as {
        data?: { status?: string; orderStatus?: string };
        status?: string;
      };
      return json.data?.status ?? json.data?.orderStatus ?? json.status ?? null;
    } catch (error: unknown) {
      this.logger.warn(
        {
          orderCode: payload.orderCode,
          err: error instanceof Error ? error.message : String(error),
          correlationId,
        },
        'Non-fatal failure notifying order-rma of payment.succeeded',
      );
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async processPaymentWebhook(
    providerParam: string,
    rawBodyString: string,
    signatureHeader: string | null | undefined,
    bodyObj: unknown,
    correlationId: string,
    traceparent?: string,
  ): Promise<WebhookProcessResult> {
    const provider = normalizeWebhookProviderParam(providerParam);
    if (!provider) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        `Cổng thanh toán "${providerParam}" không được hỗ trợ cho webhook. / Unsupported webhook provider.`,
      );
    }

    // (a) Strict HMAC-SHA256 verification using crypto.timingSafeEqual
    const secret = this.config.webhookSecrets[provider];
    const signatureValid = verifyHmacSha256Signature(rawBodyString, signatureHeader, secret);
    if (!signatureValid) {
      throw new PaymentApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.PAYMENT_SIGNATURE_INVALID,
        'Chữ ký HMAC-SHA256 của webhook thanh toán không hợp lệ hoặc bị thiếu. / Invalid or missing webhook HMAC-SHA256 signature.',
        { provider },
      );
    }

    const parsed = FlexibleWebhookBodySchema.safeParse(bodyObj);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Nội dung webhook thanh toán không hợp lệ. / Invalid webhook payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    const providerEventId = (input.providerEventId ?? input.eventId ?? '').trim();
    if (!providerEventId) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu providerEventId / eventId trong webhook thanh toán. / Missing providerEventId.',
      );
    }

    if (!input.orderCode && !input.orderId) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu orderCode hoặc orderId trong webhook thanh toán. / Missing orderCode or orderId.',
      );
    }

    // (b) Match CHARGE transaction and strictly verify exact amountVnd
    const txRes = input.orderCode
      ? await this.db.query<PaymentTransactionRow>(
          `
          SELECT * FROM payment_transactions
          WHERE order_code = $1 AND tx_type = 'CHARGE'
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [input.orderCode],
        )
      : UUID_REGEX.test(input.orderId ?? '')
        ? await this.db.query<PaymentTransactionRow>(
            `
            SELECT * FROM payment_transactions
            WHERE order_id = $1 AND tx_type = 'CHARGE'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [input.orderId],
          )
        : { rows: [] as PaymentTransactionRow[] };

    const chargeTx = txRes.rows[0];
    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch thanh toán cho đơn hàng "${input.orderCode ?? input.orderId}". / Payment transaction not found.`,
      );
    }

    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (input.amountVnd !== expectedAmountVnd) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PAYMENT_AMOUNT_MISMATCH,
        `Số tiền thanh toán (${input.amountVnd.toLocaleString('vi-VN')}₫) không khớp số tiền đơn hàng (${expectedAmountVnd.toLocaleString('vi-VN')}₫). / Webhook amount mismatch.`,
        {
          orderCode: chargeTx.order_code,
          expectedAmountVnd,
          receivedAmountVnd: input.amountVnd,
        },
      );
    }

    const providerTxId = input.providerTransactionId ?? input.providerTxId ?? providerEventId;
    const paidAt = input.paidAt ?? new Date().toISOString();
    const nextTxStatus =
      input.status === 'FAILED'
        ? PaymentTransactionStatus.FAILED
        : PaymentTransactionStatus.SUCCEEDED;

    // (c) & (d) ACID Webhook Idempotency + State Commit inside one transaction
    const processed = await this.db.transaction(async (txDb) => {
      const dedupRes = await txDb.query<{ provider_event_id: string }>(
        `
        INSERT INTO processed_webhooks (provider, provider_event_id, order_code)
        VALUES ($1, $2, $3)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING provider_event_id
        `,
        [provider, providerEventId, chargeTx.order_code],
      );

      if (dedupRes.rows.length === 0) {
        return false;
      }

      const nextPaidAt =
        nextTxStatus === PaymentTransactionStatus.SUCCEEDED ? paidAt : null;

      await txDb.query(
        `
        UPDATE payment_transactions
        SET
          status = $2,
          signature_verified = TRUE,
          provider_tx_id = $3,
          raw_payload_jsonb = $4::jsonb,
          paid_at = COALESCE($5::timestamptz, paid_at)
        WHERE id = $1
        `,
        [
          chargeTx.id,
          nextTxStatus,
          providerTxId,
          JSON.stringify(bodyObj ?? {}),
          nextPaidAt,
        ],
      );

      if (nextTxStatus === PaymentTransactionStatus.SUCCEEDED) {
        await txDb.query(
          `
          UPDATE voucher_redemptions
          SET status = 'REDEEMED'
          WHERE order_id = $1 AND status = 'LOCKED'
          `,
          [chargeTx.order_id],
        );

        await txDb.query(
          `
          INSERT INTO outbox_events (id, event_name, payload_jsonb, published)
          VALUES ($1, 'payment.succeeded', $2::jsonb, FALSE)
          `,
          [
            randomUUID(),
            JSON.stringify({
              eventId: `${provider}:${providerEventId}`,
              paymentId: chargeTx.id,
              orderId: chargeTx.order_id,
              orderCode: chargeTx.order_code,
              provider,
              providerTransactionId: providerTxId,
              amountVnd: expectedAmountVnd,
              paidAt,
            }),
          ],
        );
      }

      return true;
    });

    if (!processed) {
      return {
        ok: true,
        deduplicated: true,
        processed: false,
        provider,
        providerEventId,
        transactionId: chargeTx.id,
        orderId: chargeTx.order_id,
        orderCode: chargeTx.order_code,
        amountVnd: expectedAmountVnd,
        status: chargeTx.status,
      };
    }

    let downstreamOrderStatus: string | null = null;
    if (nextTxStatus === PaymentTransactionStatus.SUCCEEDED) {
      const canonicalEventId = `${provider}:${providerEventId}`;
      downstreamOrderStatus = await this.notifyOrderRmaPaymentSucceeded(
        {
          eventId: canonicalEventId,
          orderId: chargeTx.order_id,
          orderCode: chargeTx.order_code,
          paymentId: chargeTx.id,
          provider,
          providerTransactionId: providerTxId,
          amountVnd: expectedAmountVnd,
          paidAt,
        },
        correlationId,
        traceparent,
      );

      if (downstreamOrderStatus === 'LATE_PAYMENT_NEEDS_REFUND') {
        await this.db.query(
          `
          UPDATE payment_transactions
          SET status = 'LATE_SUCCEEDED'
          WHERE id = $1
          `,
          [chargeTx.id],
        );
        await this.db.query(
          `
          INSERT INTO outbox_events (id, event_name, payload_jsonb, published)
          VALUES ($1, 'payment.late.detected', $2::jsonb, FALSE)
          `,
          [
            randomUUID(),
            JSON.stringify({
              paymentId: chargeTx.id,
              orderId: chargeTx.order_id,
              orderCode: chargeTx.order_code,
              provider,
              providerTransactionId: providerTxId,
              amountVnd: expectedAmountVnd,
              detectedAt: new Date().toISOString(),
              recommendedAction: 'AUTO_REFUND_REVIEW',
            }),
          ],
        );
        await this.eventPublisher.publishPaymentLateDetected(
          {
            paymentId: chargeTx.id,
            orderId: chargeTx.order_id,
            provider,
            providerTransactionId: providerTxId,
            amountVnd: expectedAmountVnd,
            detectedAt: new Date().toISOString(),
            recommendedAction: 'AUTO_REFUND_REVIEW',
          },
          correlationId,
        );
      } else {
        await this.eventPublisher.publishPaymentSucceeded(
          {
            paymentId: chargeTx.id,
            orderId: chargeTx.order_id,
            provider,
            providerTransactionId: providerTxId,
            amountVnd: expectedAmountVnd,
            paidAt,
          },
          correlationId,
          canonicalEventId,
        );
      }
    }

    return {
      ok: true,
      deduplicated: false,
      processed: true,
      provider,
      providerEventId,
      transactionId: chargeTx.id,
      orderId: chargeTx.order_id,
      orderCode: chargeTx.order_code,
      amountVnd: expectedAmountVnd,
      status:
        downstreamOrderStatus === 'LATE_PAYMENT_NEEDS_REFUND'
          ? PaymentTransactionStatus.LATE_SUCCEEDED
          : nextTxStatus,
      orderStatus: downstreamOrderStatus,
    };
  }

  async devSimulateWebhook(
    rawBody: unknown,
    correlationId: string,
    traceparent?: string,
  ): Promise<DevSimulateWebhookResult> {
    if (this.config.nodeEnv === 'production') {
      throw new PaymentApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Endpoint mô phỏng webhook bị vô hiệu hóa ở môi trường production. / Dev webhook simulator is disabled in production.',
      );
    }

    const parsed = FlexibleDevSimulateSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu mô phỏng webhook thanh toán không hợp lệ. / Invalid dev-simulate-webhook payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!input.orderCode && !input.orderId) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Cần cung cấp orderCode hoặc orderId để mô phỏng thanh toán. / Either orderCode or orderId is required.',
      );
    }

    const txRes = input.orderCode
      ? await this.db.query<PaymentTransactionRow>(
          `
          SELECT * FROM payment_transactions
          WHERE order_code = $1 AND tx_type = 'CHARGE'
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [input.orderCode],
        )
      : UUID_REGEX.test(input.orderId ?? '')
        ? await this.db.query<PaymentTransactionRow>(
            `
            SELECT * FROM payment_transactions
            WHERE order_id = $1 AND tx_type = 'CHARGE'
            ORDER BY created_at DESC
            LIMIT 1
            `,
            [input.orderId],
          )
        : { rows: [] as PaymentTransactionRow[] };

    const chargeTx = txRes.rows[0];
    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy phiên thanh toán cho đơn "${input.orderCode ?? input.orderId}". / Payment transaction not found.`,
      );
    }

    const resolvedProvider =
      normalizeWebhookProviderParam(input.provider ?? chargeTx.provider) ?? PaymentProvider.VIETQR;
    const providerEventId =
      input.providerEventId?.trim() ||
      input.eventId?.trim() ||
      `sim-${chargeTx.order_code}-${randomUUID().slice(0, 8)}`;

    const canonicalPayload = {
      eventId: providerEventId,
      providerEventId,
      provider: resolvedProvider,
      orderId: chargeTx.order_id,
      orderCode: chargeTx.order_code,
      providerTransactionId: `TX-${providerEventId}`,
      amountVnd: input.amountVnd ?? Number(chargeTx.amount_vnd),
      status: 'SUCCEEDED' as const,
      paidAt: new Date().toISOString(),
    };

    const rawJson = JSON.stringify(canonicalPayload);
    const secret = this.config.webhookSecrets[resolvedProvider];
    const signature = computeHmacSha256Hex(rawJson, secret);

    const result = await this.processPaymentWebhook(
      resolvedProvider,
      rawJson,
      signature,
      canonicalPayload,
      correlationId,
      traceparent,
    );

    return {
      ...result,
      simulated: true,
      signatureHeader: signature,
    };
  }

  async createRefund(
    rawBody: unknown,
    idempotencyHeader: string | null,
  ): Promise<RefundResponseDTO> {
    const parsed = RefundRequestDtoSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu yêu cầu hoàn tiền không hợp lệ. / Invalid refund request payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!UUID_REGEX.test(input.orderId)) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'orderId phải là UUID hợp lệ. / orderId must be a valid UUID.',
      );
    }

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      idempotencyHeader?.trim() ||
      `refund:${input.orderId}:${input.rmaId ?? 'order'}:${input.amountVnd}`;

    // Idempotent replay
    const existingRefundRes = await this.db.query<PaymentTransactionRow>(
      `
      SELECT * FROM payment_transactions
      WHERE idempotency_key = $1 AND tx_type = 'REFUND'
      LIMIT 1
      `,
      [idempotencyKey],
    );
    const existingRefund = existingRefundRes.rows[0];
    if (existingRefund) {
      const rawMeta = parseJsonRecord(existingRefund.raw_payload_jsonb);
      return {
        refundId: existingRefund.id,
        orderId: existingRefund.order_id,
        orderCode: existingRefund.order_code,
        rmaId: typeof rawMeta?.rmaId === 'string' ? rawMeta.rmaId : (input.rmaId ?? null),
        amountVnd: Number(existingRefund.amount_vnd),
        status: 'COMPLETED',
        provider: existingRefund.provider,
        idempotentReplay: true,
        refundedAt: toIso(existingRefund.paid_at ?? existingRefund.created_at),
      };
    }

    const chargeRes = await this.db.query<PaymentTransactionRow>(
      `
      SELECT * FROM payment_transactions
      WHERE (order_id = $1 OR order_code = $2) AND tx_type = 'CHARGE'
      ORDER BY created_at DESC
      LIMIT 1
      `,
      [input.orderId, input.orderCode],
    );
    const originalCharge = chargeRes.rows[0];
    if (!originalCharge) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch gốc cho đơn "${input.orderCode}". / Original charge transaction not found.`,
      );
    }

    const originalAmountVnd = Number(originalCharge.amount_vnd);
    const refundedSumRes = await this.db.query<{ refunded_total: string | number | bigint }>(
      `
      SELECT COALESCE(SUM(amount_vnd), 0) AS refunded_total
      FROM payment_transactions
      WHERE order_id = $1 AND tx_type = 'REFUND' AND status = 'SUCCEEDED'
      `,
      [originalCharge.order_id],
    );
    const alreadyRefundedVnd = Number(refundedSumRes.rows[0]?.refunded_total ?? 0);

    if (input.amountVnd > originalAmountVnd || alreadyRefundedVnd + input.amountVnd > originalAmountVnd) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        `Số tiền hoàn (${input.amountVnd.toLocaleString('vi-VN')}₫) vượt quá số dư có thể hoàn (${Math.max(0, originalAmountVnd - alreadyRefundedVnd).toLocaleString('vi-VN')}₫). / Refund exceeds refundable charge balance.`,
        {
          originalAmountVnd,
          alreadyRefundedVnd,
          requestedRefundVnd: input.amountVnd,
        },
      );
    }

    const refundId = randomUUID();
    const refundedAt = new Date().toISOString();
    const isFullRefund = alreadyRefundedVnd + input.amountVnd >= originalAmountVnd;

    await this.db.transaction(async (txDb) => {
      await txDb.query(
        `
        INSERT INTO payment_transactions (
          id, order_id, order_code, provider, tx_type, amount_vnd,
          status, provider_tx_id, idempotency_key, signature_verified,
          raw_payload_jsonb, paid_at
        )
        VALUES ($1, $2, $3, $4, 'REFUND', $5, 'SUCCEEDED', $6, $7, TRUE, $8::jsonb, $9)
        `,
        [
          refundId,
          originalCharge.order_id,
          originalCharge.order_code,
          originalCharge.provider,
          input.amountVnd,
          `REF-${refundId.slice(0, 8).toUpperCase()}`,
          idempotencyKey,
          JSON.stringify({
            reason: input.reason,
            rmaId: input.rmaId ?? null,
            originalChargeId: originalCharge.id,
            fullRefund: isFullRefund,
          }),
          refundedAt,
        ],
      );

      if (isFullRefund) {
        await txDb.query(
          `
          UPDATE payment_transactions
          SET status = 'REFUNDED'
          WHERE id = $1
          `,
          [originalCharge.id],
        );
      }
    });

    return {
      refundId,
      orderId: originalCharge.order_id,
      orderCode: originalCharge.order_code,
      rmaId: input.rmaId ?? null,
      amountVnd: input.amountVnd,
      status: 'COMPLETED',
      provider: originalCharge.provider,
      idempotentReplay: false,
      refundedAt,
    };
  }

  async getTransactionsByOrderCode(orderCodeOrId: string): Promise<PaymentTransactionView[]> {
    const trimmed = orderCodeOrId.trim();
    const res = UUID_REGEX.test(trimmed)
      ? await this.db.query<PaymentTransactionRow>(
          `
          SELECT * FROM payment_transactions
          WHERE order_id = $1
          ORDER BY created_at DESC
          `,
          [trimmed],
        )
      : await this.db.query<PaymentTransactionRow>(
          `
          SELECT * FROM payment_transactions
          WHERE order_code = $1
          ORDER BY created_at DESC
          `,
          [trimmed],
        );

    return res.rows.map((row: PaymentTransactionRow) => this.mapTransactionView(row));
  }

  async getOpsMetrics(): Promise<PaymentOpsMetrics> {
    const [txSummaryRes, webhooksRes, activePromosRes] = await Promise.all([
      this.db.query<{
        total_charge_transactions: string | number;
        succeeded_charges: string | number;
        refunded_transactions: string | number;
        total_paid_vnd: string | number | bigint;
        total_refunded_vnd: string | number | bigint;
      }>(
        `
        SELECT
          COUNT(*) FILTER (WHERE tx_type = 'CHARGE')::int AS total_charge_transactions,
          COUNT(*) FILTER (
            WHERE tx_type = 'CHARGE' AND status IN ('SUCCEEDED', 'LATE_SUCCEEDED', 'REFUNDED')
          )::int AS succeeded_charges,
          COUNT(*) FILTER (
            WHERE tx_type = 'REFUND' AND status = 'SUCCEEDED'
          )::int AS refunded_transactions,
          COALESCE(
            SUM(amount_vnd) FILTER (
              WHERE tx_type = 'CHARGE' AND status IN ('SUCCEEDED', 'LATE_SUCCEEDED', 'REFUNDED')
            ),
            0
          ) AS total_paid_vnd,
          COALESCE(
            SUM(amount_vnd) FILTER (
              WHERE tx_type = 'REFUND' AND status = 'SUCCEEDED'
            ),
            0
          ) AS total_refunded_vnd
        FROM payment_transactions
        `,
      ),
      this.db.query<{ cnt: string | number }>(
        'SELECT COUNT(*)::int AS cnt FROM processed_webhooks',
      ),
      this.db.query<{ cnt: string | number }>(
        "SELECT COUNT(*)::int AS cnt FROM promotions WHERE status = 'ACTIVE'",
      ),
    ]);

    const summary = txSummaryRes.rows[0];
    return {
      totalChargeTransactions: Number(summary?.total_charge_transactions ?? 0),
      succeededCharges: Number(summary?.succeeded_charges ?? 0),
      refundedTransactions: Number(summary?.refunded_transactions ?? 0),
      totalPaidVnd: Number(summary?.total_paid_vnd ?? 0),
      totalRefundedVnd: Number(summary?.total_refunded_vnd ?? 0),
      processedWebhooksCount: Number(webhooksRes.rows[0]?.cnt ?? 0),
      activePromotionsCount: Number(activePromosRes.rows[0]?.cnt ?? 0),
    };
  }
}
