import { randomUUID } from 'node:crypto';
import {
  HttpStatus,
  Inject,
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { z } from 'zod';
import {
  AdminPaymentTransactionsQuerySchema,
  AdminPaymentWebhooksQuerySchema,
  ErrorCode,
  PaymentProvider,
  PaymentTransactionStatus,
  SePayWebhookPayloadSchema,
  type PagePagination,
  type PaymentBankInfoDTO,
  type PaymentIntentResponseDTO,
  type PaymentRefundRecordDTO,
  type PaymentTransactionAdminDTO,
  type PaymentWebhookLogDTO,
  type RefundResponseDTO,
  type SePayConfigStatusDTO,
  type SePayOrderStatusDTO,
  type SePaySyncResultDTO,
  type SePayWebhookPayloadDTO,
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
  normalizeClientIp,
  toSingleQueryValue,
  type PaymentProviderMode,
  type ProviderRefundResult,
} from './adapters/adapter-types';
import { MomoAdapter } from './adapters/momo.adapter';
import { PayOsAdapter } from './adapters/payos.adapter';
import {
  SePayAdapter,
  buildSePayTransferContent,
  extractOrderCodeCandidatesFromSePay,
  maskAccountNumber,
  normalizeCompactOrderCode,
  resolveSePayBankMeta,
  type SePayHeaderBag,
} from './adapters/sepay.adapter';
import { VnpayAdapter } from './adapters/vnpay.adapter';
import {
  buildRawVietQrSvgDataUrl,
  buildVietQrSvgDataUrl,
  computeHmacSha256Hex,
  normalizeWebhookProviderParam,
  verifyHmacSha256Signature,
  VIETQR_STANDARD,
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
  clientIp: z.string().max(64).optional(),
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

const SimulateSePayWebhookSchema = z.object({
  orderId: z.string().min(1).optional(),
  orderCode: z.string().min(1).optional(),
  amountVnd: z.coerce.number().int().positive().optional(),
  gateway: z.string().trim().min(1).optional(),
  transferType: z.enum(['in', 'out']).optional(),
  content: z.string().trim().min(1).optional(),
  referenceCode: z.string().trim().min(1).optional(),
  id: z.union([z.number().int(), z.string().min(1)]).optional(),
});

const FlexibleRefundRequestSchema = z
  .object({
    transactionId: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
    orderCode: z.string().trim().min(1).optional(),
    amountVnd: z.coerce.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
    rmaId: z.string().min(1).nullable().optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.transactionId || v.orderId || v.orderCode), {
    message: 'Cần cung cấp transactionId, orderId hoặc orderCode để hoàn tiền.',
  });

export interface RichPaymentIntentResponseDTO extends PaymentIntentResponseDTO {
  qrPayload: string | null;
  qrImageUrl: string | null;
  qrSvgDataUrl: string | null;
  rawQrSvgDataUrl: string | null;
  rawQrPngDataUrl: string | null;
  qrStandard: typeof VIETQR_STANDARD | null;
  sepayQrImageUrl: string | null;
  transferContent: string | null;
  vietqrProvider?: 'SEPAY' | 'PAYOS' | 'LOCAL';
  providerMode: PaymentProviderMode;
  bankInfo?: PaymentBankInfoDTO | null;
}

export type SePayWebhookResponseDTO =
  | (WebhookProcessResult & {
      success: true;
      matched: true;
      overpaidVnd?: number;
    })
  | {
      success: true;
      ok: true;
      ignored?: boolean;
      matched?: boolean;
      processed: false;
      reason?: string;
      status?: string;
      orderCode?: string;
      expectedAmountVnd?: number;
      receivedAmountVnd?: number;
    };

export type SimulateSePayWebhookResult = SePayWebhookResponseDTO & {
  simulated: true;
  sepayPayload: SePayWebhookPayloadDTO;
};

export interface PaymentReturnVerificationDTO {
  verified: boolean;
  paid: boolean;
  status: string;
  orderCode: string | null;
  provider: 'VIETQR' | 'VNPAY' | 'MOMO' | null;
  amountVnd: number | null;
  message: string;
  responseCode: string | null;
  transactionId: string | null;
  orderStatus: string | null;
}

export interface VnpayIpnResponseDTO {
  RspCode: string;
  Message: string;
}

interface ProcessedWebhookRow {
  provider: PaymentProvider;
  provider_event_id: string;
  order_code: string | null;
  signature_valid: boolean | null;
  signature_header: string | null;
  status: string | null;
  payload_summary: string | null;
  raw_payload_jsonb: Record<string, unknown> | string | null;
  received_at: Date | string;
  tx_status?: string | null;
  tx_raw_payload_jsonb?: Record<string, unknown> | string | null;
}

export interface AdminPaymentTransactionsListResult {
  items: PaymentTransactionAdminDTO[];
  pagination: PagePagination;
  summary: {
    totalCount: number;
    totalChargedVnd: number;
    totalRefundedVnd: number;
    totalNetVnd: number;
  };
}

export interface AdminPaymentWebhooksListResult {
  items: PaymentWebhookLogDTO[];
  pagination: PagePagination;
}

export interface RichRefundResponseDTO extends RefundResponseDTO {
  refundTxId: string;
  refundedAmountVnd: number;
  netRefundableVnd: number;
  providerMode?: PaymentProviderMode;
  providerRefundId?: string | null;
  before: {
    status: PaymentTransactionStatus;
    refundedAmountVnd: number;
    netRefundableVnd: number;
  };
  after: {
    status: PaymentTransactionStatus;
    refundedAmountVnd: number;
    netRefundableVnd: number;
  };
}

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
      const parsed = JSON.parse(raw) as unknown;
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : null;
    } catch {
      return null;
    }
  }
  return raw;
}

function maskSignature(signature: string | null | undefined): string | null {
  if (!signature || signature.trim().length === 0) {
    return null;
  }
  const s = signature.trim();
  if (s.length <= 18) {
    return `${s.slice(0, 6)}...`;
  }
  return `${s.slice(0, 12)}...${s.slice(-6)}`;
}

function describeVnpayResponseCode(code: string): string {
  switch (code) {
    case '00':
      return 'Giao dịch VNPay đã được xác thực thành công.';
    case '24':
      return 'Bạn đã hủy giao dịch thanh toán trên cổng VNPay.';
    case '11':
      return 'Phiên thanh toán VNPay đã hết hạn chờ thanh toán.';
    case '51':
      return 'Tài khoản không đủ số dư để thực hiện giao dịch VNPay.';
    case '65':
      return 'Tài khoản đã vượt quá hạn mức giao dịch trong ngày.';
    case '75':
      return 'Ngân hàng thanh toán đang bảo trì.';
    case '97':
      return 'Chữ ký xác thực VNPay (HMAC-SHA512) không hợp lệ.';
    default:
      return `Giao dịch VNPay chưa thành công (mã phản hồi ${code || 'UNKNOWN'}).`;
  }
}

function describeMomoResultCode(code: string, fallbackMsg?: string): string {
  if (code === '0') {
    return 'Giao dịch ví MoMo đã được xác thực thành công.';
  }
  if (code === '1006') {
    return 'Bạn đã từ chối hoặc hủy xác nhận thanh toán trên ví MoMo.';
  }
  if (code === '1005') {
    return 'Phiên thanh toán MoMo đã hết hạn.';
  }
  if (code === '1001') {
    return 'Tài khoản ví MoMo không đủ số dư để thanh toán.';
  }
  if (fallbackMsg && fallbackMsg.trim()) {
    return fallbackMsg.trim();
  }
  return `Giao dịch MoMo chưa thành công (mã kết quả ${code || 'UNKNOWN'}).`;
}

function parseSePayTransactionDate(raw: string | null | undefined): string {
  if (!raw || raw.trim().length === 0) {
    return new Date().toISOString();
  }
  const trimmed = raw.trim();
  const normalized = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}$/.test(trimmed)
    ? `${trimmed.replace(' ', 'T')}+07:00`
    : trimmed;
  const parsed = new Date(normalized);
  return Number.isNaN(parsed.getTime()) ? new Date().toISOString() : parsed.toISOString();
}

function normalizeAccountForCompare(raw: string | null | undefined): string {
  return (raw ?? '').trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

@Injectable()
export class PaymentsService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private sepayPollTimer: ReturnType<typeof setInterval> | null = null;
  private sepaySyncInFlight = false;
  private lastSePayPollAt: string | null = null;
  private lastSePayPollError: string | null = null;

  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
    private readonly db: PaymentDbService,
    private readonly eventPublisher: PaymentEventPublisherService,
    private readonly payosAdapter: PayOsAdapter,
    private readonly vnpayAdapter: VnpayAdapter,
    private readonly momoAdapter: MomoAdapter,
    private readonly sepayAdapter: SePayAdapter,
  ) {}

  onModuleInit(): void {
    if (
      this.sepayAdapter.apiTokenConfigured &&
      this.config.sepay.autoPollEnabled &&
      this.config.nodeEnv !== 'test'
    ) {
      const intervalMs = this.config.sepay.pollIntervalMs;
      this.logger.info(
        { intervalMs, bankCode: this.config.sepay.bankCode },
        'SePay background auto-poller enabled for pending VIETQR transactions',
      );
      this.sepayPollTimer = setInterval(() => {
        void this.runScheduledSePayPoll();
      }, intervalMs);
      this.sepayPollTimer.unref?.();
    }
  }

  onModuleDestroy(): void {
    if (this.sepayPollTimer) {
      clearInterval(this.sepayPollTimer);
      this.sepayPollTimer = null;
    }
  }

  private async runScheduledSePayPoll(): Promise<void> {
    if (this.sepaySyncInFlight || !this.sepayAdapter.apiTokenConfigured) {
      return;
    }
    try {
      const countRes = await this.db.query<{ cnt: string | number }>(
        `
        SELECT COUNT(*)::int AS cnt FROM payment_transactions
        WHERE provider = 'VIETQR' AND tx_type = 'CHARGE' AND status = 'PENDING'
          AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '2 hours')
        `,
      );
      const pendingCount = Number(countRes.rows[0]?.cnt ?? 0);
      if (pendingCount <= 0) {
        return;
      }
      await this.syncPendingSePayTransactions(`sepay-poll-${Date.now()}`);
    } catch (error: unknown) {
      this.lastSePayPollError =
        error instanceof Error ? error.message : String(error);
      this.logger.warn(
        { err: this.lastSePayPollError },
        'SePay scheduled background poll failed',
      );
    }
  }

  private resolveActiveVietQrProvider(): 'SEPAY' | 'PAYOS' {
    if (this.config.vietqrProvider === 'payos') {
      return 'PAYOS';
    }
    if (
      this.config.vietqrProvider === 'auto' &&
      this.payosAdapter.isLiveConfigured &&
      !this.sepayAdapter.isLiveConfigured
    ) {
      return 'PAYOS';
    }
    return 'SEPAY';
  }

  private mapTransactionToIntentDto(
    row: PaymentTransactionRow,
  ): RichPaymentIntentResponseDTO {
    const qrPayload = row.qr_payload ?? null;
    const rawMeta = parseJsonRecord(row.raw_payload_jsonb);

    let qrSvgDataUrl =
      typeof rawMeta?.qrSvgDataUrl === 'string'
        ? rawMeta.qrSvgDataUrl
        : typeof rawMeta?.vietQrImageUrl === 'string'
          ? rawMeta.vietQrImageUrl
          : null;
    let rawQrSvgDataUrl =
      typeof rawMeta?.rawQrSvgDataUrl === 'string' ? rawMeta.rawQrSvgDataUrl : null;
    const rawQrPngDataUrl =
      typeof rawMeta?.rawQrPngDataUrl === 'string' ? rawMeta.rawQrPngDataUrl : null;
    const sepayQrImageUrl =
      typeof rawMeta?.sepayQrImageUrl === 'string' ? rawMeta.sepayQrImageUrl : null;
    const transferContent =
      typeof rawMeta?.transferContent === 'string'
        ? rawMeta.transferContent
        : row.provider === PaymentProvider.VIETQR
          ? buildSePayTransferContent(row.order_code, this.config.sepay.orderPrefix)
          : null;

    if (row.provider === PaymentProvider.VIETQR && qrPayload) {
      if (!qrSvgDataUrl) {
        qrSvgDataUrl = buildVietQrSvgDataUrl(
          row.order_code,
          Number(row.amount_vnd),
          qrPayload,
        );
      }
      if (!rawQrSvgDataUrl) {
        rawQrSvgDataUrl = buildRawVietQrSvgDataUrl(qrPayload);
      }
    }

    const providerMode: PaymentProviderMode =
      rawMeta?.providerMode === 'LIVE' ? 'LIVE' : 'SANDBOX_LOCAL';
    const vietqrProvider: 'SEPAY' | 'PAYOS' | 'LOCAL' | undefined =
      rawMeta?.vietqrProvider === 'SEPAY' ||
      rawMeta?.vietqrProvider === 'PAYOS' ||
      rawMeta?.vietqrProvider === 'LOCAL'
        ? rawMeta.vietqrProvider
        : row.provider === PaymentProvider.VIETQR
          ? sepayQrImageUrl
            ? 'SEPAY'
            : 'LOCAL'
          : undefined;
    const qrStandard =
      rawMeta?.qrStandard === VIETQR_STANDARD ||
      (row.provider === PaymentProvider.VIETQR && Boolean(qrPayload))
        ? VIETQR_STANDARD
        : null;

    const bankInfoRaw =
      rawMeta?.bankInfo && typeof rawMeta.bankInfo === 'object'
        ? (rawMeta.bankInfo as Record<string, unknown>)
        : null;
    let bankInfo: PaymentBankInfoDTO | null = null;
    if (
      bankInfoRaw &&
      typeof bankInfoRaw.bankBin === 'string' &&
      typeof bankInfoRaw.accountNo === 'string' &&
      typeof bankInfoRaw.accountName === 'string'
    ) {
      const resolvedMeta = resolveSePayBankMeta(
        typeof bankInfoRaw.bankCode === 'string' ? bankInfoRaw.bankCode : undefined,
        bankInfoRaw.bankBin,
      );
      bankInfo = {
        bankBin: bankInfoRaw.bankBin,
        bankCode:
          typeof bankInfoRaw.bankCode === 'string'
            ? bankInfoRaw.bankCode
            : resolvedMeta.bankCode,
        bankName:
          typeof bankInfoRaw.bankName === 'string'
            ? bankInfoRaw.bankName
            : resolvedMeta.bankName,
        accountNo: bankInfoRaw.accountNo,
        accountName: bankInfoRaw.accountName,
      };
    } else if (row.provider === PaymentProvider.VIETQR) {
      bankInfo = {
        bankBin: this.config.sepay.bankBin,
        bankCode: this.config.sepay.bankCode,
        bankName: this.config.sepay.bankName,
        accountNo: this.config.sepay.accountNo,
        accountName: this.config.sepay.accountName,
      };
    }

    return {
      transactionId: row.id,
      orderId: row.order_id,
      orderCode: row.order_code,
      provider: row.provider,
      paymentUrl: row.payment_url ?? null,
      vietQrPayload: qrPayload,
      vietQrImageUrl: qrSvgDataUrl,
      sepayQrImageUrl,
      transferContent,
      ...(vietqrProvider ? { vietqrProvider } : {}),
      qrPayload,
      qrImageUrl: qrSvgDataUrl,
      qrSvgDataUrl,
      rawQrSvgDataUrl,
      rawQrPngDataUrl,
      qrStandard,
      providerMode,
      bankInfo,
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
    clientIp?: string | null,
  ): Promise<RichPaymentIntentResponseDTO> {
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
    const defaultStorefrontReturnUrl = `${this.config.storefrontPublicUrl}/thanh-toan/ket-qua`;
    const resolvedIp = normalizeClientIp(input.clientIp ?? clientIp);

    let qrPayload: string | null = null;
    let qrSvgDataUrl: string | null = null;
    let rawQrSvgDataUrl: string | null = null;
    let rawQrPngDataUrl: string | null = null;
    let qrStandard: typeof VIETQR_STANDARD | null = null;
    let paymentUrl: string | null = null;
    let providerTxId: string | null = null;
    let providerMode: PaymentProviderMode = 'SANDBOX_LOCAL';
    let returnUrl = input.returnUrl ?? defaultStorefrontReturnUrl;
    const providerMeta: Record<string, unknown> = {};

    if (input.provider === PaymentProvider.VIETQR) {
      const activeVietQrProvider = this.resolveActiveVietQrProvider();
      if (activeVietQrProvider === 'SEPAY') {
        returnUrl =
          input.returnUrl ??
          `${defaultStorefrontReturnUrl}?provider=VIETQR&orderCode=${encodeURIComponent(input.orderCode)}`;
        const sepayResult = await this.sepayAdapter.createPaymentIntent({
          orderCode: input.orderCode,
          amountVnd: input.amountVnd,
          expiresAt,
        });
        qrPayload = sepayResult.qrPayload;
        qrSvgDataUrl = sepayResult.qrSvgDataUrl;
        rawQrSvgDataUrl = sepayResult.rawQrSvgDataUrl;
        rawQrPngDataUrl = sepayResult.rawQrPngDataUrl;
        qrStandard = sepayResult.qrStandard;
        paymentUrl = sepayResult.paymentUrl;
        providerTxId = sepayResult.providerTxId;
        providerMode = sepayResult.mode;
        providerMeta.vietqrProvider = 'SEPAY';
        providerMeta.sepayQrImageUrl = sepayResult.sepayQrImageUrl;
        providerMeta.transferContent = sepayResult.transferContent;
        providerMeta.compactOrderCode = sepayResult.compactOrderCode;
        providerMeta.bankInfo = sepayResult.bankInfo;
        providerMeta.qrModuleCount = sepayResult.qrModuleCount;
        providerMeta.qrQuietZoneModules = sepayResult.qrQuietZoneModules;
      } else {
        returnUrl =
          input.returnUrl ??
          `${defaultStorefrontReturnUrl}?provider=PAYOS&orderCode=${encodeURIComponent(input.orderCode)}`;
        const payosResult = await this.payosAdapter.createPaymentIntent({
          orderCode: input.orderCode,
          amountVnd: input.amountVnd,
          returnUrl,
          expiresAt,
        });
        const bankMeta = resolveSePayBankMeta(undefined, payosResult.bankInfo.bankBin);
        qrPayload = payosResult.qrPayload;
        qrSvgDataUrl = payosResult.qrSvgDataUrl;
        rawQrSvgDataUrl = payosResult.rawQrSvgDataUrl;
        rawQrPngDataUrl = payosResult.rawQrPngDataUrl;
        qrStandard = payosResult.qrStandard;
        paymentUrl = payosResult.paymentUrl;
        providerTxId = payosResult.providerTxId;
        providerMode = payosResult.mode;
        providerMeta.vietqrProvider = 'PAYOS';
        providerMeta.transferContent = buildSePayTransferContent(
          input.orderCode,
          this.config.sepay.orderPrefix,
        );
        providerMeta.compactOrderCode = normalizeCompactOrderCode(input.orderCode);
        providerMeta.payosOrderCode = payosResult.payosOrderCode;
        providerMeta.checkoutUrl = payosResult.checkoutUrl;
        providerMeta.bankInfo = {
          ...payosResult.bankInfo,
          bankCode: bankMeta.bankCode,
          bankName: bankMeta.bankName,
        };
        providerMeta.qrModuleCount = payosResult.qrModuleCount;
        providerMeta.qrQuietZoneModules = payosResult.qrQuietZoneModules;
      }
    } else if (input.provider === PaymentProvider.VNPAY) {
      returnUrl = input.returnUrl ?? this.config.vnpay.returnUrl;
      const vnpayResult = this.vnpayAdapter.createPayment({
        orderCode: input.orderCode,
        amountVnd: input.amountVnd,
        returnUrl,
        clientIp: resolvedIp,
        expiresAt,
      });
      paymentUrl = vnpayResult.paymentUrl;
      providerMode = vnpayResult.mode;
      providerMeta.vnpCreateDate = vnpayResult.createDate;
      providerMeta.vnpExpireDate = vnpayResult.expireDate;
      providerMeta.vnpTmnCode = this.config.vnpay.tmnCode;
      providerMeta.clientIp = resolvedIp;
    } else if (input.provider === PaymentProvider.MOMO) {
      returnUrl = input.returnUrl ?? this.config.momo.redirectUrl;
      const momoResult = await this.momoAdapter.createPayment({
        orderCode: input.orderCode,
        amountVnd: input.amountVnd,
        redirectUrl: returnUrl,
      });
      paymentUrl = momoResult.paymentUrl;
      qrPayload = momoResult.qrPayload;
      providerMode = momoResult.mode;
      providerMeta.momoRequestId = momoResult.requestId;
      providerMeta.momoPartnerCode = this.config.momo.partnerCode;
    } else {
      returnUrl =
        input.returnUrl ??
        `${this.config.storefrontPublicUrl}/don-hang/${encodeURIComponent(input.orderCode)}`;
      providerMode = 'SANDBOX_LOCAL';
    }

    const rawMeta: Record<string, unknown> = {
      returnUrl,
      customerEmail: input.customerEmail ?? null,
      providerMode,
      ...(qrStandard ? { qrStandard } : {}),
      ...(qrSvgDataUrl ? { vietQrImageUrl: qrSvgDataUrl, qrSvgDataUrl } : {}),
      ...(rawQrSvgDataUrl ? { rawQrSvgDataUrl } : {}),
      ...(rawQrPngDataUrl ? { rawQrPngDataUrl } : {}),
      ...providerMeta,
    };

    const inserted = await this.db.query<PaymentTransactionRow>(
      `
      INSERT INTO payment_transactions (
        id, order_id, order_code, provider, tx_type, amount_vnd,
        status, provider_tx_id, idempotency_key, qr_payload, payment_url,
        signature_verified, raw_payload_jsonb, expires_at
      )
      VALUES ($1, $2, $3, $4, 'CHARGE', $5, 'PENDING', $6, $7, $8, $9, FALSE, $10::jsonb, $11)
      ON CONFLICT (idempotency_key) DO NOTHING
      RETURNING *
      `,
      [
        txId,
        input.orderId,
        input.orderCode,
        input.provider,
        input.amountVnd,
        providerTxId,
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

  private async logInvalidSignatureWebhook(params: {
    provider: 'VIETQR' | 'VNPAY' | 'MOMO';
    orderCode: string | null;
    eventIdHint: string;
    signatureHeader: string | null;
    summary: string;
    rawPayload: Record<string, unknown>;
  }): Promise<void> {
    const failedEventId = `invalid:${randomUUID().slice(0, 8)}:${params.eventIdHint.slice(0, 80)}`;
    await this.db
      .query(
        `
        INSERT INTO processed_webhooks (
          provider, provider_event_id, order_code, signature_valid,
          signature_header, status, payload_summary, raw_payload_jsonb
        )
        VALUES ($1, $2, $3, FALSE, $4, 'SIGNATURE_INVALID', $5, $6::jsonb)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        `,
        [
          params.provider,
          failedEventId,
          params.orderCode ? params.orderCode.slice(0, 32) : null,
          maskSignature(params.signatureHeader),
          params.summary,
          JSON.stringify(params.rawPayload),
        ],
      )
      .catch(() => undefined);
  }

  private async findChargeTransaction(lookup: {
    orderCode?: string | null;
    compactOrderCode?: string | null;
    orderId?: string | null;
    payosOrderCode?: string | null;
    providerTxId?: string | null;
  }): Promise<PaymentTransactionRow | null> {
    if (lookup.orderCode && lookup.orderCode.trim()) {
      const res = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE order_code = $1 AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [lookup.orderCode.trim()],
      );
      if (res.rows[0]) {
        return res.rows[0];
      }
    }

    if (lookup.compactOrderCode && lookup.compactOrderCode.trim()) {
      const compact = normalizeCompactOrderCode(lookup.compactOrderCode);
      if (compact.length >= 4) {
        const res = await this.db.query<PaymentTransactionRow>(
          `
          SELECT * FROM payment_transactions
          WHERE (
            REPLACE(UPPER(order_code), '-', '') = $1
            OR UPPER(COALESCE(raw_payload_jsonb->>'compactOrderCode', '')) = $1
          )
          AND tx_type = 'CHARGE'
          ORDER BY created_at DESC
          LIMIT 1
          `,
          [compact],
        );
        if (res.rows[0]) {
          return res.rows[0];
        }
      }
    }

    if (lookup.orderId && UUID_REGEX.test(lookup.orderId.trim())) {
      const res = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE order_id = $1 AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [lookup.orderId.trim()],
      );
      if (res.rows[0]) {
        return res.rows[0];
      }
    }

    if (lookup.payosOrderCode && lookup.payosOrderCode.trim()) {
      const res = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE raw_payload_jsonb->>'payosOrderCode' = $1 AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [lookup.payosOrderCode.trim()],
      );
      if (res.rows[0]) {
        return res.rows[0];
      }
    }

    if (lookup.providerTxId && lookup.providerTxId.trim()) {
      const res = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE provider_tx_id = $1 AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [lookup.providerTxId.trim()],
      );
      if (res.rows[0]) {
        return res.rows[0];
      }
    }

    return null;
  }

  private async settleVerifiedProviderCallback(params: {
    provider: 'VIETQR' | 'VNPAY' | 'MOMO';
    providerEventId: string;
    chargeTx: PaymentTransactionRow;
    providerTxId: string;
    amountVnd: number;
    nextTxStatus: PaymentTransactionStatus;
    paidAt: string;
    signatureHeader: string | null;
    rawPayloadObj: Record<string, unknown>;
    correlationId: string;
    traceparent?: string;
  }): Promise<WebhookProcessResult> {
    const {
      provider,
      providerEventId,
      chargeTx,
      providerTxId,
      amountVnd,
      nextTxStatus,
      paidAt,
      signatureHeader,
      rawPayloadObj,
      correlationId,
      traceparent,
    } = params;

    const alreadySettled =
      chargeTx.status === PaymentTransactionStatus.SUCCEEDED ||
      chargeTx.status === PaymentTransactionStatus.LATE_SUCCEEDED ||
      chargeTx.status === PaymentTransactionStatus.REFUNDED;

    const payloadSummary = `${provider} ${nextTxStatus} · ${chargeTx.order_code} · ${amountVnd.toLocaleString('vi-VN')}₫`;

    // ACID Webhook Idempotency + State Commit inside one transaction
    const txOutcome = await this.db.transaction(async (txDb) => {
      const dedupRes = await txDb.query<{ provider_event_id: string }>(
        `
        INSERT INTO processed_webhooks (
          provider, provider_event_id, order_code, signature_valid,
          signature_header, status, payload_summary, raw_payload_jsonb
        )
        VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7::jsonb)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        RETURNING provider_event_id
        `,
        [
          provider,
          providerEventId,
          chargeTx.order_code,
          maskSignature(signatureHeader),
          nextTxStatus,
          payloadSummary,
          JSON.stringify(rawPayloadObj),
        ],
      );

      if (dedupRes.rows.length === 0) {
        return { processed: false, shouldNotify: false };
      }

      if (alreadySettled && nextTxStatus === PaymentTransactionStatus.SUCCEEDED) {
        return { processed: false, shouldNotify: false };
      }

      const nextPaidAt =
        nextTxStatus === PaymentTransactionStatus.SUCCEEDED ? paidAt : null;

      await txDb.query(
        `
        UPDATE payment_transactions
        SET
          status = $2,
          signature_verified = TRUE,
          provider_tx_id = COALESCE($3, provider_tx_id),
          raw_payload_jsonb = COALESCE(raw_payload_jsonb, '{}'::jsonb) || $4::jsonb,
          paid_at = COALESCE($5::timestamptz, paid_at)
        WHERE id = $1
        `,
        [
          chargeTx.id,
          nextTxStatus,
          providerTxId,
          JSON.stringify({
            ...rawPayloadObj,
            lastCallbackReceivedAt: new Date().toISOString(),
          }),
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
              amountVnd,
              paidAt,
            }),
          ],
        );
      }

      return {
        processed: true,
        shouldNotify: nextTxStatus === PaymentTransactionStatus.SUCCEEDED,
      };
    });

    if (!txOutcome.processed) {
      return {
        ok: true,
        deduplicated: true,
        processed: false,
        provider,
        providerEventId,
        transactionId: chargeTx.id,
        orderId: chargeTx.order_id,
        orderCode: chargeTx.order_code,
        amountVnd,
        status: chargeTx.status,
      };
    }

    let downstreamOrderStatus: string | null = null;
    if (txOutcome.shouldNotify) {
      const canonicalEventId = `${provider}:${providerEventId}`;
      downstreamOrderStatus = await this.notifyOrderRmaPaymentSucceeded(
        {
          eventId: canonicalEventId,
          orderId: chargeTx.order_id,
          orderCode: chargeTx.order_code,
          paymentId: chargeTx.id,
          provider,
          providerTransactionId: providerTxId,
          amountVnd,
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
              amountVnd,
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
            amountVnd,
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
            amountVnd,
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
      amountVnd,
      status:
        downstreamOrderStatus === 'LATE_PAYMENT_NEEDS_REFUND'
          ? PaymentTransactionStatus.LATE_SUCCEEDED
          : nextTxStatus,
      orderStatus: downstreamOrderStatus,
    };
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
      const rawObj =
        bodyObj && typeof bodyObj === 'object' && !Array.isArray(bodyObj)
          ? (bodyObj as Record<string, unknown>)
          : {};
      const failedOrderCode =
        typeof rawObj.orderCode === 'string' && rawObj.orderCode.trim()
          ? rawObj.orderCode.trim()
          : null;
      await this.logInvalidSignatureWebhook({
        provider,
        orderCode: failedOrderCode,
        eventIdHint: String(rawObj.providerEventId ?? rawObj.eventId ?? 'unknown'),
        signatureHeader: signatureHeader ?? null,
        summary: `HMAC-SHA256 verification failed for ${provider}${failedOrderCode ? ` (${failedOrderCode})` : ''}`,
        rawPayload: rawObj,
      });

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

    const chargeTx = await this.findChargeTransaction({
      orderCode: input.orderCode,
      orderId: input.orderId,
    });
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

    const rawObj =
      bodyObj && typeof bodyObj === 'object' && !Array.isArray(bodyObj)
        ? (bodyObj as Record<string, unknown>)
        : {};

    return this.settleVerifiedProviderCallback({
      provider,
      providerEventId,
      chargeTx,
      providerTxId,
      amountVnd: expectedAmountVnd,
      nextTxStatus,
      paidAt,
      signatureHeader: signatureHeader ?? null,
      rawPayloadObj: rawObj,
      correlationId,
      traceparent,
    });
  }

  /**
   * Official VNPay v2.1.0 IPN handler (GET or POST).
   * Returns VNPay canonical `{ RspCode, Message }` response codes (`00`, `01`, `02`, `04`, `97`).
   */
  async handleVnpayIpn(
    rawParams: Record<string, unknown>,
    correlationId: string,
    traceparent?: string,
  ): Promise<VnpayIpnResponseDTO> {
    const orderCode = toSingleQueryValue(rawParams.vnp_TxnRef).trim();
    const secureHash = toSingleQueryValue(rawParams.vnp_SecureHash).trim();

    if (!this.vnpayAdapter.verifySignature(rawParams)) {
      await this.logInvalidSignatureWebhook({
        provider: PaymentProvider.VNPAY,
        orderCode: orderCode || null,
        eventIdHint: toSingleQueryValue(rawParams.vnp_TransactionNo) || orderCode || 'vnpay-ipn',
        signatureHeader: secureHash || null,
        summary: `VNPay IPN HMAC-SHA512 checksum invalid${orderCode ? ` (${orderCode})` : ''}`,
        rawPayload: rawParams,
      });
      return { RspCode: '97', Message: 'Invalid Checksum' };
    }

    if (!orderCode) {
      return { RspCode: '01', Message: 'Order not Found' };
    }

    const chargeTx = await this.findChargeTransaction({ orderCode });
    if (!chargeTx) {
      return { RspCode: '01', Message: 'Order not Found' };
    }

    const rawVnpAmount = Number(toSingleQueryValue(rawParams.vnp_Amount));
    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (
      !Number.isFinite(rawVnpAmount) ||
      Math.round(rawVnpAmount) !== expectedAmountVnd * 100
    ) {
      return { RspCode: '04', Message: 'Invalid amount' };
    }

    if (
      chargeTx.status === PaymentTransactionStatus.SUCCEEDED ||
      chargeTx.status === PaymentTransactionStatus.LATE_SUCCEEDED ||
      chargeTx.status === PaymentTransactionStatus.REFUNDED
    ) {
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    const responseCode = toSingleQueryValue(rawParams.vnp_ResponseCode).trim();
    const transactionStatus = toSingleQueryValue(rawParams.vnp_TransactionStatus).trim();
    const transactionNo = toSingleQueryValue(rawParams.vnp_TransactionNo).trim();
    const payDate = toSingleQueryValue(rawParams.vnp_PayDate).trim();

    const isPaid =
      responseCode === '00' &&
      (transactionStatus === '' || transactionStatus === '00');
    const providerEventId = transactionNo
      ? `vnpay:${transactionNo}`
      : `vnpay:${orderCode}:${payDate || responseCode || 'ipn'}`;

    const result = await this.settleVerifiedProviderCallback({
      provider: PaymentProvider.VNPAY,
      providerEventId,
      chargeTx,
      providerTxId: transactionNo || providerEventId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: isPaid
        ? PaymentTransactionStatus.SUCCEEDED
        : PaymentTransactionStatus.FAILED,
      paidAt: new Date().toISOString(),
      signatureHeader: secureHash || null,
      rawPayloadObj: {
        ...rawParams,
        vnp_PayDate: payDate || undefined,
      },
      correlationId,
      traceparent,
    });

    if (result.deduplicated) {
      return { RspCode: '02', Message: 'Order already confirmed' };
    }

    return { RspCode: '00', Message: 'Confirm Success' };
  }

  /**
   * Official MoMo v2 IPN webhook handler (HMAC-SHA256 verified + deduplicated).
   */
  async handleMomoIpn(
    rawBody: unknown,
    correlationId: string,
    traceparent?: string,
  ): Promise<WebhookProcessResult & { resultCode: number; message: string }> {
    const bodyRec =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : {};
    const orderCode = toSingleQueryValue(bodyRec.orderId).trim();
    const signature = toSingleQueryValue(bodyRec.signature).trim();

    if (!this.momoAdapter.verifyIpnSignature(bodyRec)) {
      await this.logInvalidSignatureWebhook({
        provider: PaymentProvider.MOMO,
        orderCode: orderCode || null,
        eventIdHint:
          toSingleQueryValue(bodyRec.transId) ||
          toSingleQueryValue(bodyRec.requestId) ||
          orderCode ||
          'momo-ipn',
        signatureHeader: signature || null,
        summary: `MoMo IPN HMAC-SHA256 signature invalid${orderCode ? ` (${orderCode})` : ''}`,
        rawPayload: bodyRec,
      });
      throw new PaymentApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.PAYMENT_SIGNATURE_INVALID,
        'Chữ ký HMAC-SHA256 của MoMo IPN không hợp lệ. / Invalid MoMo IPN HMAC-SHA256 signature.',
        { provider: PaymentProvider.MOMO },
      );
    }

    if (!orderCode) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu orderId trong MoMo IPN. / Missing orderId in MoMo IPN.',
      );
    }

    const chargeTx = await this.findChargeTransaction({ orderCode });
    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch MoMo cho đơn hàng "${orderCode}". / Payment transaction not found.`,
      );
    }

    const receivedAmountVnd = Math.round(Number(toSingleQueryValue(bodyRec.amount)));
    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (!Number.isFinite(receivedAmountVnd) || receivedAmountVnd !== expectedAmountVnd) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PAYMENT_AMOUNT_MISMATCH,
        `Số tiền MoMo IPN (${receivedAmountVnd.toLocaleString('vi-VN')}₫) không khớp đơn hàng (${expectedAmountVnd.toLocaleString('vi-VN')}₫). / MoMo IPN amount mismatch.`,
        {
          orderCode: chargeTx.order_code,
          expectedAmountVnd,
          receivedAmountVnd,
        },
      );
    }

    const resultCode = Number(toSingleQueryValue(bodyRec.resultCode));
    const transId = toSingleQueryValue(bodyRec.transId).trim();
    const requestId = toSingleQueryValue(bodyRec.requestId).trim();
    const isPaid = resultCode === 0;
    const providerEventId = transId
      ? `momo:${transId}`
      : `momo:${requestId || orderCode}`;

    const result = await this.settleVerifiedProviderCallback({
      provider: PaymentProvider.MOMO,
      providerEventId,
      chargeTx,
      providerTxId: transId || providerEventId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: isPaid
        ? PaymentTransactionStatus.SUCCEEDED
        : PaymentTransactionStatus.FAILED,
      paidAt: new Date().toISOString(),
      signatureHeader: signature || null,
      rawPayloadObj: {
        ...bodyRec,
        momoTransId: transId || undefined,
      },
      correlationId,
      traceparent,
    });

    return {
      ...result,
      resultCode: 0,
      message: 'Success',
    };
  }

  /**
   * Official PayOS v2 Webhook handler (HMAC-SHA256 verified over sorted `data` fields).
   */
  async handlePayOsWebhook(
    rawBody: unknown,
    correlationId: string,
    traceparent?: string,
  ): Promise<WebhookProcessResult> {
    const bodyRec =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : {};
    const dataRec =
      bodyRec.data && typeof bodyRec.data === 'object' && !Array.isArray(bodyRec.data)
        ? (bodyRec.data as Record<string, unknown>)
        : null;

    const rawPayosOrderCode = dataRec ? toSingleQueryValue(dataRec.orderCode).trim() : '';
    const signature = toSingleQueryValue(bodyRec.signature).trim();

    if (!dataRec || !this.payosAdapter.verifyWebhookSignature(bodyRec)) {
      await this.logInvalidSignatureWebhook({
        provider: PaymentProvider.VIETQR,
        orderCode: rawPayosOrderCode || null,
        eventIdHint:
          (dataRec && toSingleQueryValue(dataRec.reference)) ||
          rawPayosOrderCode ||
          'payos-webhook',
        signatureHeader: signature || null,
        summary: `PayOS webhook HMAC-SHA256 signature invalid${rawPayosOrderCode ? ` (${rawPayosOrderCode})` : ''}`,
        rawPayload: bodyRec,
      });
      throw new PaymentApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.PAYMENT_SIGNATURE_INVALID,
        'Chữ ký HMAC-SHA256 của webhook PayOS không hợp lệ. / Invalid PayOS webhook HMAC-SHA256 signature.',
        { provider: PaymentProvider.VIETQR },
      );
    }

    const description = toSingleQueryValue(dataRec.description).trim();
    const descMatch = /(?:TRYVIBE|TAMXUAN)\s+([A-Za-z0-9_-]+)/i.exec(description);
    const paymentLinkId = toSingleQueryValue(dataRec.paymentLinkId).trim();

    const chargeTx = await this.findChargeTransaction({
      orderCode: rawPayosOrderCode || descMatch?.[1] || null,
      payosOrderCode: rawPayosOrderCode || null,
      providerTxId: paymentLinkId || null,
    });

    if (!chargeTx && descMatch?.[1]) {
      // Fallback search by extracted description order code
      const descTx = await this.findChargeTransaction({ orderCode: descMatch[1] });
      if (descTx) {
        return this.finalizePayOsWebhook(
          descTx,
          bodyRec,
          dataRec,
          signature,
          correlationId,
          traceparent,
        );
      }
    }

    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch VietQR/PayOS cho mã "${rawPayosOrderCode || paymentLinkId}". / Payment transaction not found.`,
      );
    }

    return this.finalizePayOsWebhook(
      chargeTx,
      bodyRec,
      dataRec,
      signature,
      correlationId,
      traceparent,
    );
  }

  private async finalizePayOsWebhook(
    chargeTx: PaymentTransactionRow,
    bodyRec: Record<string, unknown>,
    dataRec: Record<string, unknown>,
    signature: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<WebhookProcessResult> {
    const receivedAmountVnd = Math.round(Number(toSingleQueryValue(dataRec.amount)));
    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (!Number.isFinite(receivedAmountVnd) || receivedAmountVnd !== expectedAmountVnd) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PAYMENT_AMOUNT_MISMATCH,
        `Số tiền PayOS (${receivedAmountVnd.toLocaleString('vi-VN')}₫) không khớp đơn hàng (${expectedAmountVnd.toLocaleString('vi-VN')}₫). / PayOS webhook amount mismatch.`,
        {
          orderCode: chargeTx.order_code,
          expectedAmountVnd,
          receivedAmountVnd,
        },
      );
    }

    const reference = toSingleQueryValue(dataRec.reference).trim();
    const paymentLinkId = toSingleQueryValue(dataRec.paymentLinkId).trim();
    const payosCode = toSingleQueryValue(bodyRec.code || '00').trim();
    const dataCode = toSingleQueryValue(dataRec.code || '00').trim();
    const isPaid =
      payosCode === '00' && dataCode === '00' && bodyRec.success !== false;

    const providerEventId = `payos:${reference || paymentLinkId || toSingleQueryValue(dataRec.orderCode)}`;

    return this.settleVerifiedProviderCallback({
      provider: PaymentProvider.VIETQR,
      providerEventId,
      chargeTx,
      providerTxId: reference || paymentLinkId || providerEventId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: isPaid
        ? PaymentTransactionStatus.SUCCEEDED
        : PaymentTransactionStatus.FAILED,
      paidAt: new Date().toISOString(),
      signatureHeader: signature || null,
      rawPayloadObj: bodyRec,
      correlationId,
      traceparent,
    });
  }

  private async logSePayAmountMismatchWebhook(params: {
    sepayTxId: string;
    orderCode: string;
    expectedAmountVnd: number;
    receivedAmountVnd: number;
    signatureHeader: string | null;
    rawPayload: Record<string, unknown>;
  }): Promise<void> {
    const providerEventId = `sepay:mismatch:${params.sepayTxId}`;
    const summary = `SePay AMOUNT_MISMATCH · ${params.orderCode} · nhận ${params.receivedAmountVnd.toLocaleString('vi-VN')}₫ / yêu cầu ${params.expectedAmountVnd.toLocaleString('vi-VN')}₫`;
    await this.db
      .query(
        `
        INSERT INTO processed_webhooks (
          provider, provider_event_id, order_code, signature_valid,
          signature_header, status, payload_summary, raw_payload_jsonb
        )
        VALUES ($1, $2, $3, TRUE, $4, $5, $6, $7::jsonb)
        ON CONFLICT (provider, provider_event_id) DO NOTHING
        `,
        [
          PaymentProvider.VIETQR,
          providerEventId,
          params.orderCode.slice(0, 32),
          maskSignature(params.signatureHeader),
          'AMOUNT_MISMATCH',
          summary,
          JSON.stringify({
            ...params.rawPayload,
            expectedAmountVnd: params.expectedAmountVnd,
            receivedAmountVnd: params.receivedAmountVnd,
          }),
        ],
      )
      .catch(() => undefined);
  }

  /**
   * Official SePay Webhook handler (`Authorization: Apikey <SEPAY_WEBHOOK_API_KEY>`).
   * Matches Vietnamese bank transfers (both hyphenated and hyphen-stripped order codes),
   * guards underpayment, deduplicates atomically, and settles orders automatically.
   */
  async handleSePayWebhook(
    rawBody: unknown,
    headers: SePayHeaderBag,
    correlationId: string,
    traceparent?: string,
  ): Promise<SePayWebhookResponseDTO> {
    const rawObj =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : {};

    const auth = this.sepayAdapter.verifyWebhookAuth(headers);
    if (!auth.valid) {
      const candidateHint =
        extractOrderCodeCandidatesFromSePay(
          {
            code: typeof rawObj.code === 'string' ? rawObj.code : null,
            content: typeof rawObj.content === 'string' ? rawObj.content : null,
            description:
              typeof rawObj.description === 'string' ? rawObj.description : null,
          },
          this.config.sepay.orderPrefix,
        )[0] ?? null;

      await this.logInvalidSignatureWebhook({
        provider: PaymentProvider.VIETQR,
        orderCode: candidateHint,
        eventIdHint: String(rawObj.id ?? rawObj.referenceCode ?? 'sepay-webhook'),
        signatureHeader: auth.providedHeader,
        summary: `SePay API Key verification failed${candidateHint ? ` (${candidateHint})` : ''}`,
        rawPayload: rawObj,
      });

      throw new PaymentApiException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.PAYMENT_SIGNATURE_INVALID,
        'API Key xác thực webhook SePay không hợp lệ hoặc bị thiếu. / Invalid or missing SePay webhook API Key.',
        { provider: PaymentProvider.VIETQR },
      );
    }

    const parsed = SePayWebhookPayloadSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Nội dung webhook SePay không hợp lệ. / Invalid SePay webhook payload.',
        { issues: parsed.error.issues },
      );
    }

    const payload = parsed.data;

    if (payload.transferType !== 'in') {
      return {
        success: true,
        ok: true,
        ignored: true,
        processed: false,
        reason: 'OUTGOING_TRANSFER',
      };
    }

    if (this.sepayAdapter.isLiveConfigured) {
      const configuredAcc = normalizeAccountForCompare(this.config.sepay.accountNo);
      const payloadAcc = normalizeAccountForCompare(payload.accountNumber);
      const payloadSubAcc = normalizeAccountForCompare(payload.subAccount);
      if (
        configuredAcc &&
        payloadAcc &&
        payloadAcc !== configuredAcc &&
        payloadSubAcc !== configuredAcc
      ) {
        return {
          success: true,
          ok: true,
          ignored: true,
          processed: false,
          reason: 'ACCOUNT_MISMATCH',
        };
      }
    }

    const candidates = extractOrderCodeCandidatesFromSePay(
      payload,
      this.config.sepay.orderPrefix,
    );

    let chargeTx: PaymentTransactionRow | null = null;
    for (const candidate of candidates) {
      chargeTx = await this.findChargeTransaction({
        orderCode: candidate,
        compactOrderCode: candidate,
      });
      if (chargeTx) {
        break;
      }
    }

    if (!chargeTx) {
      return {
        success: true,
        ok: true,
        matched: false,
        processed: false,
        reason: 'ORDER_NOT_FOUND',
      };
    }

    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    const receivedAmountVnd = Math.round(payload.transferAmount);

    if (receivedAmountVnd < expectedAmountVnd) {
      await this.logSePayAmountMismatchWebhook({
        sepayTxId: String(payload.id),
        orderCode: chargeTx.order_code,
        expectedAmountVnd,
        receivedAmountVnd,
        signatureHeader: auth.providedHeader,
        rawPayload: payload as unknown as Record<string, unknown>,
      });

      return {
        success: true,
        ok: true,
        matched: true,
        processed: false,
        status: 'AMOUNT_MISMATCH',
        expectedAmountVnd,
        receivedAmountVnd,
        orderCode: chargeTx.order_code,
      };
    }

    const overpaidVnd = Math.max(0, receivedAmountVnd - expectedAmountVnd);
    const providerEventId = `sepay:${String(payload.id)}`;
    const providerTxId = payload.referenceCode?.trim() || `SEPAY-${String(payload.id)}`;
    const paidAt = parseSePayTransactionDate(payload.transactionDate);

    const settled = await this.settleVerifiedProviderCallback({
      provider: PaymentProvider.VIETQR,
      providerEventId,
      chargeTx,
      providerTxId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: PaymentTransactionStatus.SUCCEEDED,
      paidAt,
      signatureHeader: auth.providedHeader,
      rawPayloadObj: {
        ...payload,
        sepayMatchedBy: 'webhook',
        receivedAmountVnd,
        ...(overpaidVnd > 0 ? { overpaidVnd } : {}),
      },
      correlationId,
      traceparent,
    });

    return {
      ...settled,
      success: true,
      matched: true,
      ...(overpaidVnd > 0 ? { overpaidVnd } : {}),
    };
  }

  /**
   * Synchronizes all pending VIETQR charge transactions against SePay User API
   * (`GET /transactions/list` or `/v2/transactions`). Safe to call from both
   * background auto-poller and manual admin trigger.
   */
  async syncPendingSePayTransactions(
    correlationId: string,
    traceparent?: string,
  ): Promise<SePaySyncResultDTO> {
    const mode: PaymentProviderMode = this.sepayAdapter.isLiveConfigured
      ? 'LIVE'
      : 'SANDBOX_LOCAL';

    if (this.sepaySyncInFlight) {
      return {
        ok: true,
        mode,
        checkedPendingCount: 0,
        fetchedTransactionsCount: 0,
        settledOrderCodes: [],
        skippedReason: 'SYNC_IN_PROGRESS',
        syncedAt: new Date().toISOString(),
      };
    }

    this.sepaySyncInFlight = true;
    try {
      const syncedAt = new Date().toISOString();
      const pendingRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE provider = 'VIETQR' AND tx_type = 'CHARGE' AND status = 'PENDING'
          AND (expires_at IS NULL OR expires_at > NOW() - INTERVAL '2 hours')
        ORDER BY created_at DESC
        LIMIT 100
        `,
      );
      const pendingRows = pendingRes.rows;

      if (!this.sepayAdapter.apiTokenConfigured) {
        this.lastSePayPollAt = syncedAt;
        this.lastSePayPollError = null;
        return {
          ok: true,
          mode,
          checkedPendingCount: pendingRows.length,
          fetchedTransactionsCount: 0,
          settledOrderCodes: [],
          skippedReason: 'SEPAY_API_TOKEN_NOT_CONFIGURED',
          syncedAt,
        };
      }

      if (pendingRows.length === 0) {
        this.lastSePayPollAt = syncedAt;
        this.lastSePayPollError = null;
        return {
          ok: true,
          mode,
          checkedPendingCount: 0,
          fetchedTransactionsCount: 0,
          settledOrderCodes: [],
          skippedReason: 'NO_PENDING_VIETQR_ORDERS',
          syncedAt,
        };
      }

      const fetchResult = await this.sepayAdapter.fetchRecentIncomingTransactions({
        limit: 50,
      });

      if (!fetchResult.ok) {
        this.lastSePayPollAt = syncedAt;
        this.lastSePayPollError = fetchResult.error ?? `SePay API HTTP ${fetchResult.status}`;
        return {
          ok: false,
          mode,
          checkedPendingCount: pendingRows.length,
          fetchedTransactionsCount: 0,
          settledOrderCodes: [],
          skippedReason: this.lastSePayPollError,
          syncedAt,
        };
      }

      const pendingByKey = new Map<string, PaymentTransactionRow>();
      for (const row of pendingRows) {
        const upperCode = row.order_code.trim().toUpperCase();
        const compactCode = normalizeCompactOrderCode(row.order_code);
        pendingByKey.set(upperCode, row);
        if (compactCode) {
          pendingByKey.set(compactCode, row);
        }
        const rawMeta = parseJsonRecord(row.raw_payload_jsonb);
        if (typeof rawMeta?.compactOrderCode === 'string' && rawMeta.compactOrderCode.trim()) {
          pendingByKey.set(rawMeta.compactOrderCode.trim().toUpperCase(), row);
        }
      }

      const settledOrderCodes: string[] = [];
      const settledTxIds = new Set<string>();

      for (const tx of fetchResult.transactions) {
        const candidates = extractOrderCodeCandidatesFromSePay(
          tx,
          this.config.sepay.orderPrefix,
        );
        let matchedRow: PaymentTransactionRow | null = null;
        for (const candidate of candidates) {
          const found = pendingByKey.get(candidate.toUpperCase());
          if (found && !settledTxIds.has(found.id)) {
            matchedRow = found;
            break;
          }
        }
        if (!matchedRow) {
          continue;
        }

        const expectedAmountVnd = Number(matchedRow.amount_vnd);
        const receivedAmountVnd = Math.round(tx.transferAmount);

        if (receivedAmountVnd < expectedAmountVnd) {
          await this.logSePayAmountMismatchWebhook({
            sepayTxId: tx.id,
            orderCode: matchedRow.order_code,
            expectedAmountVnd,
            receivedAmountVnd,
            signatureHeader: 'sepay-api-poll',
            rawPayload: tx.raw,
          });
          continue;
        }

        const overpaidVnd = Math.max(0, receivedAmountVnd - expectedAmountVnd);
        const providerEventId = `sepay:${tx.id}`;
        const providerTxId = tx.referenceCode?.trim() || `SEPAY-${tx.id}`;
        const paidAt = parseSePayTransactionDate(tx.transactionDate);

        const settled = await this.settleVerifiedProviderCallback({
          provider: PaymentProvider.VIETQR,
          providerEventId,
          chargeTx: matchedRow,
          providerTxId,
          amountVnd: expectedAmountVnd,
          nextTxStatus: PaymentTransactionStatus.SUCCEEDED,
          paidAt,
          signatureHeader: 'sepay-api-poll',
          rawPayloadObj: {
            ...tx.raw,
            sepayMatchedBy: 'api_poll',
            receivedAmountVnd,
            ...(overpaidVnd > 0 ? { overpaidVnd } : {}),
          },
          correlationId,
          traceparent,
        });

        settledTxIds.add(matchedRow.id);
        if (settled.processed) {
          settledOrderCodes.push(matchedRow.order_code);
        }
      }

      this.lastSePayPollAt = syncedAt;
      this.lastSePayPollError = null;

      return {
        ok: true,
        mode,
        checkedPendingCount: pendingRows.length,
        fetchedTransactionsCount: fetchResult.transactions.length,
        settledOrderCodes,
        skippedReason: null,
        syncedAt,
      };
    } finally {
      this.sepaySyncInFlight = false;
    }
  }

  /**
   * Checks SePay payment status for a single order. When still PENDING and
   * `SEPAY_API_TOKEN` is configured, performs an immediate on-demand SePay sync.
   */
  async checkSePayOrderStatus(
    orderCode: string,
    correlationId: string,
    traceparent?: string,
  ): Promise<SePayOrderStatusDTO> {
    const trimmed = orderCode.trim();
    let chargeTx = await this.findChargeTransaction({
      orderCode: trimmed,
      compactOrderCode: trimmed,
    });

    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch thanh toán cho đơn hàng "${trimmed}". / Payment transaction not found.`,
      );
    }

    const extractMetaInfo = (row: PaymentTransactionRow) => {
      const rawMeta = parseJsonRecord(row.raw_payload_jsonb);
      const providerMode: PaymentProviderMode =
        rawMeta?.providerMode === 'LIVE'
          ? 'LIVE'
          : this.sepayAdapter.isLiveConfigured
            ? 'LIVE'
            : 'SANDBOX_LOCAL';
      const vietqrProvider: 'SEPAY' | 'PAYOS' | 'LOCAL' =
        rawMeta?.vietqrProvider === 'SEPAY' ||
        rawMeta?.vietqrProvider === 'PAYOS' ||
        rawMeta?.vietqrProvider === 'LOCAL'
          ? rawMeta.vietqrProvider
          : this.resolveActiveVietQrProvider();
      return { providerMode, vietqrProvider };
    };

    const isSettledStatus = (status: PaymentTransactionStatus): boolean =>
      status === PaymentTransactionStatus.SUCCEEDED ||
      status === PaymentTransactionStatus.LATE_SUCCEEDED ||
      status === PaymentTransactionStatus.REFUNDED;

    let sepaySyncedNow = false;
    if (
      chargeTx.status === PaymentTransactionStatus.PENDING &&
      chargeTx.provider === PaymentProvider.VIETQR &&
      this.sepayAdapter.apiTokenConfigured
    ) {
      await this.syncPendingSePayTransactions(correlationId, traceparent);
      sepaySyncedNow = true;
      const refreshed = await this.findChargeTransaction({
        orderCode: chargeTx.order_code,
      });
      if (refreshed) {
        chargeTx = refreshed;
      }
    }

    const { providerMode, vietqrProvider } = extractMetaInfo(chargeTx);
    const paid = isSettledStatus(chargeTx.status);

    const message = paid
      ? sepaySyncedNow
        ? 'SePay đã đối soát thành công giao dịch chuyển khoản của bạn!'
        : 'Giao dịch VietQR · SePay đã được xác nhận thanh toán thành công.'
      : chargeTx.status === PaymentTransactionStatus.PENDING
        ? sepaySyncedNow
          ? 'Chưa ghi nhận giao dịch chuyển khoản khớp mã đơn trên SePay. Vui lòng đợi 5–15 giây sau khi chuyển khoản và thử lại.'
          : 'Đang chờ SePay xác nhận giao dịch chuyển khoản ngân hàng.'
        : `Trạng thái giao dịch hiện tại: ${chargeTx.status}.`;

    return {
      orderCode: chargeTx.order_code,
      paid,
      status: chargeTx.status,
      amountVnd: Number(chargeTx.amount_vnd),
      provider: chargeTx.provider,
      providerMode,
      vietqrProvider,
      sepaySyncedNow,
      providerTxId: chargeTx.provider_tx_id ?? null,
      paidAt: chargeTx.paid_at ? toIso(chargeTx.paid_at) : null,
      orderStatus: null,
      message,
    };
  }

  /**
   * Returns current SePay integration configuration and operational health
   * for the Admin Payment Ledger SePay panel.
   */
  async getSePayConfigStatus(): Promise<SePayConfigStatusDTO> {
    const countRes = await this.db.query<{ cnt: string | number }>(
      `
      SELECT COUNT(*)::int AS cnt FROM payment_transactions
      WHERE provider = 'VIETQR' AND tx_type = 'CHARGE' AND status = 'PENDING'
      `,
    );
    const pendingVietQrCount = Number(countRes.rows[0]?.cnt ?? 0);
    const activeVietQrProvider = this.resolveActiveVietQrProvider();

    return {
      enabled: activeVietQrProvider === 'SEPAY',
      activeVietQrProvider,
      mode: this.sepayAdapter.isLiveConfigured ? 'LIVE' : 'SANDBOX_LOCAL',
      bankCode: this.config.sepay.bankCode,
      bankBin: this.config.sepay.bankBin,
      bankName: this.config.sepay.bankName,
      accountNoMasked: maskAccountNumber(this.config.sepay.accountNo),
      accountName: this.config.sepay.accountName,
      orderPrefix: this.config.sepay.orderPrefix,
      qrTemplate: this.config.sepay.qrTemplate,
      webhookUrl: `${this.config.bffPublicUrl}/bff/v1/payments/sepay/webhook`,
      webhookAuthHeaderExample: 'Authorization: Apikey <SEPAY_WEBHOOK_API_KEY>',
      webhookApiKeyConfigured: this.sepayAdapter.webhookApiKeyConfigured,
      apiTokenConfigured: this.sepayAdapter.apiTokenConfigured,
      autoPollEnabled: this.config.sepay.autoPollEnabled,
      pollIntervalMs: this.config.sepay.pollIntervalMs,
      lastPollAt: this.lastSePayPollAt,
      lastPollError: this.lastSePayPollError,
      pendingVietQrCount,
    };
  }

  /**
   * Dev/Sandbox simulator that builds an authentic SePay webhook payload and
   * dispatches it through `handleSePayWebhook` with the real `Authorization: Apikey` header.
   * Disabled in production.
   */
  async simulateSePayWebhook(
    rawBody: unknown,
    correlationId: string,
    traceparent?: string,
  ): Promise<SimulateSePayWebhookResult> {
    if (this.config.nodeEnv === 'production') {
      throw new PaymentApiException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Endpoint mô phỏng webhook SePay bị vô hiệu hóa ở môi trường production. / SePay simulator is disabled in production.',
      );
    }

    const parsed = SimulateSePayWebhookSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu mô phỏng webhook SePay không hợp lệ. / Invalid SePay simulate payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (!input.orderCode && !input.orderId) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Cần cung cấp orderCode hoặc orderId để mô phỏng chuyển khoản SePay. / Either orderCode or orderId is required.',
      );
    }

    const chargeTx = await this.findChargeTransaction({
      orderCode: input.orderCode,
      compactOrderCode: input.orderCode,
      orderId: input.orderId,
    });
    if (!chargeTx) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy phiên thanh toán cho đơn "${input.orderCode ?? input.orderId}". / Payment transaction not found.`,
      );
    }

    const rawMeta = parseJsonRecord(chargeTx.raw_payload_jsonb);
    const transferContent =
      input.content ??
      (typeof rawMeta?.transferContent === 'string' && rawMeta.transferContent.trim()
        ? rawMeta.transferContent.trim()
        : buildSePayTransferContent(chargeTx.order_code, this.config.sepay.orderPrefix));
    const amountVnd = input.amountVnd ?? Number(chargeTx.amount_vnd);
    const vnTime = new Date(Date.now() + 7 * 60 * 60 * 1000);
    const transactionDate = vnTime.toISOString().slice(0, 19).replace('T', ' ');
    const simId = input.id ?? Math.floor(10_000_000 + Math.random() * 89_000_000);

    const sepayPayload: SePayWebhookPayloadDTO = {
      id: simId,
      gateway: input.gateway ?? this.config.sepay.bankCode,
      transactionDate,
      accountNumber: this.config.sepay.accountNo,
      subAccount: null,
      code: normalizeCompactOrderCode(chargeTx.order_code),
      content: transferContent,
      transferType: input.transferType ?? 'in',
      description: `BankAPINotify ${transferContent}`,
      transferAmount: amountVnd,
      accumulated: amountVnd,
      referenceCode: input.referenceCode ?? `FT${Date.now().toString().slice(-10)}`,
    };

    const result = await this.handleSePayWebhook(
      sepayPayload,
      {
        authorization: `Apikey ${this.sepayAdapter.webhookApiKey}`,
      },
      correlationId,
      traceparent,
    );

    return {
      ...result,
      simulated: true,
      sepayPayload,
    };
  }

  /**
   * Verifies Return URL query params from VNPay, MoMo, or PayOS/VietQR,
   * syncs verified payment status idempotently, and returns structured UI status.
   */
  async handlePaymentReturn(
    rawQuery: Record<string, unknown>,
    correlationId: string,
    traceparent?: string,
  ): Promise<PaymentReturnVerificationDTO> {
    const hasVnpay =
      Boolean(toSingleQueryValue(rawQuery.vnp_TxnRef)) ||
      Boolean(toSingleQueryValue(rawQuery.vnp_SecureHash)) ||
      Boolean(toSingleQueryValue(rawQuery.vnp_ResponseCode));

    const hasMomo =
      Boolean(toSingleQueryValue(rawQuery.partnerCode)) ||
      (Boolean(toSingleQueryValue(rawQuery.orderId)) &&
        toSingleQueryValue(rawQuery.resultCode) !== '');

    if (hasVnpay) {
      return this.verifyVnpayReturn(rawQuery, correlationId, traceparent);
    }
    if (hasMomo) {
      return this.verifyMomoReturn(rawQuery, correlationId, traceparent);
    }

    const payosOrderCode = toSingleQueryValue(rawQuery.orderCode).trim();
    const payosLinkId = toSingleQueryValue(rawQuery.id).trim();
    if (payosOrderCode || payosLinkId) {
      return this.verifyPayOsReturn(rawQuery, correlationId, traceparent);
    }

    return {
      verified: false,
      paid: false,
      status: 'INVALID_REQUEST',
      orderCode: null,
      provider: null,
      amountVnd: null,
      message: 'Không tìm thấy tham số xác thực kết quả thanh toán từ cổng giao dịch.',
      responseCode: 'MISSING_PARAMS',
      transactionId: null,
      orderStatus: null,
    };
  }

  private async verifyVnpayReturn(
    rawQuery: Record<string, unknown>,
    correlationId: string,
    traceparent?: string,
  ): Promise<PaymentReturnVerificationDTO> {
    const orderCode = toSingleQueryValue(rawQuery.vnp_TxnRef).trim() || null;
    const responseCode = toSingleQueryValue(rawQuery.vnp_ResponseCode).trim() || null;
    const transactionStatus = toSingleQueryValue(rawQuery.vnp_TransactionStatus).trim();
    const transactionNo = toSingleQueryValue(rawQuery.vnp_TransactionNo).trim();
    const payDate = toSingleQueryValue(rawQuery.vnp_PayDate).trim();
    const rawAmount = Number(toSingleQueryValue(rawQuery.vnp_Amount));
    const parsedAmountVnd =
      Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount / 100) : null;

    const sigValid = this.vnpayAdapter.verifySignature(rawQuery);
    if (!sigValid) {
      return {
        verified: false,
        paid: false,
        status: 'SIGNATURE_INVALID',
        orderCode,
        provider: PaymentProvider.VNPAY,
        amountVnd: parsedAmountVnd,
        message: 'Chữ ký xác thực VNPay (HMAC-SHA512) không hợp lệ. Vui lòng không tin cậy liên kết này.',
        responseCode: responseCode ?? '97',
        transactionId: null,
        orderStatus: null,
      };
    }

    const chargeTx = orderCode
      ? await this.findChargeTransaction({ orderCode })
      : null;

    if (!chargeTx) {
      return {
        verified: true,
        paid: false,
        status: 'NOT_FOUND',
        orderCode,
        provider: PaymentProvider.VNPAY,
        amountVnd: parsedAmountVnd,
        message: `Không tìm thấy giao dịch VNPay tương ứng với đơn hàng ${orderCode ?? ''}.`,
        responseCode: responseCode ?? '01',
        transactionId: null,
        orderStatus: null,
      };
    }

    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (parsedAmountVnd !== null && parsedAmountVnd !== expectedAmountVnd) {
      return {
        verified: false,
        paid: false,
        status: 'AMOUNT_MISMATCH',
        orderCode: chargeTx.order_code,
        provider: PaymentProvider.VNPAY,
        amountVnd: parsedAmountVnd,
        message: 'Số tiền phản hồi từ VNPay không khớp với giá trị đơn hàng.',
        responseCode: '04',
        transactionId: chargeTx.id,
        orderStatus: null,
      };
    }

    const isPaid =
      responseCode === '00' &&
      (transactionStatus === '' || transactionStatus === '00');

    const providerEventId = transactionNo
      ? `vnpay:${transactionNo}`
      : `vnpay:${chargeTx.order_code}:${payDate || responseCode || 'return'}`;

    const settled = await this.settleVerifiedProviderCallback({
      provider: PaymentProvider.VNPAY,
      providerEventId,
      chargeTx,
      providerTxId: transactionNo || providerEventId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: isPaid
        ? PaymentTransactionStatus.SUCCEEDED
        : PaymentTransactionStatus.FAILED,
      paidAt: new Date().toISOString(),
      signatureHeader: toSingleQueryValue(rawQuery.vnp_SecureHash) || null,
      rawPayloadObj: rawQuery,
      correlationId,
      traceparent,
    });

    const finalPaid =
      isPaid ||
      settled.status === PaymentTransactionStatus.SUCCEEDED ||
      settled.status === PaymentTransactionStatus.LATE_SUCCEEDED;

    return {
      verified: true,
      paid: finalPaid,
      status: finalPaid
        ? settled.status
        : responseCode === '24'
          ? 'CANCELLED'
          : 'FAILED',
      orderCode: chargeTx.order_code,
      provider: PaymentProvider.VNPAY,
      amountVnd: expectedAmountVnd,
      message: describeVnpayResponseCode(responseCode ?? ''),
      responseCode,
      transactionId: chargeTx.id,
      orderStatus: settled.orderStatus ?? null,
    };
  }

  private async verifyMomoReturn(
    rawQuery: Record<string, unknown>,
    correlationId: string,
    traceparent?: string,
  ): Promise<PaymentReturnVerificationDTO> {
    const orderCode = toSingleQueryValue(rawQuery.orderId).trim() || null;
    const resultCode = toSingleQueryValue(rawQuery.resultCode).trim();
    const transId = toSingleQueryValue(rawQuery.transId).trim();
    const requestId = toSingleQueryValue(rawQuery.requestId).trim();
    const momoMsg = toSingleQueryValue(rawQuery.message).trim();
    const rawAmount = Number(toSingleQueryValue(rawQuery.amount));
    const parsedAmountVnd =
      Number.isFinite(rawAmount) && rawAmount > 0 ? Math.round(rawAmount) : null;

    const sigValid = this.momoAdapter.verifyIpnSignature(rawQuery);
    if (!sigValid) {
      return {
        verified: false,
        paid: false,
        status: 'SIGNATURE_INVALID',
        orderCode,
        provider: PaymentProvider.MOMO,
        amountVnd: parsedAmountVnd,
        message: 'Chữ ký xác thực MoMo (HMAC-SHA256) không hợp lệ. Giao dịch không được xác nhận.',
        responseCode: resultCode || 'INVALID_SIGNATURE',
        transactionId: null,
        orderStatus: null,
      };
    }

    const chargeTx = orderCode
      ? await this.findChargeTransaction({ orderCode })
      : null;

    if (!chargeTx) {
      return {
        verified: true,
        paid: false,
        status: 'NOT_FOUND',
        orderCode,
        provider: PaymentProvider.MOMO,
        amountVnd: parsedAmountVnd,
        message: `Không tìm thấy giao dịch MoMo cho đơn hàng ${orderCode ?? ''}.`,
        responseCode: resultCode || '404',
        transactionId: null,
        orderStatus: null,
      };
    }

    const expectedAmountVnd = Number(chargeTx.amount_vnd);
    if (parsedAmountVnd !== null && parsedAmountVnd !== expectedAmountVnd) {
      return {
        verified: false,
        paid: false,
        status: 'AMOUNT_MISMATCH',
        orderCode: chargeTx.order_code,
        provider: PaymentProvider.MOMO,
        amountVnd: parsedAmountVnd,
        message: 'Số tiền phản hồi từ MoMo không khớp với giá trị đơn hàng.',
        responseCode: 'AMOUNT_MISMATCH',
        transactionId: chargeTx.id,
        orderStatus: null,
      };
    }

    const isPaid = resultCode === '0';
    const providerEventId = transId
      ? `momo:${transId}`
      : `momo:${requestId || chargeTx.order_code}`;

    const settled = await this.settleVerifiedProviderCallback({
      provider: PaymentProvider.MOMO,
      providerEventId,
      chargeTx,
      providerTxId: transId || providerEventId,
      amountVnd: expectedAmountVnd,
      nextTxStatus: isPaid
        ? PaymentTransactionStatus.SUCCEEDED
        : PaymentTransactionStatus.FAILED,
      paidAt: new Date().toISOString(),
      signatureHeader: toSingleQueryValue(rawQuery.signature) || null,
      rawPayloadObj: {
        ...rawQuery,
        momoTransId: transId || undefined,
      },
      correlationId,
      traceparent,
    });

    const finalPaid =
      isPaid ||
      settled.status === PaymentTransactionStatus.SUCCEEDED ||
      settled.status === PaymentTransactionStatus.LATE_SUCCEEDED;

    return {
      verified: true,
      paid: finalPaid,
      status: finalPaid
        ? settled.status
        : resultCode === '1006'
          ? 'CANCELLED'
          : 'FAILED',
      orderCode: chargeTx.order_code,
      provider: PaymentProvider.MOMO,
      amountVnd: expectedAmountVnd,
      message: describeMomoResultCode(resultCode, momoMsg),
      responseCode: resultCode || null,
      transactionId: chargeTx.id,
      orderStatus: settled.orderStatus ?? null,
    };
  }

  private async verifyPayOsReturn(
    rawQuery: Record<string, unknown>,
    correlationId: string,
    traceparent?: string,
  ): Promise<PaymentReturnVerificationDTO> {
    const orderCodeParam = toSingleQueryValue(rawQuery.orderCode).trim();
    const linkIdParam = toSingleQueryValue(rawQuery.id).trim();
    const statusParam = toSingleQueryValue(rawQuery.status).trim().toUpperCase();
    const cancelParam = toSingleQueryValue(rawQuery.cancel).trim().toLowerCase();
    const codeParam = toSingleQueryValue(rawQuery.code).trim() || null;

    const chargeTx = await this.findChargeTransaction({
      orderCode: orderCodeParam || null,
      compactOrderCode: orderCodeParam || null,
      payosOrderCode: orderCodeParam || null,
      providerTxId: linkIdParam || null,
    });

    if (!chargeTx) {
      return {
        verified: false,
        paid: false,
        status: 'NOT_FOUND',
        orderCode: orderCodeParam || null,
        provider: PaymentProvider.VIETQR,
        amountVnd: null,
        message: 'Không tìm thấy giao dịch VietQR / PayOS tương ứng.',
        responseCode: codeParam ?? '404',
        transactionId: null,
        orderStatus: null,
      };
    }

    const amountVnd = Number(chargeTx.amount_vnd);

    if (
      chargeTx.status === PaymentTransactionStatus.SUCCEEDED ||
      chargeTx.status === PaymentTransactionStatus.LATE_SUCCEEDED
    ) {
      return {
        verified: true,
        paid: true,
        status: chargeTx.status,
        orderCode: chargeTx.order_code,
        provider: PaymentProvider.VIETQR,
        amountVnd,
        message: 'Thanh toán VietQR / PayOS đã được đối soát thành công.',
        responseCode: codeParam ?? '00',
        transactionId: chargeTx.id,
        orderStatus: null,
      };
    }

    // If PayOS live API is configured, verify server-to-server instead of trusting query params
    if (this.payosAdapter.isLiveConfigured && chargeTx.status === PaymentTransactionStatus.PENDING) {
      const rawMeta = parseJsonRecord(chargeTx.raw_payload_jsonb);
      const lookupId =
        chargeTx.provider_tx_id ||
        linkIdParam ||
        (rawMeta?.payosOrderCode ? String(rawMeta.payosOrderCode) : '');
      if (lookupId) {
        const liveStatus = await this.payosAdapter.fetchLivePaymentStatus(lookupId);
        if (liveStatus.ok && liveStatus.status === 'PAID' && liveStatus.amountPaid >= amountVnd) {
          const settled = await this.settleVerifiedProviderCallback({
            provider: PaymentProvider.VIETQR,
            providerEventId: `payos:${lookupId}`,
            chargeTx,
            providerTxId: lookupId,
            amountVnd,
            nextTxStatus: PaymentTransactionStatus.SUCCEEDED,
            paidAt: new Date().toISOString(),
            signatureHeader: null,
            rawPayloadObj: liveStatus.rawResponse ?? rawQuery,
            correlationId,
            traceparent,
          });
          return {
            verified: true,
            paid: true,
            status: settled.status,
            orderCode: chargeTx.order_code,
            provider: PaymentProvider.VIETQR,
            amountVnd,
            message: 'Thanh toán PayOS đã được xác thực trực tiếp từ máy chủ PayOS.',
            responseCode: '00',
            transactionId: chargeTx.id,
            orderStatus: settled.orderStatus ?? null,
          };
        }
      }
    }

    // If SePay User API is configured and still PENDING, sync on-demand before returning
    if (
      this.sepayAdapter.apiTokenConfigured &&
      chargeTx.status === PaymentTransactionStatus.PENDING
    ) {
      await this.syncPendingSePayTransactions(correlationId, traceparent);
      const updatedTx = await this.findChargeTransaction({
        orderCode: chargeTx.order_code,
      });
      if (
        updatedTx &&
        (updatedTx.status === PaymentTransactionStatus.SUCCEEDED ||
          updatedTx.status === PaymentTransactionStatus.LATE_SUCCEEDED)
      ) {
        return {
          verified: true,
          paid: true,
          status: updatedTx.status,
          orderCode: updatedTx.order_code,
          provider: PaymentProvider.VIETQR,
          amountVnd,
          message: 'Thanh toán VietQR · SePay đã được đối soát tự động thành công.',
          responseCode: '00',
          transactionId: updatedTx.id,
          orderStatus: null,
        };
      }
    }

    if (cancelParam === 'true' || statusParam === 'CANCELLED') {
      return {
        verified: true,
        paid: false,
        status: 'CANCELLED',
        orderCode: chargeTx.order_code,
        provider: PaymentProvider.VIETQR,
        amountVnd,
        message: 'Bạn đã hủy thao tác thanh toán VietQR / PayOS.',
        responseCode: codeParam ?? 'CANCELLED',
        transactionId: chargeTx.id,
        orderStatus: null,
      };
    }

    return {
      verified: true,
      paid: false,
      status: chargeTx.status,
      orderCode: chargeTx.order_code,
      provider: PaymentProvider.VIETQR,
      amountVnd,
      message:
        'Giao dịch đang chờ đối soát tự động từ ngân hàng. Vui lòng đợi vài giây hoặc kiểm tra lại.',
      responseCode: codeParam ?? 'PENDING',
      transactionId: chargeTx.id,
      orderStatus: null,
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

    const chargeTx = await this.findChargeTransaction({
      orderCode: input.orderCode,
      orderId: input.orderId,
    });
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

  private async executeProviderRefund(
    originalCharge: PaymentTransactionRow,
    amountVnd: number,
    isFullRefund: boolean,
    reason: string,
    clientIp?: string | null,
  ): Promise<ProviderRefundResult> {
    const rawMeta = parseJsonRecord(originalCharge.raw_payload_jsonb);

    if (originalCharge.provider === PaymentProvider.VNPAY) {
      const txDate =
        typeof rawMeta?.vnp_PayDate === 'string' && rawMeta.vnp_PayDate.trim()
          ? rawMeta.vnp_PayDate.trim()
          : typeof rawMeta?.vnpCreateDate === 'string' && rawMeta.vnpCreateDate.trim()
            ? rawMeta.vnpCreateDate.trim()
            : null;
      return this.vnpayAdapter.refundTransaction({
        orderCode: originalCharge.order_code,
        amountVnd,
        isFullRefund,
        transactionDate: txDate,
        providerTransactionNo: originalCharge.provider_tx_id,
        reason,
        clientIp,
      });
    }

    if (originalCharge.provider === PaymentProvider.MOMO) {
      const transId =
        (typeof rawMeta?.momoTransId === 'string' && rawMeta.momoTransId.trim()) ||
        originalCharge.provider_tx_id ||
        '0';
      return this.momoAdapter.refundTransaction({
        orderCode: originalCharge.order_code,
        amountVnd,
        transId,
        reason,
      });
    }

    if (originalCharge.provider === PaymentProvider.VIETQR) {
      if (rawMeta?.vietqrProvider === 'SEPAY') {
        return this.sepayAdapter.refundTransaction({
          orderCode: originalCharge.order_code,
          amountVnd,
          reason,
          chargeStatus: originalCharge.status,
          providerTxId: originalCharge.provider_tx_id,
        });
      }
      return this.payosAdapter.refundTransaction({
        orderCode: originalCharge.order_code,
        amountVnd,
        reason,
        chargeStatus: originalCharge.status,
        paymentLinkId: originalCharge.provider_tx_id,
      });
    }

    return {
      ok: true,
      mode: 'SANDBOX_LOCAL',
      providerRefundId: `COD-REF-${randomUUID().slice(0, 8).toUpperCase()}`,
      providerCode: '00',
      message: 'Hoàn tiền COD nội bộ đã được ghi nhận.',
      rawResponse: { provider: 'COD', orderCode: originalCharge.order_code, amountVnd },
    };
  }

  async createRefund(
    rawBody: unknown,
    idempotencyHeader: string | null,
    clientIp?: string | null,
  ): Promise<RichRefundResponseDTO> {
    const parsed = FlexibleRefundRequestSchema.safeParse(rawBody);
    if (!parsed.success) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Dữ liệu yêu cầu hoàn tiền không hợp lệ. / Invalid refund request payload.',
        { issues: parsed.error.issues },
      );
    }

    const input = parsed.data;
    if (input.orderId && !UUID_REGEX.test(input.orderId)) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'orderId phải là UUID hợp lệ. / orderId must be a valid UUID.',
      );
    }
    if (input.transactionId && !UUID_REGEX.test(input.transactionId)) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'transactionId phải là UUID hợp lệ. / transactionId must be a valid UUID.',
      );
    }

    let chargeRes: { rows: PaymentTransactionRow[] };
    if (input.transactionId) {
      chargeRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE id = $1::uuid AND tx_type = 'CHARGE'
        LIMIT 1
        `,
        [input.transactionId],
      );
    } else if (input.orderId && input.orderCode) {
      chargeRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE (order_id = $1::uuid OR order_code = $2) AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [input.orderId, input.orderCode],
      );
    } else if (input.orderId) {
      chargeRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE order_id = $1::uuid AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [input.orderId],
      );
    } else {
      chargeRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE order_code = $1 AND tx_type = 'CHARGE'
        ORDER BY created_at DESC
        LIMIT 1
        `,
        [input.orderCode!],
      );
    }

    const originalCharge = chargeRes.rows[0];
    if (!originalCharge) {
      throw new PaymentApiException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy giao dịch gốc cho đơn "${input.orderCode ?? input.orderId ?? input.transactionId}". / Original charge transaction not found.`,
      );
    }

    const idempotencyKey =
      input.idempotencyKey?.trim() ||
      idempotencyHeader?.trim() ||
      `refund:${originalCharge.order_id}:${input.rmaId ?? 'order'}:${input.amountVnd}:${Date.now()}`;

    const originalAmountVnd = Number(originalCharge.amount_vnd);

    // Idempotent replay when explicit key or header was supplied (only replay SUCCEEDED refunds)
    const hasExplicitIdempotency = Boolean(input.idempotencyKey?.trim() || idempotencyHeader?.trim());
    if (hasExplicitIdempotency) {
      const existingRefundRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT * FROM payment_transactions
        WHERE idempotency_key = $1 AND tx_type = 'REFUND' AND status = 'SUCCEEDED'
        LIMIT 1
        `,
        [idempotencyKey],
      );
      const existingRefund = existingRefundRes.rows[0];
      if (existingRefund) {
        const refundedSumRes = await this.db.query<{ refunded_total: string | number | bigint }>(
          `
          SELECT COALESCE(SUM(amount_vnd), 0) AS refunded_total
          FROM payment_transactions
          WHERE order_id = $1 AND tx_type = 'REFUND' AND status = 'SUCCEEDED'
          `,
          [originalCharge.order_id],
        );
        const totalRefundedNow = Number(refundedSumRes.rows[0]?.refunded_total ?? 0);
        const netNow = Math.max(0, originalAmountVnd - totalRefundedNow);
        const rawMeta = parseJsonRecord(existingRefund.raw_payload_jsonb);
        return {
          refundId: existingRefund.id,
          refundTxId: existingRefund.id,
          orderId: existingRefund.order_id,
          orderCode: existingRefund.order_code,
          rmaId: typeof rawMeta?.rmaId === 'string' ? rawMeta.rmaId : (input.rmaId ?? null),
          amountVnd: Number(existingRefund.amount_vnd),
          status: 'COMPLETED',
          provider: existingRefund.provider,
          providerMode:
            rawMeta?.providerMode === 'LIVE' ? 'LIVE' : 'SANDBOX_LOCAL',
          providerRefundId: existingRefund.provider_tx_id,
          idempotentReplay: true,
          refundedAt: toIso(existingRefund.paid_at ?? existingRefund.created_at),
          refundedAmountVnd: totalRefundedNow,
          netRefundableVnd: netNow,
          before: {
            status: originalCharge.status,
            refundedAmountVnd: totalRefundedNow,
            netRefundableVnd: netNow,
          },
          after: {
            status: originalCharge.status,
            refundedAmountVnd: totalRefundedNow,
            netRefundableVnd: netNow,
          },
        };
      }
    }

    const refundedSumRes = await this.db.query<{ refunded_total: string | number | bigint }>(
      `
      SELECT COALESCE(SUM(amount_vnd), 0) AS refunded_total
      FROM payment_transactions
      WHERE order_id = $1 AND tx_type = 'REFUND' AND status = 'SUCCEEDED'
      `,
      [originalCharge.order_id],
    );
    const alreadyRefundedVnd = Number(refundedSumRes.rows[0]?.refunded_total ?? 0);
    const netRefundableBefore = Math.max(0, originalAmountVnd - alreadyRefundedVnd);

    if (input.amountVnd <= 0 || input.amountVnd > netRefundableBefore) {
      throw new PaymentApiException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.REFUND_EXCEEDS_BALANCE,
        `Số tiền hoàn (${input.amountVnd.toLocaleString('vi-VN')}₫) vượt quá số dư có thể hoàn (${netRefundableBefore.toLocaleString('vi-VN')}₫). / Refund exceeds net refundable balance.`,
        {
          originalAmountVnd,
          alreadyRefundedVnd,
          netRefundableVnd: netRefundableBefore,
          requestedRefundVnd: input.amountVnd,
        },
      );
    }

    const refundId = randomUUID();
    const refundedAt = new Date().toISOString();
    const nextRefundedTotal = alreadyRefundedVnd + input.amountVnd;
    const netRefundableAfter = Math.max(0, originalAmountVnd - nextRefundedTotal);
    const isFullRefund = nextRefundedTotal >= originalAmountVnd;
    const nextChargeStatus = isFullRefund
      ? PaymentTransactionStatus.REFUNDED
      : originalCharge.status;

    // Invoke real provider adapter BEFORE recording refund as SUCCEEDED
    const providerRefund = await this.executeProviderRefund(
      originalCharge,
      input.amountVnd,
      isFullRefund,
      input.reason,
      clientIp,
    );

    if (!providerRefund.ok) {
      const failedIdemKey = `failed:${refundId.slice(0, 8)}:${idempotencyKey}`.slice(0, 128);
      await this.db
        .query(
          `
          INSERT INTO payment_transactions (
            id, order_id, order_code, provider, tx_type, amount_vnd,
            status, provider_tx_id, idempotency_key, signature_verified,
            raw_payload_jsonb, paid_at
          )
          VALUES ($1, $2, $3, $4, 'REFUND', $5, 'FAILED', NULL, $6, FALSE, $7::jsonb, NULL)
          ON CONFLICT (idempotency_key) DO NOTHING
          `,
          [
            refundId,
            originalCharge.order_id,
            originalCharge.order_code,
            originalCharge.provider,
            input.amountVnd,
            failedIdemKey,
            JSON.stringify({
              reason: input.reason,
              rmaId: input.rmaId ?? null,
              originalChargeId: originalCharge.id,
              fullRefund: isFullRefund,
              providerMode: providerRefund.mode,
              providerCode: providerRefund.providerCode,
              providerMessage: providerRefund.message,
              rawProviderResponse: providerRefund.rawResponse ?? null,
            }),
          ],
        )
        .catch(() => undefined);

      throw new PaymentApiException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        `Cổng thanh toán ${originalCharge.provider} từ chối hoàn tiền (${providerRefund.providerCode}): ${providerRefund.message}`,
        {
          refundId,
          provider: originalCharge.provider,
          providerCode: providerRefund.providerCode,
          providerMessage: providerRefund.message,
        },
      );
    }

    const providerRefundTxId =
      providerRefund.providerRefundId ?? `REF-${refundId.slice(0, 8).toUpperCase()}`;

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
          providerRefundTxId,
          idempotencyKey,
          JSON.stringify({
            reason: input.reason,
            rmaId: input.rmaId ?? null,
            originalChargeId: originalCharge.id,
            fullRefund: isFullRefund,
            providerMode: providerRefund.mode,
            providerCode: providerRefund.providerCode,
            providerMessage: providerRefund.message,
            rawProviderResponse: providerRefund.rawResponse ?? null,
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
      refundTxId: refundId,
      orderId: originalCharge.order_id,
      orderCode: originalCharge.order_code,
      rmaId: input.rmaId ?? null,
      amountVnd: input.amountVnd,
      status: 'COMPLETED',
      provider: originalCharge.provider,
      providerMode: providerRefund.mode,
      providerRefundId: providerRefundTxId,
      idempotentReplay: false,
      refundedAt,
      refundedAmountVnd: nextRefundedTotal,
      netRefundableVnd: netRefundableAfter,
      before: {
        status: originalCharge.status,
        refundedAmountVnd: alreadyRefundedVnd,
        netRefundableVnd: netRefundableBefore,
      },
      after: {
        status: nextChargeStatus,
        refundedAmountVnd: nextRefundedTotal,
        netRefundableVnd: netRefundableAfter,
      },
    };
  }

  async listAdminTransactions(
    rawQuery: Record<string, unknown>,
  ): Promise<AdminPaymentTransactionsListResult> {
    const parsed = AdminPaymentTransactionsQuerySchema.safeParse(rawQuery);
    const query = parsed.success ? parsed.data : {};

    const clauses: string[] = [`tx_type = 'CHARGE'`];
    const params: unknown[] = [];

    const methodFilter = (query.method ?? query.provider)?.trim().toUpperCase();
    if (methodFilter && methodFilter !== 'ALL') {
      params.push(methodFilter);
      clauses.push(`provider = $${params.length}`);
    }

    const statusFilter = query.status?.trim().toUpperCase();
    if (statusFilter && statusFilter !== 'ALL') {
      params.push(statusFilter);
      clauses.push(`status = $${params.length}`);
    }

    if (query.orderCode && query.orderCode.trim().length > 0) {
      params.push(`%${query.orderCode.trim()}%`);
      clauses.push(`order_code ILIKE $${params.length}`);
    }

    if (query.q && query.q.trim().length > 0) {
      params.push(`%${query.q.trim()}%`);
      clauses.push(
        `(order_code ILIKE $${params.length} OR COALESCE(provider_tx_id, '') ILIKE $${params.length} OR idempotency_key ILIKE $${params.length})`,
      );
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;
    const whereSql = `WHERE ${clauses.join(' AND ')}`;

    const [countRes, chargesRes, summaryRes] = await Promise.all([
      this.db.query<{ total: string | number }>(
        `SELECT COUNT(*)::int AS total FROM payment_transactions ${whereSql}`,
        params,
      ),
      this.db.query<PaymentTransactionRow>(
        `
        SELECT *
        FROM payment_transactions
        ${whereSql}
        ORDER BY created_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, limit, offset],
      ),
      this.db.query<{
        total_count: string | number;
        total_charged_vnd: string | number | bigint;
        total_refunded_vnd: string | number | bigint;
      }>(
        `
        SELECT
          COUNT(*) FILTER (WHERE tx_type = 'CHARGE')::int AS total_count,
          COALESCE(SUM(amount_vnd) FILTER (WHERE tx_type = 'CHARGE' AND status IN ('SUCCEEDED', 'LATE_SUCCEEDED', 'REFUNDED')), 0) AS total_charged_vnd,
          COALESCE(SUM(amount_vnd) FILTER (WHERE tx_type = 'REFUND' AND status = 'SUCCEEDED'), 0) AS total_refunded_vnd
        FROM payment_transactions
        `,
      ),
    ]);

    const orderIds = Array.from(new Set(chargesRes.rows.map((r) => r.order_id)));
    const refundsByOrderId = new Map<string, PaymentRefundRecordDTO[]>();

    if (orderIds.length > 0) {
      const refundsRes = await this.db.query<PaymentTransactionRow>(
        `
        SELECT *
        FROM payment_transactions
        WHERE order_id = ANY($1::uuid[]) AND tx_type = 'REFUND'
        ORDER BY created_at DESC
        `,
        [orderIds],
      );

      for (const refundRow of refundsRes.rows) {
        const meta = parseJsonRecord(refundRow.raw_payload_jsonb);
        const record: PaymentRefundRecordDTO = {
          id: refundRow.id,
          refundId: refundRow.id,
          orderId: refundRow.order_id,
          orderCode: refundRow.order_code,
          rmaId: typeof meta?.rmaId === 'string' ? meta.rmaId : null,
          amountVnd: Number(refundRow.amount_vnd),
          status: refundRow.status,
          provider: refundRow.provider,
          providerTxId: refundRow.provider_tx_id ?? null,
          reason: typeof meta?.reason === 'string' ? meta.reason : null,
          refundedAt: refundRow.paid_at ? toIso(refundRow.paid_at) : null,
          createdAt: toIso(refundRow.created_at),
        };
        const list = refundsByOrderId.get(refundRow.order_id) ?? [];
        list.push(record);
        refundsByOrderId.set(refundRow.order_id, list);
      }
    }

    const items: PaymentTransactionAdminDTO[] = chargesRes.rows.map((row) => {
      const amountVnd = Number(row.amount_vnd);
      const refunds = refundsByOrderId.get(row.order_id) ?? [];
      const refundedAmountVnd = refunds
        .filter((r) => r.status === PaymentTransactionStatus.SUCCEEDED)
        .reduce((sum, r) => sum + r.amountVnd, 0);
      const netRefundableVnd = Math.max(0, amountVnd - refundedAmountVnd);

      return {
        id: row.id,
        orderId: row.order_id,
        orderCode: row.order_code,
        provider: row.provider,
        method: row.provider,
        txType: row.tx_type,
        amountVnd,
        refundedAmountVnd,
        netRefundableVnd,
        status: row.status,
        providerTxId: row.provider_tx_id ?? null,
        idempotencyKey: row.idempotency_key,
        qrPayload: row.qr_payload ?? null,
        paymentUrl: row.payment_url ?? null,
        signatureVerified: Boolean(row.signature_verified),
        expiresAt: row.expires_at ? toIso(row.expires_at) : null,
        paidAt: row.paid_at ? toIso(row.paid_at) : null,
        createdAt: toIso(row.created_at),
        refunds,
      };
    });

    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);
    const sumRow = summaryRes.rows[0];
    const totalChargedVnd = Number(sumRow?.total_charged_vnd ?? 0);
    const totalRefundedVnd = Number(sumRow?.total_refunded_vnd ?? 0);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
      summary: {
        totalCount: Number(sumRow?.total_count ?? 0),
        totalChargedVnd,
        totalRefundedVnd,
        totalNetVnd: Math.max(0, totalChargedVnd - totalRefundedVnd),
      },
    };
  }

  async listWebhookLogs(
    rawQuery: Record<string, unknown>,
  ): Promise<AdminPaymentWebhooksListResult> {
    const parsed = AdminPaymentWebhooksQuerySchema.safeParse(rawQuery);
    const query = parsed.success ? parsed.data : {};

    const clauses: string[] = [];
    const params: unknown[] = [];

    if (
      query.provider &&
      query.provider.trim().length > 0 &&
      query.provider.trim().toUpperCase() !== 'ALL'
    ) {
      params.push(query.provider.trim().toUpperCase());
      clauses.push(`w.provider = $${params.length}`);
    }

    if (query.orderCode && query.orderCode.trim().length > 0) {
      params.push(`%${query.orderCode.trim()}%`);
      clauses.push(`COALESCE(w.order_code, '') ILIKE $${params.length}`);
    }

    if (query.signatureValid !== undefined && query.signatureValid !== '') {
      const normalized =
        typeof query.signatureValid === 'boolean'
          ? query.signatureValid
          : String(query.signatureValid).trim().toLowerCase() === 'true'
            ? true
            : String(query.signatureValid).trim().toLowerCase() === 'false'
              ? false
              : undefined;
      if (normalized !== undefined) {
        params.push(normalized);
        clauses.push(`COALESCE(w.signature_valid, TRUE) = $${params.length}`);
      }
    }

    const page = Math.max(1, query.page ?? 1);
    const limit = Math.min(200, Math.max(1, query.limit ?? 20));
    const offset = (page - 1) * limit;
    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';

    const [countRes, rowsRes] = await Promise.all([
      this.db.query<{ total: string | number }>(
        `SELECT COUNT(*)::int AS total FROM processed_webhooks w ${whereSql}`,
        params,
      ),
      this.db.query<ProcessedWebhookRow>(
        `
        SELECT
          w.provider,
          w.provider_event_id,
          w.order_code,
          w.signature_valid,
          w.signature_header,
          w.status,
          w.payload_summary,
          w.raw_payload_jsonb,
          w.received_at,
          tx.status AS tx_status,
          tx.raw_payload_jsonb AS tx_raw_payload_jsonb
        FROM processed_webhooks w
        LEFT JOIN LATERAL (
          SELECT status, raw_payload_jsonb
          FROM payment_transactions pt
          WHERE pt.order_code = w.order_code AND pt.tx_type = 'CHARGE'
          ORDER BY pt.created_at DESC
          LIMIT 1
        ) tx ON TRUE
        ${whereSql}
        ORDER BY w.received_at DESC
        LIMIT $${params.length + 1} OFFSET $${params.length + 2}
        `,
        [...params, limit, offset],
      ),
    ]);

    const items: PaymentWebhookLogDTO[] = rowsRes.rows.map((row) => {
      const rawPayload =
        parseJsonRecord(row.raw_payload_jsonb) ?? parseJsonRecord(row.tx_raw_payload_jsonb);
      const signatureValid = row.signature_valid !== false;
      const status =
        row.status || row.tx_status || (signatureValid ? 'PROCESSED' : 'SIGNATURE_INVALID');
      const payloadSummary =
        row.payload_summary ||
        `${row.provider} ${status}${row.order_code ? ` · ${row.order_code}` : ''}`;

      return {
        id: `${row.provider}:${row.provider_event_id}`,
        provider: row.provider,
        providerEventId: row.provider_event_id,
        eventId: row.provider_event_id,
        orderCode: row.order_code ?? null,
        signatureValid,
        signatureHeader: row.signature_header ?? null,
        status,
        payloadSummary,
        rawPayload,
        receivedAt: toIso(row.received_at),
      };
    });

    const total = Number(countRes.rows[0]?.total ?? 0);
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return {
      items,
      pagination: {
        page,
        limit,
        total,
        totalPages,
      },
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
