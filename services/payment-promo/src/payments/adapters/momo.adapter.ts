import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { HttpStatus, Inject, Injectable } from '@nestjs/common';
import { ErrorCode } from '@atelier/contracts';
import { PaymentApiException } from '../../common/payment-api.exception';
import {
  PAYMENT_CONFIG_TOKEN,
  type PaymentPromoConfig,
} from '../../config/env';
import {
  fetchJsonWithRetry,
  toSingleQueryValue,
  type PaymentProviderMode,
  type ProviderRefundResult,
} from './adapter-types';

export type MomoAdapterConfig = PaymentPromoConfig['momo'];

export interface MomoCreatePaymentInput {
  orderCode: string;
  amountVnd: number;
  redirectUrl?: string;
  ipnUrl?: string;
  orderInfo?: string;
  extraData?: string;
  requestId?: string;
}

export interface MomoCreatePaymentResult {
  paymentUrl: string;
  qrPayload: string | null;
  mode: PaymentProviderMode;
  requestId: string;
  signature: string;
  rawResponse?: Record<string, unknown> | null;
}

export interface MomoRefundInput {
  orderCode: string;
  amountVnd: number;
  transId: string | number;
  reason: string;
  refundOrderId?: string;
}

export function computeMomoHmacSha256(rawSignature: string, secretKey: string): string {
  return createHmac('sha256', secretKey).update(rawSignature, 'utf8').digest('hex');
}

/**
 * Official MoMo v2 create-payment rawSignature format.
 */
export function buildMomoCreateRawSignature(params: {
  accessKey: string;
  amount: string | number;
  extraData: string;
  ipnUrl: string;
  orderId: string;
  orderInfo: string;
  partnerCode: string;
  redirectUrl: string;
  requestId: string;
  requestType: string;
}): string {
  return [
    `accessKey=${params.accessKey}`,
    `amount=${params.amount}`,
    `extraData=${params.extraData}`,
    `ipnUrl=${params.ipnUrl}`,
    `orderId=${params.orderId}`,
    `orderInfo=${params.orderInfo}`,
    `partnerCode=${params.partnerCode}`,
    `redirectUrl=${params.redirectUrl}`,
    `requestId=${params.requestId}`,
    `requestType=${params.requestType}`,
  ].join('&');
}

/**
 * Official MoMo v2 IPN & Redirect Return rawSignature format (alphabetical key order).
 */
export function buildMomoIpnRawSignature(params: {
  accessKey: string;
  amount: string | number;
  extraData: string;
  message: string;
  orderId: string;
  orderInfo: string;
  orderType: string;
  partnerCode: string;
  payType: string;
  requestId: string;
  responseTime: string | number;
  resultCode: string | number;
  transId: string | number;
}): string {
  return [
    `accessKey=${params.accessKey}`,
    `amount=${params.amount}`,
    `extraData=${params.extraData}`,
    `message=${params.message}`,
    `orderId=${params.orderId}`,
    `orderInfo=${params.orderInfo}`,
    `orderType=${params.orderType}`,
    `partnerCode=${params.partnerCode}`,
    `payType=${params.payType}`,
    `requestId=${params.requestId}`,
    `responseTime=${params.responseTime}`,
    `resultCode=${params.resultCode}`,
    `transId=${params.transId}`,
  ].join('&');
}

export function signMomoIpnPayload(
  payload: Record<string, unknown>,
  secretKey: string,
  accessKey: string,
): string {
  const rawSignature = buildMomoIpnRawSignature({
    accessKey,
    amount: toSingleQueryValue(payload.amount),
    extraData: toSingleQueryValue(payload.extraData),
    message: toSingleQueryValue(payload.message),
    orderId: toSingleQueryValue(payload.orderId),
    orderInfo: toSingleQueryValue(payload.orderInfo),
    orderType: toSingleQueryValue(payload.orderType),
    partnerCode: toSingleQueryValue(payload.partnerCode),
    payType: toSingleQueryValue(payload.payType),
    requestId: toSingleQueryValue(payload.requestId),
    responseTime: toSingleQueryValue(payload.responseTime),
    resultCode: toSingleQueryValue(payload.resultCode),
    transId: toSingleQueryValue(payload.transId),
  });
  return computeMomoHmacSha256(rawSignature, secretKey);
}

/**
 * Verifies official MoMo v2 IPN / Redirect signature using HMAC-SHA256 + timingSafeEqual.
 */
export function verifyMomoIpnSignature(
  payload: Record<string, unknown>,
  secretKey: string,
  accessKey: string,
): boolean {
  const provided = toSingleQueryValue(payload.signature).trim().toLowerCase();
  if (!provided || !/^[0-9a-f]{64}$/.test(provided)) {
    return false;
  }
  const orderId = toSingleQueryValue(payload.orderId);
  const partnerCode = toSingleQueryValue(payload.partnerCode);
  const requestId = toSingleQueryValue(payload.requestId);
  const resultCode = toSingleQueryValue(payload.resultCode);
  if (!orderId || !partnerCode || !requestId || resultCode === '') {
    return false;
  }

  const expected = signMomoIpnPayload(payload, secretKey, accessKey).toLowerCase();
  const bufProvided = Buffer.from(provided, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return timingSafeEqual(bufProvided, bufExpected);
}

export async function createMomoPayment(
  input: MomoCreatePaymentInput,
  config: MomoAdapterConfig,
): Promise<MomoCreatePaymentResult> {
  const amount = Math.max(0, Math.round(input.amountVnd));
  const requestId =
    input.requestId?.trim() || `${input.orderCode}-${randomUUID().slice(0, 8)}`;
  const redirectUrl = input.redirectUrl || config.redirectUrl;
  const ipnUrl = input.ipnUrl || config.ipnUrl;
  const orderInfo = input.orderInfo || `TryVibe Atelier ${input.orderCode}`;
  const extraData = input.extraData ?? '';
  const requestType = 'captureWallet';

  const rawSignature = buildMomoCreateRawSignature({
    accessKey: config.accessKey,
    amount,
    extraData,
    ipnUrl,
    orderId: input.orderCode,
    orderInfo,
    partnerCode: config.partnerCode,
    redirectUrl,
    requestId,
    requestType,
  });
  const signature = computeMomoHmacSha256(rawSignature, config.secretKey);

  if (!config.isLiveConfigured) {
    const query = new URLSearchParams({
      partnerCode: config.partnerCode,
      orderId: input.orderCode,
      requestId,
      amount: String(amount),
      orderInfo,
      redirectUrl,
      ipnUrl,
      extraData,
      requestType,
      signature,
    });
    return {
      paymentUrl: `${config.apiUrl}/v2/gateway/pay?${query.toString()}`,
      qrPayload: null,
      mode: 'SANDBOX_LOCAL',
      requestId,
      signature,
      rawResponse: null,
    };
  }

  const requestBody = {
    partnerCode: config.partnerCode,
    partnerName: 'TryVibe Atelier',
    storeId: 'TryVibeAtelier',
    requestId,
    amount,
    orderId: input.orderCode,
    orderInfo,
    redirectUrl,
    ipnUrl,
    lang: 'vi',
    requestType,
    autoCapture: true,
    extraData,
    signature,
  };

  const res = await fetchJsonWithRetry(
    `${config.apiUrl}/v2/gateway/api/create`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(requestBody),
    },
    { timeoutMs: 8000, maxRetries: 1 },
  );

  const resultCode = Number(res.json?.resultCode ?? -1);
  const payUrl = typeof res.json?.payUrl === 'string' ? res.json.payUrl : '';
  if (!res.ok || resultCode !== 0 || !payUrl) {
    throw new PaymentApiException(
      HttpStatus.BAD_GATEWAY,
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      typeof res.json?.message === 'string'
        ? `MoMo gateway lỗi (${resultCode}): ${res.json.message}`
        : `Không thể khởi tạo giao dịch MoMo (HTTP ${res.status}).`,
      { provider: 'MOMO', resultCode },
    );
  }

  return {
    paymentUrl: payUrl,
    qrPayload:
      typeof res.json?.qrCodeUrl === 'string' && res.json.qrCodeUrl.trim()
        ? res.json.qrCodeUrl.trim()
        : null,
    mode: 'LIVE',
    requestId,
    signature,
    rawResponse: res.json,
  };
}

export async function refundMomoTransaction(
  input: MomoRefundInput,
  config: MomoAdapterConfig,
): Promise<ProviderRefundResult> {
  const amount = Math.max(0, Math.round(input.amountVnd));
  const requestId = `REF-${input.orderCode}-${randomUUID().slice(0, 8)}`;
  const refundOrderId = input.refundOrderId || `${input.orderCode}-R${Date.now().toString().slice(-6)}`;
  const numericTransId = Number(String(input.transId).replace(/[^0-9]/g, '')) || 0;
  const description = `Hoan tien ${input.orderCode}: ${input.reason}`.slice(0, 200);

  // Official MoMo v2 Refund rawSignature
  const rawSignature = [
    `accessKey=${config.accessKey}`,
    `amount=${amount}`,
    `description=${description}`,
    `orderId=${refundOrderId}`,
    `partnerCode=${config.partnerCode}`,
    `requestId=${requestId}`,
    `transId=${numericTransId}`,
  ].join('&');
  const signature = computeMomoHmacSha256(rawSignature, config.secretKey);

  if (!config.isLiveConfigured) {
    return {
      ok: true,
      mode: 'SANDBOX_LOCAL',
      providerRefundId: `MOMO-REF-${requestId.slice(0, 16).toUpperCase()}`,
      providerCode: '0',
      message: 'Hoàn tiền MoMo Sandbox/Local đã được xác nhận.',
      rawResponse: {
        resultCode: 0,
        message: 'Sandbox MoMo refund approved',
        orderId: refundOrderId,
        requestId,
        transId: numericTransId,
        amount,
        signature,
      },
    };
  }

  try {
    const res = await fetchJsonWithRetry(
      `${config.apiUrl}/v2/gateway/api/refund`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          partnerCode: config.partnerCode,
          orderId: refundOrderId,
          requestId,
          amount,
          transId: numericTransId,
          lang: 'vi',
          description,
          signature,
        }),
      },
      { timeoutMs: 8000, maxRetries: 1 },
    );

    const resultCode = Number(res.json?.resultCode ?? -1);
    const message =
      typeof res.json?.message === 'string'
        ? res.json.message
        : `MoMo refund responded HTTP ${res.status}`;

    if (!res.ok || resultCode !== 0) {
      return {
        ok: false,
        mode: 'LIVE',
        providerRefundId: null,
        providerCode: String(resultCode),
        message,
        rawResponse: res.json ?? { status: res.status, rawText: res.rawText.slice(0, 400) },
      };
    }

    return {
      ok: true,
      mode: 'LIVE',
      providerRefundId: String(res.json?.transId ?? requestId),
      providerCode: '0',
      message,
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

@Injectable()
export class MomoAdapter {
  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
  ) {}

  get momoConfig(): MomoAdapterConfig {
    return this.config.momo;
  }

  async createPayment(input: MomoCreatePaymentInput): Promise<MomoCreatePaymentResult> {
    return createMomoPayment(input, this.config.momo);
  }

  verifyIpnSignature(payload: Record<string, unknown>): boolean {
    return verifyMomoIpnSignature(
      payload,
      this.config.momo.secretKey,
      this.config.momo.accessKey,
    );
  }

  async refundTransaction(input: MomoRefundInput): Promise<ProviderRefundResult> {
    return refundMomoTransaction(input, this.config.momo);
  }
}
