import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  PAYMENT_CONFIG_TOKEN,
  type PaymentPromoConfig,
} from '../../config/env';
import {
  fetchJsonWithRetry,
  normalizeClientIp,
  toSingleQueryValue,
  type PaymentProviderMode,
  type ProviderRefundResult,
} from './adapter-types';

export type VnpayAdapterConfig = PaymentPromoConfig['vnpay'];

export interface VnpayCreatePaymentInput {
  orderCode: string;
  amountVnd: number;
  returnUrl?: string;
  clientIp?: string | null;
  expiresAt?: string;
  orderInfo?: string;
}

export interface VnpayCreatePaymentResult {
  paymentUrl: string;
  mode: PaymentProviderMode;
  txnRef: string;
  createDate: string;
  expireDate: string;
  secureHash: string;
}

export interface VnpayRefundInput {
  orderCode: string;
  amountVnd: number;
  isFullRefund: boolean;
  transactionDate?: string | null;
  providerTransactionNo?: string | null;
  reason: string;
  createBy?: string;
  clientIp?: string | null;
}

/**
 * Formats a Date into VNPay's required UTC+7 yyyyMMddHHmmss timestamp.
 */
export function formatVnpayDateUtc7(date: Date = new Date()): string {
  const utc7 = new Date(date.getTime() + 7 * 60 * 60 * 1000);
  const yyyy = String(utc7.getUTCFullYear());
  const mm = String(utc7.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(utc7.getUTCDate()).padStart(2, '0');
  const hh = String(utc7.getUTCHours()).padStart(2, '0');
  const mi = String(utc7.getUTCMinutes()).padStart(2, '0');
  const ss = String(utc7.getUTCSeconds()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}${mi}${ss}`;
}

/**
 * Official VNPay v2.1.0 URL-encoding: percent-encode and replace %20 with +.
 */
export function vnpayEncodeValue(value: string): string {
  return encodeURIComponent(value).replace(/%20/g, '+');
}

function sanitizeVnpayOrderInfo(raw: string): string {
  return raw
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .replace(/[^a-zA-Z0-9 ._-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

/**
 * Sorts vnp_* parameters alphabetically, encodes values with %20 -> +,
 * and joins into canonical k=v&... string (excluding vnp_SecureHash & vnp_SecureHashType).
 */
export function buildVnpaySignData(
  params: Record<string, unknown>,
): string {
  const keys = Object.keys(params)
    .filter((k) => {
      if (k === 'vnp_SecureHash' || k === 'vnp_SecureHashType') {
        return false;
      }
      if (!k.startsWith('vnp_')) {
        return false;
      }
      const val = toSingleQueryValue(params[k]);
      return val.length > 0;
    })
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return keys
    .map((key) => `${encodeURIComponent(key)}=${vnpayEncodeValue(toSingleQueryValue(params[key]))}`)
    .join('&');
}

export function computeVnpayHmacSha512(data: string, hashSecret: string): string {
  return createHmac('sha512', hashSecret)
    .update(Buffer.from(data, 'utf8'))
    .digest('hex');
}

/**
 * Verifies VNPay v2.1.0 Return URL / IPN HMAC-SHA512 signature using timingSafeEqual.
 */
export function verifyVnpaySignature(
  queryParams: Record<string, unknown>,
  secret: string,
): boolean {
  const provided = toSingleQueryValue(queryParams.vnp_SecureHash).trim().toLowerCase();
  if (!provided || !/^[0-9a-f]{128}$/.test(provided)) {
    return false;
  }
  const signData = buildVnpaySignData(queryParams);
  if (!signData) {
    return false;
  }
  const expected = computeVnpayHmacSha512(signData, secret).toLowerCase();
  const bufProvided = Buffer.from(provided, 'utf8');
  const bufExpected = Buffer.from(expected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return timingSafeEqual(bufProvided, bufExpected);
}

export function buildVnpayPaymentUrl(
  input: VnpayCreatePaymentInput,
  config: VnpayAdapterConfig,
): VnpayCreatePaymentResult {
  const now = new Date();
  const expireDateObj = input.expiresAt
    ? new Date(input.expiresAt)
    : new Date(now.getTime() + 15 * 60 * 1000);
  const safeExpireDateObj = Number.isFinite(expireDateObj.getTime())
    ? expireDateObj
    : new Date(now.getTime() + 15 * 60 * 1000);

  const createDate = formatVnpayDateUtc7(now);
  const expireDate = formatVnpayDateUtc7(safeExpireDateObj);
  const returnUrl = input.returnUrl || config.returnUrl;
  const orderInfo = sanitizeVnpayOrderInfo(
    input.orderInfo || `Thanh toan don hang ${input.orderCode}`,
  );

  const params: Record<string, string> = {
    vnp_Amount: String(Math.max(0, Math.round(input.amountVnd)) * 100),
    vnp_Command: 'pay',
    vnp_CreateDate: createDate,
    vnp_CurrCode: 'VND',
    vnp_ExpireDate: expireDate,
    vnp_IpAddr: normalizeClientIp(input.clientIp),
    vnp_Locale: 'vn',
    vnp_OrderInfo: orderInfo,
    vnp_OrderType: 'fashion',
    vnp_ReturnUrl: returnUrl,
    vnp_TmnCode: config.tmnCode,
    vnp_TxnRef: input.orderCode,
    vnp_Version: '2.1.0',
  };

  const signData = buildVnpaySignData(params);
  const secureHash = computeVnpayHmacSha512(signData, config.hashSecret);
  const baseUrl = config.paymentUrl.replace(/\?+$/, '');
  const paymentUrl = `${baseUrl}?${signData}&vnp_SecureHashType=SHA512&vnp_SecureHash=${secureHash}`;

  return {
    paymentUrl,
    mode: config.isLiveConfigured ? 'LIVE' : 'SANDBOX_LOCAL',
    txnRef: input.orderCode,
    createDate,
    expireDate,
    secureHash,
  };
}

export async function refundVnpayTransaction(
  input: VnpayRefundInput,
  config: VnpayAdapterConfig,
): Promise<ProviderRefundResult> {
  const requestId = randomUUID().replace(/-/g, '').slice(0, 24);
  const version = '2.1.0';
  const command = 'refund';
  const transactionType = input.isFullRefund ? '02' : '03';
  const amountScaled = String(Math.max(0, Math.round(input.amountVnd)) * 100);
  const transactionNo = (input.providerTransactionNo || '0').replace(/[^0-9]/g, '') || '0';
  const transactionDate =
    input.transactionDate && /^\d{14}$/.test(input.transactionDate)
      ? input.transactionDate
      : formatVnpayDateUtc7(new Date());
  const createBy = (input.createBy || 'ATELIER_ADMIN').slice(0, 50);
  const createDate = formatVnpayDateUtc7(new Date());
  const ipAddr = normalizeClientIp(input.clientIp);
  const orderInfo = sanitizeVnpayOrderInfo(
    `Hoan tien don hang ${input.orderCode} ${input.reason}`,
  );

  // Official VNPay v2.1.0 Refund pipe-delimited HMAC-SHA512 signature
  const rawPipeData = [
    requestId,
    version,
    command,
    config.tmnCode,
    transactionType,
    input.orderCode,
    amountScaled,
    transactionNo,
    transactionDate,
    createBy,
    createDate,
    ipAddr,
    orderInfo,
  ].join('|');

  const secureHash = computeVnpayHmacSha512(rawPipeData, config.hashSecret);

  const payload = {
    vnp_RequestId: requestId,
    vnp_Version: version,
    vnp_Command: command,
    vnp_TmnCode: config.tmnCode,
    vnp_TransactionType: transactionType,
    vnp_TxnRef: input.orderCode,
    vnp_Amount: amountScaled,
    vnp_TransactionNo: transactionNo,
    vnp_TransactionDate: transactionDate,
    vnp_CreateBy: createBy,
    vnp_CreateDate: createDate,
    vnp_IpAddr: ipAddr,
    vnp_OrderInfo: orderInfo,
    vnp_SecureHash: secureHash,
  };

  if (!config.liveApiEnabled) {
    return {
      ok: true,
      mode: 'SANDBOX_LOCAL',
      providerRefundId: `VNP-REF-${requestId.slice(0, 12).toUpperCase()}`,
      providerCode: '00',
      message: 'Hoàn tiền VNPay Sandbox/Local đã được xác nhận.',
      rawResponse: {
        vnp_ResponseCode: '00',
        vnp_Message: 'Sandbox refund approved',
        vnp_RequestId: requestId,
        vnp_Command: command,
        vnp_TxnRef: input.orderCode,
        vnp_Amount: amountScaled,
        vnp_SecureHash: secureHash,
      },
    };
  }

  try {
    const res = await fetchJsonWithRetry(
      config.apiUrl,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
      },
      { timeoutMs: 8000, maxRetries: 1 },
    );

    const responseCode = String(res.json?.vnp_ResponseCode ?? res.status);
    const responseMsg =
      typeof res.json?.vnp_Message === 'string'
        ? res.json.vnp_Message
        : `VNPay refund responded HTTP ${res.status}`;

    if (!res.ok || responseCode !== '00') {
      return {
        ok: false,
        mode: 'LIVE',
        providerRefundId: null,
        providerCode: responseCode,
        message: responseMsg,
        rawResponse: res.json ?? { status: res.status, rawText: res.rawText.slice(0, 400) },
      };
    }

    const providerTxNo =
      typeof res.json?.vnp_TransactionNo === 'string' && res.json.vnp_TransactionNo.trim()
        ? res.json.vnp_TransactionNo.trim()
        : requestId;

    return {
      ok: true,
      mode: 'LIVE',
      providerRefundId: providerTxNo,
      providerCode: '00',
      message: responseMsg,
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
export class VnpayAdapter {
  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
  ) {}

  get vnpayConfig(): VnpayAdapterConfig {
    return this.config.vnpay;
  }

  createPayment(input: VnpayCreatePaymentInput): VnpayCreatePaymentResult {
    return buildVnpayPaymentUrl(input, this.config.vnpay);
  }

  verifySignature(queryParams: Record<string, unknown>): boolean {
    return verifyVnpaySignature(queryParams, this.config.vnpay.hashSecret);
  }

  async refundTransaction(input: VnpayRefundInput): Promise<ProviderRefundResult> {
    return refundVnpayTransaction(input, this.config.vnpay);
  }
}
