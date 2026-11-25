import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@atelier/contracts';
import { PaymentApiException } from '../../common/payment-api.exception';
import {
  PAYMENT_CONFIG_TOKEN,
  type PaymentPromoConfig,
} from '../../config/env';
import {
  buildVietQrPayload,
  renderVietQrArtifacts,
  type RenderedVietQrArtifacts,
} from '../payment-helpers';
import {
  fetchJsonWithRetry,
  type PaymentProviderMode,
  type ProviderRefundResult,
} from './adapter-types';

export interface PayOsCreateIntentInput {
  orderCode: string;
  amountVnd: number;
  returnUrl: string;
  cancelUrl?: string;
  expiresAt?: string;
}

export interface PayOsCreateIntentResult extends RenderedVietQrArtifacts {
  mode: PaymentProviderMode;
  paymentUrl: string | null;
  checkoutUrl: string | null;
  providerTxId: string | null;
  payosOrderCode: number | null;
  bankInfo: {
    bankBin: string;
    accountNo: string;
    accountName: string;
  };
  rawResponse?: Record<string, unknown> | null;
}

export interface PayOsRefundInput {
  orderCode: string;
  amountVnd: number;
  reason: string;
  chargeStatus: string;
  paymentLinkId?: string | null;
}

/**
 * Generates a deterministic positive integer <= 9,000,000,000,000 for PayOS v2 numeric orderCode.
 */
export function derivePayOsNumericOrderCode(orderCode: string): number {
  const digest = createHash('sha256').update(orderCode, 'utf8').digest();
  const num = digest.readUIntBE(0, 5); // 0 .. 1,099,511,627,775
  return Math.max(100_000, num);
}

/**
 * Official PayOS v2 payment-request signature:
 * HMAC-SHA256 of sorted keys: amount=&cancelUrl=&description=&orderCode=&returnUrl=
 */
export function buildPayOsCreateSignature(
  params: {
    amount: number;
    cancelUrl: string;
    description: string;
    orderCode: number;
    returnUrl: string;
  },
  checksumKey: string,
): string {
  const raw = [
    `amount=${params.amount}`,
    `cancelUrl=${params.cancelUrl}`,
    `description=${params.description}`,
    `orderCode=${params.orderCode}`,
    `returnUrl=${params.returnUrl}`,
  ].join('&');
  return createHmac('sha256', checksumKey).update(raw, 'utf8').digest('hex');
}

function sortObjDataByKey(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortObjDataByKey(item));
  }
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.keys(record)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortObjDataByKey(record[key]);
        return acc;
      }, {});
  }
  return value;
}

/**
 * Serializes PayOS webhook `data` object in alphabetical key order for HMAC-SHA256 verification.
 */
export function buildPayOsWebhookDataString(data: Record<string, unknown>): string {
  const sortedKeys = Object.keys(data).sort();
  return sortedKeys
    .map((key) => {
      const val = data[key];
      if (val === null || val === undefined || val === 'null' || val === 'undefined') {
        return `${key}=`;
      }
      if (Array.isArray(val)) {
        return `${key}=${JSON.stringify(val.map((item) => sortObjDataByKey(item)))}`;
      }
      if (typeof val === 'object') {
        return `${key}=${JSON.stringify(sortObjDataByKey(val))}`;
      }
      return `${key}=${String(val)}`;
    })
    .join('&');
}

export function signPayOsWebhookData(
  data: Record<string, unknown>,
  checksumKey: string,
): string {
  const serialized = buildPayOsWebhookDataString(data);
  return createHmac('sha256', checksumKey).update(serialized, 'utf8').digest('hex');
}

/**
 * Verifies official PayOS webhook HMAC-SHA256 signature using timingSafeEqual.
 */
export function verifyPayOsWebhookSignature(
  body: Record<string, unknown>,
  checksumKey: string,
): boolean {
  const provided =
    typeof body.signature === 'string' ? body.signature.trim().toLowerCase() : '';
  if (!provided || !/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return false;
  }
  const expected = signPayOsWebhookData(
    data as Record<string, unknown>,
    checksumKey,
  ).toLowerCase();
  const bufProvided = Buffer.from(provided, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return timingSafeEqual(bufProvided, bufExpected);
}

@Injectable()
export class PayOsAdapter {
  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
  ) {}

  get isLiveConfigured(): boolean {
    return this.config.payos.isLiveConfigured;
  }

  get webhookChecksumKey(): string {
    return this.config.payos.checksumKey || this.config.webhookSecrets.VIETQR;
  }

  async createPaymentIntent(
    input: PayOsCreateIntentInput,
  ): Promise<PayOsCreateIntentResult> {
    const bankInfo = { ...this.config.vietqr };

    if (!this.config.payos.isLiveConfigured) {
      const qrPayload = buildVietQrPayload(input.orderCode, input.amountVnd, bankInfo);
      const artifacts = await renderVietQrArtifacts(
        input.orderCode,
        input.amountVnd,
        qrPayload,
      );
      return {
        ...artifacts,
        mode: 'SANDBOX_LOCAL',
        paymentUrl: null,
        checkoutUrl: null,
        providerTxId: null,
        payosOrderCode: null,
        bankInfo,
        rawResponse: null,
      };
    }

    const amount = Math.max(0, Math.round(input.amountVnd));
    const payosOrderCode = derivePayOsNumericOrderCode(input.orderCode);
    const description = `TAMXUAN ${input.orderCode}`.slice(0, 25);
    const cancelUrl =
      input.cancelUrl ||
      `${input.returnUrl}${input.returnUrl.includes('?') ? '&' : '?'}cancel=true&orderCode=${encodeURIComponent(input.orderCode)}`;
    const expiredAt = input.expiresAt
      ? Math.floor(new Date(input.expiresAt).getTime() / 1000)
      : Math.floor((Date.now() + 15 * 60 * 1000) / 1000);

    const signature = buildPayOsCreateSignature(
      {
        amount,
        cancelUrl,
        description,
        orderCode: payosOrderCode,
        returnUrl: input.returnUrl,
      },
      this.config.payos.checksumKey,
    );

    const res = await fetchJsonWithRetry(
      `${this.config.payos.baseUrl}/v2/payment-requests`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
          'x-client-id': this.config.payos.clientId,
          'x-api-key': this.config.payos.apiKey,
        },
        body: JSON.stringify({
          orderCode: payosOrderCode,
          amount,
          description,
          returnUrl: input.returnUrl,
          cancelUrl,
          ...(Number.isFinite(expiredAt) ? { expiredAt } : {}),
          signature,
        }),
      },
      { timeoutMs: 8000, maxRetries: 1 },
    );

    const code = String(res.json?.code ?? '');
    const dataRec =
      res.json?.data && typeof res.json.data === 'object' && !Array.isArray(res.json.data)
        ? (res.json.data as Record<string, unknown>)
        : null;

    if (!res.ok || code !== '00' || !dataRec) {
      throw new PaymentApiException(
        HttpStatus.BAD_GATEWAY,
        ErrorCode.DEPENDENCY_UNAVAILABLE,
        typeof res.json?.desc === 'string'
          ? `PayOS lỗi (${code || res.status}): ${res.json.desc}`
          : `Không thể khởi tạo phiên thanh toán PayOS (HTTP ${res.status}).`,
        { provider: 'VIETQR', code },
      );
    }

    const checkoutUrl =
      typeof dataRec.checkoutUrl === 'string' && dataRec.checkoutUrl.trim()
        ? dataRec.checkoutUrl.trim()
        : null;
    const qrPayload =
      typeof dataRec.qrCode === 'string' && dataRec.qrCode.trim()
        ? dataRec.qrCode.trim()
        : buildVietQrPayload(input.orderCode, input.amountVnd, bankInfo);
    const paymentLinkId =
      typeof dataRec.paymentLinkId === 'string' && dataRec.paymentLinkId.trim()
        ? dataRec.paymentLinkId.trim()
        : null;

    const artifacts = await renderVietQrArtifacts(
      input.orderCode,
      input.amountVnd,
      qrPayload,
    );

    return {
      ...artifacts,
      mode: 'LIVE',
      paymentUrl: checkoutUrl,
      checkoutUrl,
      providerTxId: paymentLinkId,
      payosOrderCode,
      bankInfo: {
        bankBin:
          typeof dataRec.bin === 'string' && dataRec.bin.trim()
            ? dataRec.bin.trim()
            : bankInfo.bankBin,
        accountNo:
          typeof dataRec.accountNumber === 'string' && dataRec.accountNumber.trim()
            ? dataRec.accountNumber.trim()
            : bankInfo.accountNo,
        accountName:
          typeof dataRec.accountName === 'string' && dataRec.accountName.trim()
            ? dataRec.accountName.trim()
            : bankInfo.accountName,
      },
      rawResponse: res.json,
    };
  }

  async fetchLivePaymentStatus(
    paymentLinkIdOrCode: string | number,
  ): Promise<{ ok: boolean; status: string | null; amountPaid: number; rawResponse: Record<string, unknown> | null }> {
    if (!this.config.payos.isLiveConfigured) {
      return { ok: false, status: null, amountPaid: 0, rawResponse: null };
    }
    try {
      const res = await fetchJsonWithRetry(
        `${this.config.payos.baseUrl}/v2/payment-requests/${encodeURIComponent(String(paymentLinkIdOrCode))}`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'x-client-id': this.config.payos.clientId,
            'x-api-key': this.config.payos.apiKey,
          },
        },
        { timeoutMs: 8000, maxRetries: 1 },
      );
      const dataRec =
        res.json?.data && typeof res.json.data === 'object' && !Array.isArray(res.json.data)
          ? (res.json.data as Record<string, unknown>)
          : null;
      if (!res.ok || String(res.json?.code ?? '') !== '00' || !dataRec) {
        return { ok: false, status: null, amountPaid: 0, rawResponse: res.json };
      }
      return {
        ok: true,
        status: typeof dataRec.status === 'string' ? dataRec.status.toUpperCase() : null,
        amountPaid: Math.max(0, Math.round(Number(dataRec.amountPaid ?? 0) || 0)),
        rawResponse: res.json,
      };
    } catch {
      return { ok: false, status: null, amountPaid: 0, rawResponse: null };
    }
  }

  verifyWebhookSignature(body: Record<string, unknown>): boolean {
    return verifyPayOsWebhookSignature(body, this.webhookChecksumKey);
  }

  async refundTransaction(input: PayOsRefundInput): Promise<ProviderRefundResult> {
    const mode: PaymentProviderMode = this.config.payos.isLiveConfigured
      ? 'LIVE'
      : 'SANDBOX_LOCAL';

    // If a live PayOS payment link is still pending/unpaid, cancel it on PayOS API first
    if (
      this.config.payos.isLiveConfigured &&
      input.chargeStatus === 'PENDING' &&
      input.paymentLinkId
    ) {
      try {
        const res = await fetchJsonWithRetry(
          `${this.config.payos.baseUrl}/v2/payment-requests/${encodeURIComponent(input.paymentLinkId)}/cancel`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Accept: 'application/json',
              'x-client-id': this.config.payos.clientId,
              'x-api-key': this.config.payos.apiKey,
            },
            body: JSON.stringify({
              cancellationReason: input.reason.slice(0, 200),
            }),
          },
          { timeoutMs: 8000, maxRetries: 1 },
        );

        const code = String(res.json?.code ?? res.status);
        if (!res.ok || code !== '00') {
          return {
            ok: false,
            mode: 'LIVE',
            providerRefundId: null,
            providerCode: code,
            message:
              typeof res.json?.desc === 'string'
                ? res.json.desc
                : `PayOS không thể hủy liên kết thanh toán (HTTP ${res.status}).`,
            rawResponse: res.json,
          };
        }

        return {
          ok: true,
          mode: 'LIVE',
          providerRefundId: `PAYOS-CANCEL-${input.paymentLinkId}`,
          providerCode: '00',
          message: 'Đã hủy liên kết thanh toán PayOS thành công.',
          rawResponse: res.json,
        };
      } catch (error: unknown) {
        return {
          ok: false,
          mode: 'LIVE',
          providerRefundId: null,
          providerCode: 'NETWORK_ERROR',
          message: error instanceof Error ? error.message : String(error),
          rawResponse: null,
        };
      }
    }

    // Settled VietQR / PayOS bank transfers are refunded via verified bank payout instruction
    const refundRef = `VIETQR-REF-${randomUUID().slice(0, 8).toUpperCase()}`;
    return {
      ok: true,
      mode,
      providerRefundId: refundRef,
      providerCode: '00',
      message:
        mode === 'LIVE'
          ? 'Đã ghi nhận lệnh hoàn chuyển khoản VietQR/PayOS.'
          : 'Hoàn tiền VietQR Sandbox/Local đã được xác nhận.',
      rawResponse: {
        provider: 'VIETQR',
        mode,
        orderCode: input.orderCode,
        amountVnd: input.amountVnd,
        refundReference: refundRef,
        reason: input.reason,
      },
    };
  }
}
