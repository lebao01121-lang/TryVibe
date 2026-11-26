import { randomUUID, timingSafeEqual } from 'node:crypto';
import { Inject, Injectable } from '@nestjs/common';
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
import {
  resolveSePayBankMeta,
  SEPAY_BANK_DIRECTORY,
  type SePayBankMeta,
} from './sepay-banks';

export { resolveSePayBankMeta, SEPAY_BANK_DIRECTORY, type SePayBankMeta };

export type SePayHeaderBag = Record<string, string | string[] | undefined>;

export interface SePayCreateIntentInput {
  orderCode: string;
  amountVnd: number;
  expiresAt?: string;
}

export interface SePayCreateIntentResult extends RenderedVietQrArtifacts {
  mode: PaymentProviderMode;
  vietqrProvider: 'SEPAY';
  sepayQrImageUrl: string;
  transferContent: string;
  compactOrderCode: string;
  paymentUrl: string | null;
  providerTxId: string | null;
  bankInfo: {
    bankBin: string;
    bankCode: string;
    bankName: string;
    accountNo: string;
    accountName: string;
  };
}

export interface SePayExtractedApiKey {
  apiKey: string | null;
  headerName: string | null;
  rawHeader: string | null;
}

export interface SePayWebhookAuthResult {
  valid: boolean;
  providedHeader: string | null;
  headerName: string | null;
}

export interface SePayIncomingTransaction {
  id: string;
  gateway: string;
  transactionDate: string;
  accountNumber: string;
  subAccount: string | null;
  code: string | null;
  content: string;
  transferType: 'in';
  description: string | null;
  transferAmount: number;
  accumulated: number | null;
  referenceCode: string | null;
  raw: Record<string, unknown>;
}

export interface SePayFetchTransactionsInput {
  accountNo?: string;
  limit?: number;
  sinceDate?: string;
}

export interface SePayFetchTransactionsResult {
  ok: boolean;
  status: number;
  transactions: SePayIncomingTransaction[];
  error?: string;
}

export interface SePayRefundInput {
  orderCode: string;
  amountVnd: number;
  reason: string;
  chargeStatus: string;
  providerTxId?: string | null;
}

/**
 * Strips hyphens, spaces, and non-alphanumeric chars from an order code
 * so Vietnamese bank transfer remarks match deterministically.
 */
export function normalizeCompactOrderCode(orderCode: string): string {
  return orderCode.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

/**
 * Builds a clean, hyphen-free transfer remark for SePay auto-matching
 * (e.g. `TRYVIBE TX2026ABCD12`).
 */
export function buildSePayTransferContent(
  orderCode: string,
  prefix: string = 'TRYVIBE',
): string {
  const cleanPrefix = prefix.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const compactCode = normalizeCompactOrderCode(orderCode);
  if (!compactCode) {
    return cleanPrefix || 'TRYVIBE';
  }
  if (cleanPrefix && !compactCode.startsWith(cleanPrefix)) {
    return `${cleanPrefix} ${compactCode}`.slice(0, 50);
  }
  return compactCode.slice(0, 50);
}

/**
 * Builds a dynamic SePay VietQR image URL (`https://qr.sepay.vn/img?...`).
 */
export function buildSePayQrImageUrl(params: {
  accountNo: string;
  bankCode: string;
  amountVnd: number;
  transferContent: string;
  template?: string;
}): string {
  const query = new URLSearchParams();
  query.set('acc', params.accountNo.trim());
  query.set('bank', params.bankCode.trim());
  query.set('amount', String(Math.max(0, Math.round(params.amountVnd))));
  query.set('des', params.transferContent.trim());
  const template = params.template?.trim();
  if (template) {
    query.set('template', template);
  }
  return `https://qr.sepay.vn/img?${query.toString()}`;
}

/**
 * Masks a bank account number for safe operational display (e.g. `0888****9999`).
 */
export function maskAccountNumber(accountNo: string): string {
  const clean = accountNo.trim();
  if (clean.length === 0) {
    return '';
  }
  if (clean.length <= 4) {
    return '****';
  }
  if (clean.length < 8) {
    return `${clean.slice(0, 2)}***${clean.slice(-2)}`;
  }
  const hiddenCount = Math.max(4, clean.length - 8);
  return `${clean.slice(0, 4)}${'*'.repeat(hiddenCount)}${clean.slice(-4)}`;
}

function readHeaderCaseInsensitive(
  headers: SePayHeaderBag,
  targetName: string,
): string | null {
  const lower = targetName.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() !== lower) {
      continue;
    }
    const candidate = Array.isArray(val) ? val[0] : val;
    if (typeof candidate === 'string') {
      const trimmed = candidate.trim();
      if (trimmed.length > 0) {
        return trimmed;
      }
    }
  }
  return null;
}

/**
 * Extracts SePay webhook API key from `Authorization: Apikey <key>`,
 * `Authorization: Bearer <key>`, `x-sepay-apikey`, or `x-api-key`.
 */
export function extractSePayApiKey(headers: SePayHeaderBag): SePayExtractedApiKey {
  const authorization = readHeaderCaseInsensitive(headers, 'authorization');
  if (authorization) {
    const apikeyMatch = /^Apikey\s+(.+)$/i.exec(authorization);
    if (apikeyMatch?.[1]?.trim()) {
      return {
        apiKey: apikeyMatch[1].trim(),
        headerName: 'authorization',
        rawHeader: authorization,
      };
    }
    const bearerMatch = /^Bearer\s+(.+)$/i.exec(authorization);
    if (bearerMatch?.[1]?.trim()) {
      return {
        apiKey: bearerMatch[1].trim(),
        headerName: 'authorization',
        rawHeader: authorization,
      };
    }
  }

  const xSePayKey = readHeaderCaseInsensitive(headers, 'x-sepay-apikey');
  if (xSePayKey) {
    return {
      apiKey: xSePayKey,
      headerName: 'x-sepay-apikey',
      rawHeader: xSePayKey,
    };
  }

  const xApiKey = readHeaderCaseInsensitive(headers, 'x-api-key');
  if (xApiKey) {
    return {
      apiKey: xApiKey,
      headerName: 'x-api-key',
      rawHeader: xApiKey,
    };
  }

  return {
    apiKey: null,
    headerName: authorization ? 'authorization' : null,
    rawHeader: authorization,
  };
}

/**
 * Timing-safe verification of SePay API Key.
 */
export function verifySePayApiKey(
  providedKey: string | null | undefined,
  expectedKey: string,
): boolean {
  if (!providedKey || !expectedKey) {
    return false;
  }
  const normalizedProvided = providedKey.trim();
  const normalizedExpected = expectedKey.trim();
  if (!normalizedProvided || !normalizedExpected) {
    return false;
  }
  const bufProvided = Buffer.from(normalizedProvided, 'utf8');
  const bufExpected = Buffer.from(normalizedExpected, 'utf8');
  if (bufProvided.length !== bufExpected.length) {
    return false;
  }
  return timingSafeEqual(bufProvided, bufExpected);
}

/**
 * Extracts candidate TryVibe order codes (both hyphenated `TX-...` and compact `TX...`)
 * from SePay webhook/API fields (`code`, `content`, `description`).
 */
export function extractOrderCodeCandidatesFromSePay(
  payload: {
    code?: string | null;
    content?: string | null;
    description?: string | null;
  },
  prefix: string = 'TRYVIBE',
): string[] {
  const candidates: string[] = [];
  const seen = new Set<string>();

  const pushCandidate = (rawToken: string | null | undefined): void => {
    if (!rawToken) {
      return;
    }
    const trimmed = rawToken
      .trim()
      .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
      .toUpperCase();
    if (trimmed.length < 4) {
      return;
    }
    if (!seen.has(trimmed)) {
      seen.add(trimmed);
      candidates.push(trimmed);
    }
    const compact = normalizeCompactOrderCode(trimmed);
    if (compact.length >= 4 && !seen.has(compact)) {
      seen.add(compact);
      candidates.push(compact);
    }
  };

  const cleanPrefix = prefix.trim().replace(/[^A-Za-z0-9]/g, '').toUpperCase();

  // 1. Highest priority: SePay's auto-extracted payment `code`
  if (payload.code && payload.code.trim()) {
    const rawCode = payload.code.trim().toUpperCase();
    pushCandidate(rawCode);
    if (cleanPrefix && rawCode.startsWith(cleanPrefix) && rawCode.length > cleanPrefix.length + 3) {
      pushCandidate(rawCode.slice(cleanPrefix.length));
    }
  }

  // 2. Scan `content` and `description`
  const texts = [payload.content, payload.description].filter(
    (v): v is string => typeof v === 'string' && v.trim().length > 0,
  );

  const prefixGroup = Array.from(
    new Set([cleanPrefix, 'TRYVIBE', 'TAMXUAN', 'ATELIER'].filter(Boolean)),
  ).join('|');
  const prefixRegex = prefixGroup
    ? new RegExp(`(?:${prefixGroup})[\\s_:-]*([A-Z0-9][A-Z0-9_-]{3,31})`, 'gi')
    : null;
  const hyphenatedOrderRegex = /\b((?:TX|TV|ORD|AT)-[A-Z0-9][A-Z0-9-]{2,28})\b/gi;
  const compactOrderRegex = /\b((?:TX|TV|ORD)[A-Z0-9]{4,26})\b/gi;

  for (const text of texts) {
    if (prefixRegex) {
      prefixRegex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = prefixRegex.exec(text)) !== null) {
        if (match[1]) {
          pushCandidate(match[1]);
        }
      }
    }

    hyphenatedOrderRegex.lastIndex = 0;
    let hMatch: RegExpExecArray | null;
    while ((hMatch = hyphenatedOrderRegex.exec(text)) !== null) {
      if (hMatch[1]) {
        pushCandidate(hMatch[1]);
      }
    }

    compactOrderRegex.lastIndex = 0;
    let cMatch: RegExpExecArray | null;
    while ((cMatch = compactOrderRegex.exec(text)) !== null) {
      if (cMatch[1]) {
        pushCandidate(cMatch[1]);
      }
    }
  }

  return candidates;
}

function toOptionalTrimmedString(value: unknown): string | null {
  if (value === null || value === undefined) {
    return null;
  }
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

/**
 * Normalizes a single transaction row from either SePay User API v1 (`/transactions/list`)
 * or SePay API v2 (`/v2/transactions`) into a canonical incoming transaction object.
 * Returns `null` for outgoing/zero-amount records.
 */
export function normalizeSePayApiTransaction(
  rawItem: unknown,
): SePayIncomingTransaction | null {
  if (!rawItem || typeof rawItem !== 'object' || Array.isArray(rawItem)) {
    return null;
  }
  const item = rawItem as Record<string, unknown>;

  // Explicit outgoing transfer check (v2 transferType or v1 amount_out > 0 with amount_in == 0)
  const rawTransferType = toOptionalTrimmedString(item.transferType ?? item.transfer_type);
  if (rawTransferType && rawTransferType.toLowerCase() !== 'in') {
    return null;
  }

  const rawAmountIn =
    item.transferAmount !== undefined
      ? Number(item.transferAmount)
      : item.amount_in !== undefined
        ? Number(item.amount_in)
        : item.amount !== undefined
          ? Number(item.amount)
          : 0;
  const transferAmount = Number.isFinite(rawAmountIn) ? Math.round(rawAmountIn) : 0;
  if (transferAmount <= 0) {
    return null;
  }

  const referenceCode = toOptionalTrimmedString(
    item.referenceCode ?? item.reference_number ?? item.reference_code,
  );
  const id =
    toOptionalTrimmedString(item.id ?? item.transaction_id) ??
    referenceCode ??
    `sepay-tx-${Date.now()}`;
  const gateway =
    toOptionalTrimmedString(item.gateway ?? item.bank_brand_name ?? item.bank_code) ?? '';
  const transactionDate =
    toOptionalTrimmedString(item.transactionDate ?? item.transaction_date) ?? '';
  const accountNumber =
    toOptionalTrimmedString(item.accountNumber ?? item.account_number) ?? '';
  const subAccount = toOptionalTrimmedString(item.subAccount ?? item.sub_account);
  const code = toOptionalTrimmedString(item.code ?? item.payment_code);
  const content =
    toOptionalTrimmedString(item.content ?? item.transaction_content) ?? '';
  const description = toOptionalTrimmedString(item.description) ?? (content || null);
  const rawAccumulated =
    item.accumulated !== undefined && item.accumulated !== null
      ? Number(item.accumulated)
      : null;
  const accumulated =
    rawAccumulated !== null && Number.isFinite(rawAccumulated)
      ? Math.round(rawAccumulated)
      : null;

  return {
    id,
    gateway,
    transactionDate,
    accountNumber,
    subAccount,
    code,
    content,
    transferType: 'in',
    description,
    transferAmount,
    accumulated,
    referenceCode,
    raw: item,
  };
}

@Injectable()
export class SePayAdapter {
  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
  ) {}

  get isLiveConfigured(): boolean {
    return this.config.sepay.isLiveConfigured;
  }

  get apiTokenConfigured(): boolean {
    return this.config.sepay.apiTokenConfigured;
  }

  get webhookApiKeyConfigured(): boolean {
    return this.config.sepay.webhookApiKeyConfigured;
  }

  get webhookApiKey(): string {
    return this.config.sepay.webhookApiKey;
  }

  async createPaymentIntent(
    input: SePayCreateIntentInput,
  ): Promise<SePayCreateIntentResult> {
    const bankMeta = resolveSePayBankMeta(
      this.config.sepay.bankCode,
      this.config.sepay.bankBin,
    );
    const compactOrderCode = normalizeCompactOrderCode(input.orderCode);
    const transferContent = buildSePayTransferContent(
      input.orderCode,
      this.config.sepay.orderPrefix,
    );
    const sepayQrImageUrl = buildSePayQrImageUrl({
      accountNo: this.config.sepay.accountNo,
      bankCode: bankMeta.bankCode,
      amountVnd: input.amountVnd,
      transferContent,
      template: this.config.sepay.qrTemplate,
    });

    const localQrPayload = buildVietQrPayload(input.orderCode, input.amountVnd, {
      bankBin: bankMeta.bankBin,
      accountNo: this.config.sepay.accountNo,
      accountName: this.config.sepay.accountName,
      description: transferContent,
    });
    const artifacts = await renderVietQrArtifacts(
      input.orderCode,
      input.amountVnd,
      localQrPayload,
    );

    return {
      ...artifacts,
      mode: this.isLiveConfigured ? 'LIVE' : 'SANDBOX_LOCAL',
      vietqrProvider: 'SEPAY',
      sepayQrImageUrl,
      transferContent,
      compactOrderCode,
      paymentUrl: null,
      providerTxId: null,
      bankInfo: {
        bankBin: bankMeta.bankBin,
        bankCode: bankMeta.bankCode,
        bankName: bankMeta.bankName,
        accountNo: this.config.sepay.accountNo,
        accountName: this.config.sepay.accountName,
      },
    };
  }

  verifyWebhookAuth(headers: SePayHeaderBag): SePayWebhookAuthResult {
    const extracted = extractSePayApiKey(headers);
    const valid = verifySePayApiKey(extracted.apiKey, this.config.sepay.webhookApiKey);
    return {
      valid,
      providedHeader: extracted.rawHeader,
      headerName: extracted.headerName,
    };
  }

  async fetchRecentIncomingTransactions(
    input: SePayFetchTransactionsInput = {},
  ): Promise<SePayFetchTransactionsResult> {
    if (!this.apiTokenConfigured) {
      return {
        ok: false,
        status: 0,
        transactions: [],
        error: 'SEPAY_API_TOKEN is not configured',
      };
    }

    const baseUrl = this.config.sepay.apiBaseUrl.replace(/\/+$/, '');
    const isV2 = /\/v2$/i.test(baseUrl);
    const endpoint = isV2 ? `${baseUrl}/transactions` : `${baseUrl}/transactions/list`;

    const query = new URLSearchParams();
    const effectiveAccountNo =
      input.accountNo?.trim() ||
      (this.config.sepay.accountNo && this.config.sepay.accountNo !== '088820269999'
        ? this.config.sepay.accountNo
        : '');
    if (effectiveAccountNo) {
      query.set('account_number', effectiveAccountNo);
    }
    query.set('limit', String(Math.max(1, Math.min(100, input.limit ?? 30))));
    if (input.sinceDate?.trim()) {
      query.set('transaction_date_min', input.sinceDate.trim());
    }

    const fullUrl = `${endpoint}?${query.toString()}`;

    try {
      const response = await fetchJsonWithRetry(
        fullUrl,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${this.config.sepay.apiToken}`,
            'Content-Type': 'application/json',
            Accept: 'application/json',
          },
        },
        { timeoutMs: 10_000, maxRetries: 1 },
      );

      if (!response.ok || !response.json) {
        return {
          ok: false,
          status: response.status,
          transactions: [],
          error:
            (typeof response.json?.message === 'string' && response.json.message) ||
            (typeof response.json?.error === 'string' && response.json.error) ||
            `SePay API HTTP ${response.status}`,
        };
      }

      const rawList = Array.isArray(response.json.transactions)
        ? response.json.transactions
        : Array.isArray(response.json.data)
          ? response.json.data
          : [];

      const transactions: SePayIncomingTransaction[] = [];
      for (const item of rawList) {
        const normalized = normalizeSePayApiTransaction(item);
        if (normalized) {
          transactions.push(normalized);
        }
      }

      return {
        ok: true,
        status: response.status,
        transactions,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        status: 0,
        transactions: [],
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async refundTransaction(input: SePayRefundInput): Promise<ProviderRefundResult> {
    return {
      ok: true,
      mode: this.isLiveConfigured ? 'LIVE' : 'SANDBOX_LOCAL',
      providerRefundId: `SEPAY-REF-${randomUUID().slice(0, 8).toUpperCase()}`,
      providerCode: '00',
      message:
        'Đã ghi nhận hoàn tiền chuyển khoản ngân hàng SePay (payout hoàn trả cho khách hàng).',
      rawResponse: {
        provider: 'SEPAY',
        orderCode: input.orderCode,
        amountVnd: input.amountVnd,
        reason: input.reason,
        chargeStatus: input.chargeStatus,
        originalProviderTxId: input.providerTxId ?? null,
        bankCode: this.config.sepay.bankCode,
      },
    };
  }
}
