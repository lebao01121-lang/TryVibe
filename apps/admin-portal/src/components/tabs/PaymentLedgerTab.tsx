'use client';

import { useCallback, useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Permission,
  Role,
  hasAnyPermission,
} from '@atelier/contracts';
import {
  adminFetch,
  getAdminSession,
  type AdminStoredSession,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface PaymentLedgerNotifyPayload {
  kind: 'success' | 'error' | 'info';
  title?: string;
  message: string;
}

export interface PaymentLedgerTabProps {
  roles?: readonly Role[];
  session?: AdminStoredSession | null;
  mfaVerified?: boolean;
  darkMode?: boolean;
  onNotify?: (payload: PaymentLedgerNotifyPayload) => void;
  onRefreshOverview?: () => void;
}

type PaymentSubTab = 'TRANSACTIONS' | 'WEBHOOKS';
type MethodFilter = 'ALL' | 'VIETQR' | 'VNPAY' | 'MOMO' | 'COD';
type StatusFilter =
  | 'ALL'
  | 'PENDING'
  | 'SUCCEEDED'
  | 'LATE_SUCCEEDED'
  | 'REFUNDED'
  | 'FAILED'
  | 'EXPIRED';

interface RefundRecordItem {
  id: string;
  amountVnd: number;
  status: string;
  reason: string | null;
  rmaId: string | null;
  createdAt: string | null;
}

interface PaymentTransactionRecord {
  id: string;
  orderId: string;
  orderCode: string;
  provider: string;
  txType: string;
  amountVnd: number;
  refundedAmountVnd: number;
  netRefundableVnd: number;
  status: string;
  providerTxId: string | null;
  signatureVerified: boolean;
  createdAt: string | null;
  paidAt: string | null;
  expiresAt: string | null;
  refunds: RefundRecordItem[];
}

interface WebhookLogRecord {
  id: string;
  provider: string;
  eventId: string;
  orderCode: string | null;
  transactionId: string | null;
  signatureValid: boolean;
  signatureHeader: string | null;
  status: string;
  httpStatus: number | null;
  processedAt: string | null;
  createdAt: string | null;
  payload: Record<string, unknown> | null;
}

interface PaginationMeta {
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 19);
  return new Intl.DateTimeFormat('vi-VN', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(d);
}

function extractPaged<T>(
  data: unknown,
  keys: string[],
  fallbackPage: number,
  fallbackLimit: number,
): { items: T[]; pagination: PaginationMeta } {
  if (Array.isArray(data)) {
    return {
      items: data as T[],
      pagination: {
        page: fallbackPage,
        limit: fallbackLimit,
        total: data.length,
        totalPages: Math.max(1, Math.ceil(data.length / fallbackLimit)),
      },
    };
  }
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    let items: T[] = [];
    for (const key of keys) {
      if (Array.isArray(rec[key])) {
        items = rec[key] as T[];
        break;
      }
    }
    const pag =
      rec.pagination && typeof rec.pagination === 'object'
        ? (rec.pagination as Record<string, unknown>)
        : null;
    const total =
      typeof pag?.total === 'number'
        ? pag.total
        : typeof rec.total === 'number'
          ? rec.total
          : items.length;
    const page = typeof pag?.page === 'number' ? pag.page : fallbackPage;
    const limit = typeof pag?.limit === 'number' ? pag.limit : fallbackLimit;
    const totalPages =
      typeof pag?.totalPages === 'number'
        ? pag.totalPages
        : Math.max(1, Math.ceil(total / Math.max(1, limit)));
    return { items, pagination: { page, limit, total, totalPages } };
  }
  return {
    items: [],
    pagination: { page: 1, limit: fallbackLimit, total: 0, totalPages: 1 },
  };
}

function normalizeRefund(raw: Record<string, unknown>): RefundRecordItem {
  return {
    id: String(raw.id ?? raw.refundId ?? ''),
    amountVnd: Math.max(0, Math.round(Number(raw.amountVnd ?? 0) || 0)),
    status: String(raw.status ?? 'COMPLETED').toUpperCase(),
    reason: typeof raw.reason === 'string' ? raw.reason : null,
    rmaId: typeof raw.rmaId === 'string' ? raw.rmaId : null,
    createdAt:
      typeof raw.refundedAt === 'string'
        ? raw.refundedAt
        : typeof raw.createdAt === 'string'
          ? raw.createdAt
          : null,
  };
}

function normalizeTransaction(
  raw: Record<string, unknown>,
): PaymentTransactionRecord {
  const amountVnd = Math.max(0, Math.round(Number(raw.amountVnd ?? 0) || 0));
  const rawRefunds = Array.isArray(raw.refunds)
    ? (raw.refunds as Array<Record<string, unknown>>).map(normalizeRefund)
    : [];
  const computedRefunded = rawRefunds.reduce((sum, r) => sum + r.amountVnd, 0);
  const refundedAmountVnd =
    typeof raw.refundedAmountVnd === 'number'
      ? Math.max(0, Math.round(raw.refundedAmountVnd))
      : computedRefunded;
  const txType = String(raw.txType ?? 'CHARGE').toUpperCase();
  const status = String(raw.status ?? 'PENDING').toUpperCase();
  const refundableStatuses = new Set(['SUCCEEDED', 'LATE_SUCCEEDED']);
  const defaultNet =
    txType === 'CHARGE' && refundableStatuses.has(status)
      ? Math.max(0, amountVnd - refundedAmountVnd)
      : 0;
  const netRefundableVnd =
    typeof raw.netRefundableVnd === 'number'
      ? Math.max(0, Math.round(raw.netRefundableVnd))
      : defaultNet;

  return {
    id: String(raw.id ?? raw.transactionId ?? ''),
    orderId: String(raw.orderId ?? ''),
    orderCode: String(raw.orderCode ?? ''),
    provider: String(raw.provider ?? raw.method ?? 'VIETQR').toUpperCase(),
    txType,
    amountVnd,
    refundedAmountVnd,
    netRefundableVnd,
    status,
    providerTxId:
      typeof raw.providerTxId === 'string'
        ? raw.providerTxId
        : typeof raw.providerTransactionId === 'string'
          ? raw.providerTransactionId
          : null,
    signatureVerified: Boolean(raw.signatureVerified),
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    paidAt: typeof raw.paidAt === 'string' ? raw.paidAt : null,
    expiresAt: typeof raw.expiresAt === 'string' ? raw.expiresAt : null,
    refunds: rawRefunds,
  };
}

function normalizeWebhook(raw: Record<string, unknown>): WebhookLogRecord {
  const payloadCandidate =
    raw.payload ?? raw.rawPayload ?? raw.payloadJsonb ?? raw.payloadSummary ?? null;
  let parsedPayload: Record<string, unknown> | null = null;
  if (payloadCandidate && typeof payloadCandidate === 'object' && !Array.isArray(payloadCandidate)) {
    parsedPayload = payloadCandidate as Record<string, unknown>;
  } else if (typeof payloadCandidate === 'string') {
    try {
      const p = JSON.parse(payloadCandidate) as unknown;
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        parsedPayload = p as Record<string, unknown>;
      } else {
        parsedPayload = { raw: payloadCandidate };
      }
    } catch {
      parsedPayload = { raw: payloadCandidate };
    }
  }

  const sigValid =
    typeof raw.signatureValid === 'boolean'
      ? raw.signatureValid
      : typeof raw.hmacValid === 'boolean'
        ? raw.hmacValid
        : typeof raw.signatureVerified === 'boolean'
          ? raw.signatureVerified
          : true;

  return {
    id: String(raw.id ?? raw.eventId ?? raw.providerEventId ?? ''),
    provider: String(raw.provider ?? 'VIETQR').toUpperCase(),
    eventId: String(raw.eventId ?? raw.providerEventId ?? raw.id ?? '—'),
    orderCode:
      typeof raw.orderCode === 'string'
        ? raw.orderCode
        : typeof parsedPayload?.orderCode === 'string'
          ? parsedPayload.orderCode
          : null,
    transactionId:
      typeof raw.transactionId === 'string' ? raw.transactionId : null,
    signatureValid: sigValid,
    signatureHeader:
      typeof raw.signatureHeader === 'string'
        ? raw.signatureHeader
        : typeof raw.signature === 'string'
          ? raw.signature
          : null,
    status: String(raw.status ?? 'PROCESSED').toUpperCase(),
    httpStatus: typeof raw.httpStatus === 'number' ? raw.httpStatus : null,
    processedAt:
      typeof raw.processedAt === 'string'
        ? raw.processedAt
        : typeof raw.receivedAt === 'string'
          ? raw.receivedAt
          : null,
    createdAt: typeof raw.createdAt === 'string' ? raw.createdAt : null,
    payload: parsedPayload,
  };
}

const TX_STATUS_LABEL: Record<string, string> = {
  PENDING: 'Chờ thanh toán',
  SUCCEEDED: 'Thành công',
  LATE_SUCCEEDED: 'Thanh toán trễ (Cần hoàn)',
  REFUNDED: 'Đã hoàn tiền',
  FAILED: 'Thất bại',
  EXPIRED: 'Hết hạn QR',
};

export function PaymentLedgerTab({
  roles: rolesProp,
  session: sessionProp,
  darkMode = false,
  onNotify,
  onRefreshOverview,
}: PaymentLedgerTabProps) {
  const effectiveSession = sessionProp ?? getAdminSession();
  const roles = useMemo(
    () => rolesProp ?? effectiveSession?.user.roles ?? ([] as readonly Role[]),
    [rolesProp, effectiveSession],
  );

  const canRefund = useMemo(
    () =>
      roles.includes(Role.SUPER_ADMIN) ||
      hasAnyPermission(roles, [Permission.ORDER_REFUND_APPROVE]),
    [roles],
  );

  const notify = useCallback(
    (payload: PaymentLedgerNotifyPayload) => {
      if (onNotify) onNotify(payload);
      else emitPortalToast(payload);
    },
    [onNotify],
  );

  const [subTab, setSubTab] = useState<PaymentSubTab>('TRANSACTIONS');

  // Transactions state
  const [transactions, setTransactions] = useState<PaymentTransactionRecord[]>(
    [],
  );
  const [txPagination, setTxPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [txLoading, setTxLoading] = useState(true);
  const [txError, setTxError] = useState<string | null>(null);
  const [methodFilter, setMethodFilter] = useState<MethodFilter>('ALL');
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('ALL');
  const [orderSearch, setOrderSearch] = useState('');
  const [txPage, setTxPage] = useState(1);
  const [expandedTxId, setExpandedTxId] = useState<string | null>(null);

  // Webhooks state
  const [webhooks, setWebhooks] = useState<WebhookLogRecord[]>([]);
  const [whPagination, setWhPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [whLoading, setWhLoading] = useState(false);
  const [whError, setWhError] = useState<string | null>(null);
  const [whProvider, setWhProvider] = useState<string>('ALL');
  const [whSigFilter, setWhSigFilter] = useState<'ALL' | 'true' | 'false'>(
    'ALL',
  );
  const [whOrderSearch, setWhOrderSearch] = useState('');
  const [whPage, setWhPage] = useState(1);
  const [inspectedWebhook, setInspectedWebhook] =
    useState<WebhookLogRecord | null>(null);

  // Refund Modal state
  const [refundTarget, setRefundTarget] =
    useState<PaymentTransactionRecord | null>(null);
  const [refundAmountText, setRefundAmountText] = useState('');
  const [refundReason, setRefundReason] = useState('');
  const [refundRmaId, setRefundRmaId] = useState('');
  const [refundSubmitting, setRefundSubmitting] = useState(false);
  const [refundSubmitError, setRefundSubmitError] = useState<string | null>(
    null,
  );

  const loadTransactions = useCallback(async () => {
    setTxLoading(true);
    setTxError(null);
    const params = new URLSearchParams();
    params.set('page', String(txPage));
    params.set('limit', '20');
    if (methodFilter !== 'ALL') {
      params.set('method', methodFilter);
      params.set('provider', methodFilter);
    }
    if (statusFilter !== 'ALL') params.set('status', statusFilter);
    if (orderSearch.trim()) {
      params.set('orderCode', orderSearch.trim());
      params.set('q', orderSearch.trim());
    }

    const res = await adminFetch<unknown>(
      `/api/v1/admin/payments/transactions?${params.toString()}`,
    );
    if (res.ok) {
      const { items, pagination } = extractPaged<Record<string, unknown>>(
        res.data,
        ['items', 'transactions', 'list'],
        txPage,
        20,
      );
      setTransactions(items.map(normalizeTransaction));
      setTxPagination(pagination);
    } else {
      setTxError(
        res.error?.message ||
          'Chưa thể tải sổ cái giao dịch thanh toán từ payment-promo (:4007).',
      );
    }
    setTxLoading(false);
  }, [methodFilter, statusFilter, orderSearch, txPage]);

  const loadWebhooks = useCallback(async () => {
    setWhLoading(true);
    setWhError(null);
    const params = new URLSearchParams();
    params.set('page', String(whPage));
    params.set('limit', '20');
    if (whProvider !== 'ALL') params.set('provider', whProvider);
    if (whSigFilter !== 'ALL') params.set('signatureValid', whSigFilter);
    if (whOrderSearch.trim()) params.set('orderCode', whOrderSearch.trim());

    const res = await adminFetch<unknown>(
      `/api/v1/admin/payments/webhooks?${params.toString()}`,
    );
    if (res.ok) {
      const { items, pagination } = extractPaged<Record<string, unknown>>(
        res.data,
        ['items', 'webhooks', 'logs', 'list'],
        whPage,
        20,
      );
      setWebhooks(items.map(normalizeWebhook));
      setWhPagination(pagination);
    } else {
      setWhError(
        res.error?.message ||
          'Chưa thể tải nhật ký đối soát Webhook HMAC từ payment-promo (:4007).',
      );
    }
    setWhLoading(false);
  }, [whProvider, whSigFilter, whOrderSearch, whPage]);

  useEffect(() => {
    void loadTransactions();
  }, [loadTransactions]);

  useEffect(() => {
    if (subTab === 'WEBHOOKS') {
      void loadWebhooks();
    }
  }, [subTab, loadWebhooks]);

  const kpis = useMemo(() => {
    const chargeRows = transactions.filter((t) => t.txType !== 'REFUND');
    const totalCollected = chargeRows
      .filter((t) => t.status === 'SUCCEEDED' || t.status === 'LATE_SUCCEEDED')
      .reduce((acc, t) => acc + t.amountVnd, 0);
    const totalRefunded = chargeRows.reduce(
      (acc, t) => acc + t.refundedAmountVnd,
      0,
    );
    const totalNetRefundable = chargeRows.reduce(
      (acc, t) => acc + t.netRefundableVnd,
      0,
    );
    const lateCount = chargeRows.filter(
      (t) => t.status === 'LATE_SUCCEEDED',
    ).length;
    return { totalCollected, totalRefunded, totalNetRefundable, lateCount };
  }, [transactions]);

  const openRefundModal = (tx: PaymentTransactionRecord) => {
    setRefundTarget(tx);
    setRefundAmountText(String(tx.netRefundableVnd));
    setRefundReason(
      tx.status === 'LATE_SUCCEEDED'
        ? 'Hoàn tiền thanh toán trễ sau khi đơn hết hạn giữ chỗ'
        : '',
    );
    setRefundRmaId('');
    setRefundSubmitError(null);
  };

  const parsedRefundAmount = Number(refundAmountText);
  const refundValidationError = useMemo(() => {
    if (!refundTarget) return null;
    if (!refundAmountText.trim() || !Number.isFinite(parsedRefundAmount)) {
      return 'Vui lòng nhập số tiền hoàn hợp lệ.';
    }
    if (parsedRefundAmount <= 0) {
      return 'Số tiền hoàn phải lớn hơn 0₫.';
    }
    if (parsedRefundAmount > refundTarget.netRefundableVnd) {
      return `Số tiền hoàn (${FORMAT_VND(parsedRefundAmount)}) vượt quá số dư hoàn tối đa (${FORMAT_VND(refundTarget.netRefundableVnd)}).`;
    }
    if (!refundReason.trim()) {
      return 'Vui lòng nhập lý do hoàn tiền để lưu nhật ký kiểm toán.';
    }
    return null;
  }, [refundTarget, refundAmountText, parsedRefundAmount, refundReason]);

  const handleSubmitRefund = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!refundTarget || refundValidationError || !canRefund) return;

    setRefundSubmitting(true);
    setRefundSubmitError(null);

    const idempotencyKey = `adm-ref-${refundTarget.orderCode}-${Date.now()}`;
    const res = await adminFetch<unknown>('/api/v1/admin/payments/refunds', {
      method: 'POST',
      headers: {
        'idempotency-key': idempotencyKey,
      },
      body: JSON.stringify({
        orderId: refundTarget.orderId || refundTarget.orderCode,
        orderCode: refundTarget.orderCode,
        transactionId: refundTarget.id,
        amountVnd: Math.round(parsedRefundAmount),
        reason: refundReason.trim(),
        ...(refundRmaId.trim() ? { rmaId: refundRmaId.trim() } : {}),
        idempotencyKey,
      }),
    });

    setRefundSubmitting(false);
    if (res.ok) {
      notify({
        kind: 'success',
        title: 'HOÀN TIỀN THÀNH CÔNG',
        message: `Đã hoàn ${FORMAT_VND(parsedRefundAmount)} cho đơn ${refundTarget.orderCode} và ghi audit_logs.`,
      });
      setRefundTarget(null);
      await loadTransactions();
      onRefreshOverview?.();
    } else {
      setRefundSubmitError(
        res.error?.message ||
          'Yêu cầu hoàn tiền thất bại. Kiểm tra lại số dư hoặc quyền ORDER_REFUND_APPROVE.',
      );
    }
  };

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const secondaryCls = darkMode ? 'text-[#DFD2C2]' : 'text-[#5C4B41]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] placeholder:text-[#8E7D6B] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const getStatusCls = (status: string): string => {
    if (status === 'SUCCEEDED' || status === 'PROCESSED') {
      return darkMode
        ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
        : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
    }
    if (status === 'LATE_SUCCEEDED' || status === 'FAILED') {
      return darkMode
        ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
        : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]';
    }
    if (status === 'REFUNDED') {
      return darkMode
        ? 'border-[#EBCF8F]/45 bg-[#332515] text-[#EBCF8F]'
        : 'border-[#B08A4A]/50 bg-[#F4EBDA] text-[#7A5922]';
    }
    return darkMode
      ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'
      : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
  };

  return (
    <div data-testid="payment-ledger-tab" className="space-y-6">
      {/* Header & KPI Strip */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Payment Reconciliation Ledger · HMAC-SHA256 Webhook Verification
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Sổ Cái Thanh toán, Hoàn tiền &amp; Đối soát Webhook
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Theo dõi giao dịch VietQR / VNPay / MoMo / COD, thực hiện hoàn tiền
              một phần hoặc toàn phần trong hạn mức <code>netRefundableVnd</code>{' '}
              và kiểm định chữ ký HMAC bảng <code>processed_webhooks</code>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={() =>
                subTab === 'TRANSACTIONS'
                  ? void loadTransactions()
                  : void loadWebhooks()
              }
              className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
              }`}
            >
              Làm mới sổ cái
            </button>
          </div>
        </div>

        {/* Sub-tab Switcher */}
        <div className="mt-5 flex flex-wrap gap-2">
          <button
            type="button"
            data-testid="payment-subtab-transactions"
            onClick={() => setSubTab('TRANSACTIONS')}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
              subTab === 'TRANSACTIONS'
                ? darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
                : darkMode
                  ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
            }`}
          >
            Sổ Cái Giao dịch &amp; Hoàn tiền ({txPagination.total})
          </button>
          <button
            type="button"
            data-testid="payment-subtab-webhooks"
            onClick={() => setSubTab('WEBHOOKS')}
            className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
              subTab === 'WEBHOOKS'
                ? darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410]'
                  : 'bg-[#1C1410] text-[#EBCF8F]'
                : darkMode
                  ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2]'
                  : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
            }`}
          >
            Nhật ký Đối soát Webhook HMAC (processed_webhooks)
          </button>
        </div>

        {/* KPI Cards */}
        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Thực thu trên trang
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-2xl font-semibold">
              {FORMAT_VND(kpis.totalCollected)}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Giao dịch SUCCEEDED &amp; LATE_SUCCEEDED
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng đã hoàn tiền
            </p>
            <p className={`adm-tabular mt-1.5 font-mono text-2xl font-semibold ${goldTextCls}`}>
              {FORMAT_VND(kpis.totalRefunded)}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Bao gồm hoàn một phần &amp; hoàn toàn bộ
            </p>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Số dư có thể hoàn (netRefundable)
            </p>
            <p
              className={`adm-tabular mt-1.5 font-mono text-2xl font-semibold ${
                darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'
              }`}
            >
              {FORMAT_VND(kpis.totalNetRefundable)}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              Khóa trần chống hoàn vượt số tiền
            </p>
          </div>

          <div
            className={`rounded-2xl border p-4 ${
              kpis.lateCount > 0
                ? darkMode
                  ? 'border-rose-500/45 bg-rose-950/35 text-[#FBF7EF]'
                  : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#1C1410]'
                : subCardCls
            }`}
          >
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Cảnh báo Thanh toán trễ
            </p>
            <p className="adm-tabular mt-1.5 font-mono text-2xl font-semibold">
              {kpis.lateCount}
            </p>
            <p className={`mt-1 text-[11px] ${secondaryCls}`}>
              {kpis.lateCount > 0
                ? 'Cần kiểm tra hoàn tiền cho khách'
                : 'Không có giao dịch thanh toán trễ'}
            </p>
          </div>
        </div>
      </section>

      {/* SUB-TAB A: Transactions & Refunds */}
      {subTab === 'TRANSACTIONS' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div className="flex flex-wrap items-center gap-1.5">
              {(['ALL', 'VIETQR', 'VNPAY', 'MOMO', 'COD'] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  onClick={() => {
                    setMethodFilter(m);
                    setTxPage(1);
                  }}
                  className={`rounded-full px-3 py-1 font-mono text-[11px] transition-colors ${
                    methodFilter === m
                      ? darkMode
                        ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                        : 'bg-[#1C1410] text-[#EBCF8F] font-semibold'
                      : darkMode
                        ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                        : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                  }`}
                >
                  {m === 'ALL' ? 'Mọi cổng TT' : m}
                </button>
              ))}
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <select
                value={statusFilter}
                onChange={(e) => {
                  setStatusFilter(e.target.value as StatusFilter);
                  setTxPage(1);
                }}
                aria-label="Lọc trạng thái giao dịch"
                className={`rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
              >
                <option value="ALL">Mọi trạng thái</option>
                <option value="SUCCEEDED">SUCCEEDED · Thành công</option>
                <option value="LATE_SUCCEEDED">LATE_SUCCEEDED · Thanh toán trễ</option>
                <option value="PENDING">PENDING · Chờ thanh toán</option>
                <option value="REFUNDED">REFUNDED · Đã hoàn tiền</option>
                <option value="FAILED">FAILED · Thất bại</option>
                <option value="EXPIRED">EXPIRED · Hết hạn</option>
              </select>

              <input
                type="search"
                value={orderSearch}
                onChange={(e) => {
                  setOrderSearch(e.target.value);
                  setTxPage(1);
                }}
                placeholder="Tìm mã đơn (VD: TX-2026...)"
                className={`w-56 rounded-full border px-3.5 py-1.5 font-mono text-xs outline-none ${inputCls}`}
              />
            </div>
          </div>

          {txError ? (
            <div className="p-6 text-xs text-[#8B2E2E] dark:text-rose-300">
              {txError}
            </div>
          ) : txLoading ? (
            <div className={`p-8 text-center text-xs ${mutedCls}`}>
              Đang tải sổ cái giao dịch thanh toán...
            </div>
          ) : transactions.length === 0 ? (
            <div className={`p-10 text-center text-xs ${mutedCls}`}>
              Chưa có giao dịch thanh toán nào khớp bộ lọc.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                  <tr>
                    <th className="px-5 py-3">Đơn hàng &amp; Mã GD</th>
                    <th className="px-4 py-3">Cổng / Loại</th>
                    <th className="px-4 py-3 text-right">Số tiền gốc</th>
                    <th className="px-4 py-3 text-right">Đã hoàn</th>
                    <th className="px-4 py-3 text-right">Khả hoàn (Net)</th>
                    <th className="px-4 py-3">Trạng thái</th>
                    <th className="px-4 py-3">Thời gian</th>
                    <th className="px-5 py-3 text-right">Thao tác</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/15">
                  {transactions.map((tx) => {
                    const isExpanded = expandedTxId === tx.id;
                    const canInitiateRefund =
                      canRefund &&
                      tx.txType !== 'REFUND' &&
                      tx.netRefundableVnd > 0;

                    return (
                      <tr key={tx.id} className={rowHoverCls}>
                        <td className="px-5 py-3.5 align-top">
                          <p className="font-mono text-xs font-semibold">
                            {tx.orderCode}
                          </p>
                          <p className={`mt-0.5 font-mono text-[10px] ${mutedCls}`}>
                            {tx.providerTxId || tx.id.slice(0, 14)}
                          </p>
                          {tx.refunds.length > 0 ? (
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedTxId(isExpanded ? null : tx.id)
                              }
                              className={`mt-1 text-[10.5px] font-medium underline ${goldTextCls}`}
                            >
                              {isExpanded
                                ? 'Ẩn lịch sử hoàn tiền'
                                : `Xem ${tx.refunds.length} giao dịch hoàn tiền`}
                            </button>
                          ) : null}

                          {isExpanded && tx.refunds.length > 0 ? (
                            <div
                              className={`mt-2 space-y-1.5 rounded-xl border p-2.5 text-[11px] ${subCardCls}`}
                            >
                              {tx.refunds.map((rf) => (
                                <div
                                  key={rf.id}
                                  className="flex flex-wrap items-center justify-between gap-2 border-b border-[#B08A4A]/15 pb-1 last:border-b-0 last:pb-0"
                                >
                                  <div>
                                    <span className="font-mono font-semibold">
                                      -{FORMAT_VND(rf.amountVnd)}
                                    </span>{' '}
                                    <span className={mutedCls}>
                                      · {rf.reason || 'Hoàn tiền vận hành'}
                                    </span>
                                  </div>
                                  <span className="font-mono text-[10px]">
                                    {formatDateTime(rf.createdAt)}
                                  </span>
                                </div>
                              ))}
                            </div>
                          ) : null}
                        </td>

                        <td className="px-4 py-3.5 align-top">
                          <span className="rounded-md bg-[#1C1410] px-2 py-0.5 font-mono text-[10.5px] font-semibold text-[#EBCF8F]">
                            {tx.provider}
                          </span>
                          <p className={`mt-1 font-mono text-[10px] ${mutedCls}`}>
                            {tx.txType}
                          </p>
                        </td>

                        <td className="adm-tabular px-4 py-3.5 text-right align-top font-mono font-semibold">
                          {FORMAT_VND(tx.amountVnd)}
                        </td>

                        <td className={`adm-tabular px-4 py-3.5 text-right align-top font-mono ${goldTextCls}`}>
                          {tx.refundedAmountVnd > 0
                            ? FORMAT_VND(tx.refundedAmountVnd)
                            : '0₫'}
                        </td>

                        <td
                          className={`adm-tabular px-4 py-3.5 text-right align-top font-mono font-semibold ${
                            tx.netRefundableVnd > 0
                              ? darkMode
                                ? 'text-emerald-300'
                                : 'text-[#1E4B32]'
                              : mutedCls
                          }`}
                        >
                          {FORMAT_VND(tx.netRefundableVnd)}
                        </td>

                        <td className="px-4 py-3.5 align-top">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getStatusCls(tx.status)}`}
                          >
                            {TX_STATUS_LABEL[tx.status] ?? tx.status}
                          </span>
                        </td>

                        <td className={`px-4 py-3.5 align-top font-mono text-[10.5px] ${mutedCls}`}>
                          <p>{formatDateTime(tx.paidAt || tx.createdAt)}</p>
                        </td>

                        <td className="px-5 py-3.5 text-right align-top">
                          {canInitiateRefund ? (
                            <button
                              type="button"
                              data-testid={`payment-refund-btn-${tx.orderCode}`}
                              onClick={() => openRefundModal(tx)}
                              className="rounded-full border border-[#8B2E2E]/55 bg-[#FFF5F4] px-3.5 py-1.5 text-[11px] font-medium text-[#8B2E2E] transition-colors hover:bg-[#8B2E2E] hover:text-white dark:bg-rose-950/60 dark:text-rose-200"
                            >
                              Hoàn tiền
                            </button>
                          ) : (
                            <span className={`font-mono text-[10px] ${mutedCls}`}>
                              {tx.netRefundableVnd <= 0 ? 'Hết hạn mức' : 'Chỉ đọc'}
                            </span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {/* Pagination Footer */}
          <div className="flex items-center justify-between border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Trang {txPagination.page} / {txPagination.totalPages} · Tổng{' '}
              {txPagination.total} giao dịch
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={txPage <= 1 || txLoading}
                onClick={() => setTxPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={txPage >= txPagination.totalPages || txLoading}
                onClick={() => setTxPage((p) => p + 1)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* SUB-TAB B: HMAC Webhook Reconciliation Logs */}
      {subTab === 'WEBHOOKS' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={whProvider}
                onChange={(e) => {
                  setWhProvider(e.target.value);
                  setWhPage(1);
                }}
                aria-label="Lọc cổng webhook"
                className={`rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
              >
                <option value="ALL">Mọi cổng Webhook</option>
                <option value="VIETQR">VIETQR</option>
                <option value="VNPAY">VNPAY</option>
                <option value="MOMO">MOMO</option>
              </select>

              <select
                value={whSigFilter}
                onChange={(e) => {
                  setWhSigFilter(e.target.value as 'ALL' | 'true' | 'false');
                  setWhPage(1);
                }}
                aria-label="Lọc trạng thái chữ ký HMAC"
                className={`rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
              >
                <option value="ALL">Tất cả chữ ký HMAC</option>
                <option value="true">HMAC Hợp lệ (Verified)</option>
                <option value="false">HMAC Không hợp lệ (Rejected)</option>
              </select>
            </div>

            <input
              type="search"
              value={whOrderSearch}
              onChange={(e) => {
                setWhOrderSearch(e.target.value);
                setWhPage(1);
              }}
              placeholder="Lọc theo mã đơn orderCode..."
              className={`w-56 rounded-full border px-3.5 py-1.5 font-mono text-xs outline-none ${inputCls}`}
            />
          </div>

          {whError ? (
            <div className="p-6 text-xs text-[#8B2E2E] dark:text-rose-300">
              {whError}
            </div>
          ) : whLoading ? (
            <div className={`p-8 text-center text-xs ${mutedCls}`}>
              Đang tải nhật ký đối soát Webhook HMAC (processed_webhooks)...
            </div>
          ) : webhooks.length === 0 ? (
            <div className={`p-10 text-center text-xs ${mutedCls}`}>
              Chưa ghi nhận nhật ký Webhook HMAC nào khớp bộ lọc.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                  <tr>
                    <th className="px-5 py-3">Cổng &amp; Event ID</th>
                    <th className="px-4 py-3">Mã đơn</th>
                    <th className="px-4 py-3">Xác thực HMAC-SHA256</th>
                    <th className="px-4 py-3">Trạng thái xử lý</th>
                    <th className="px-4 py-3">Thời gian nhận</th>
                    <th className="px-5 py-3 text-right">Payload</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/15">
                  {webhooks.map((wh) => (
                    <tr key={`${wh.id}-${wh.eventId}`} className={rowHoverCls}>
                      <td className="px-5 py-3.5">
                        <span className="rounded-md bg-[#1C1410] px-2 py-0.5 font-mono text-[10px] font-semibold text-[#EBCF8F]">
                          {wh.provider}
                        </span>
                        <p className="mt-1 font-mono text-[11px] font-medium">
                          {wh.eventId}
                        </p>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-xs">
                        {wh.orderCode || '—'}
                      </td>
                      <td className="px-4 py-3.5">
                        <span
                          className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                            wh.signatureValid
                              ? darkMode
                                ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
                                : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]'
                              : darkMode
                                ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
                                : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]'
                          }`}
                        >
                          <span
                            className={`h-1.5 w-1.5 rounded-full ${
                              wh.signatureValid ? 'bg-emerald-500' : 'bg-rose-500'
                            }`}
                          />
                          {wh.signatureValid ? 'HMAC Hợp lệ' : 'HMAC Sai / Từ chối'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 font-mono text-[11px]">
                        {wh.status}
                        {wh.httpStatus ? ` (HTTP ${wh.httpStatus})` : ''}
                      </td>
                      <td className={`px-4 py-3.5 font-mono text-[10.5px] ${mutedCls}`}>
                        {formatDateTime(wh.processedAt || wh.createdAt)}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        <button
                          type="button"
                          onClick={() => setInspectedWebhook(wh)}
                          className={`rounded-full border px-3 py-1 text-[11px] ${
                            darkMode
                              ? 'border-[#B08A4A]/40 text-[#EBCF8F] hover:bg-[#2A1E17]'
                              : 'border-[#B08A4A]/45 text-[#5C4B41] hover:bg-[#F4EBDA]'
                          }`}
                        >
                          Soi Payload
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}

          <div className="flex items-center justify-between border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Trang {whPagination.page} / {whPagination.totalPages} · Tổng{' '}
              {whPagination.total} sự kiện webhook
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={whPage <= 1 || whLoading}
                onClick={() => setWhPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={whPage >= whPagination.totalPages || whLoading}
                onClick={() => setWhPage((p) => p + 1)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* Partial / Full Refund Modal */}
      {refundTarget ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xử lý Hoàn tiền giao dịch"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <form
            onSubmit={handleSubmitRefund}
            className={`w-full max-w-lg rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Partial / Full Refund · Idempotent Ledger
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Hoàn tiền đơn {refundTarget.orderCode}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className={`mt-4 grid grid-cols-3 gap-2.5 rounded-2xl border p-3.5 text-xs ${subCardCls}`}>
              <div>
                <span className={`block text-[10px] uppercase ${mutedCls}`}>
                  Gốc đã thu
                </span>
                <strong className="adm-tabular font-mono text-sm">
                  {FORMAT_VND(refundTarget.amountVnd)}
                </strong>
              </div>
              <div>
                <span className={`block text-[10px] uppercase ${mutedCls}`}>
                  Đã hoàn
                </span>
                <strong className={`adm-tabular font-mono text-sm ${goldTextCls}`}>
                  {FORMAT_VND(refundTarget.refundedAmountVnd)}
                </strong>
              </div>
              <div>
                <span className={`block text-[10px] uppercase ${mutedCls}`}>
                  Khả hoàn tối đa
                </span>
                <strong
                  className={`adm-tabular font-mono text-sm ${
                    darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'
                  }`}
                >
                  {FORMAT_VND(refundTarget.netRefundableVnd)}
                </strong>
              </div>
            </div>

            <div className="mt-4 space-y-3.5">
              <div>
                <div className="flex items-center justify-between">
                  <label className={`text-xs ${secondaryCls}`} htmlFor="refund-amount-input">
                    Số tiền hoàn (VND) *
                  </label>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() =>
                        setRefundAmountText(String(refundTarget.netRefundableVnd))
                      }
                      className="rounded-full border border-[#B08A4A]/40 px-2.5 py-0.5 text-[10px]"
                    >
                      Hoàn 100%
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        setRefundAmountText(
                          String(Math.max(1, Math.floor(refundTarget.netRefundableVnd / 2))),
                        )
                      }
                      className="rounded-full border border-[#B08A4A]/40 px-2.5 py-0.5 text-[10px]"
                    >
                      Hoàn 50%
                    </button>
                  </div>
                </div>
                <input
                  id="refund-amount-input"
                  data-testid="refund-amount-input"
                  type="number"
                  min={1}
                  max={refundTarget.netRefundableVnd}
                  required
                  value={refundAmountText}
                  onChange={(e) => setRefundAmountText(e.target.value)}
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-sm outline-none ${inputCls}`}
                />
              </div>

              <label className="block text-xs">
                <span className={secondaryCls}>Lý do hoàn tiền (bắt buộc) *</span>
                <textarea
                  data-testid="refund-reason-input"
                  rows={3}
                  required
                  value={refundReason}
                  onChange={(e) => setRefundReason(e.target.value)}
                  placeholder="VD: Khách hoàn trả 1 sản phẩm theo yêu cầu RMA hoặc thanh toán trễ sau khi hết giữ chỗ..."
                  className={`mt-1 w-full rounded-xl border px-3 py-2 text-xs outline-none ${inputCls}`}
                />
              </label>

              <label className="block text-xs">
                <span className={secondaryCls}>Mã RMA liên kết (tùy chọn)</span>
                <input
                  type="text"
                  value={refundRmaId}
                  onChange={(e) => setRefundRmaId(e.target.value)}
                  placeholder="UUID phiếu RMA nếu hoàn theo đổi trả"
                  className={`mt-1 w-full rounded-xl border px-3 py-2 font-mono text-xs outline-none ${inputCls}`}
                />
              </label>

              {refundValidationError ? (
                <p
                  role="alert"
                  data-testid="refund-validation-error"
                  className="rounded-xl border border-[#8B2E2E]/40 bg-[#FFF5F4] px-3 py-2 text-xs text-[#8B2E2E]"
                >
                  {refundValidationError}
                </p>
              ) : null}

              {refundSubmitError ? (
                <p
                  role="alert"
                  className="rounded-xl border border-[#8B2E2E]/40 bg-[#FFF5F4] px-3 py-2 text-xs text-[#8B2E2E]"
                >
                  {refundSubmitError}
                </p>
              ) : null}
            </div>

            <div className="mt-6 flex justify-end gap-2.5 border-t border-[#B08A4A]/20 pt-4">
              <button
                type="button"
                onClick={() => setRefundTarget(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs"
              >
                Hủy
              </button>
              <button
                type="submit"
                data-testid="refund-confirm-submit-btn"
                disabled={Boolean(refundValidationError) || refundSubmitting}
                className="rounded-full bg-[#8B2E2E] px-6 py-2 text-xs font-semibold uppercase tracking-[0.14em] text-white disabled:cursor-not-allowed disabled:opacity-45"
              >
                {refundSubmitting ? 'Đang xử lý hoàn tiền...' : 'Xác nhận hoàn tiền'}
              </button>
            </div>
          </form>
        </div>
      ) : null}

      {/* Webhook Payload Inspector Modal */}
      {inspectedWebhook ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Chi tiết Webhook HMAC Payload"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#0D0805]/65 p-4 backdrop-blur-xs"
        >
          <div
            className={`max-h-[85vh] w-full max-w-2xl overflow-y-auto rounded-3xl border p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  processed_webhooks · HMAC Payload Inspector
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  {inspectedWebhook.provider} · {inspectedWebhook.eventId}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setInspectedWebhook(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            <div className={`mt-4 grid gap-2 rounded-2xl border p-3.5 font-mono text-[11px] sm:grid-cols-2 ${subCardCls}`}>
              <div>
                <span className={mutedCls}>HMAC Verification: </span>
                <strong
                  className={
                    inspectedWebhook.signatureValid
                      ? 'text-emerald-600 dark:text-emerald-300'
                      : 'text-rose-600 dark:text-rose-300'
                  }
                >
                  {inspectedWebhook.signatureValid ? 'VALID' : 'INVALID'}
                </strong>
              </div>
              <div>
                <span className={mutedCls}>Order Code: </span>
                <strong>{inspectedWebhook.orderCode || '—'}</strong>
              </div>
              <div>
                <span className={mutedCls}>Status: </span>
                <strong>{inspectedWebhook.status}</strong>
              </div>
              <div>
                <span className={mutedCls}>Processed At: </span>
                <strong>
                  {formatDateTime(
                    inspectedWebhook.processedAt || inspectedWebhook.createdAt,
                  )}
                </strong>
              </div>
              {inspectedWebhook.signatureHeader ? (
                <div className="sm:col-span-2 break-all">
                  <span className={mutedCls}>Signature: </span>
                  <code>{inspectedWebhook.signatureHeader}</code>
                </div>
              ) : null}
            </div>

            <div className="mt-4">
              <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
                JSON Payload
              </p>
              <pre className="mt-1.5 max-h-80 overflow-auto rounded-2xl border border-[#B08A4A]/30 bg-[#140E0A] p-4 font-mono text-[11px] leading-relaxed text-[#EBCF8F]">
                {JSON.stringify(
                  inspectedWebhook.payload ?? {
                    eventId: inspectedWebhook.eventId,
                    provider: inspectedWebhook.provider,
                    orderCode: inspectedWebhook.orderCode,
                    status: inspectedWebhook.status,
                  },
                  null,
                  2,
                )}
              </pre>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
