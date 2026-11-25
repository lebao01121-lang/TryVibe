'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { apiFetch } from '@/lib/api-client';
import { FORMAT_VND } from '@/lib/catalog-data';
import { refreshCartCount } from '@/lib/storefront-actions';

const PENDING_PAYMENT_STORAGE_KEY = 'atelier_pending_payment_v1';

interface PendingPaymentContext {
  orderId?: string;
  orderCode?: string;
  provider?: string;
  amountVnd?: number;
  createdAt?: string;
}

interface PaymentReturnVerificationResult {
  verified: boolean;
  paid: boolean;
  status: string;
  orderCode: string | null;
  provider: string | null;
  amountVnd: number | null;
  message: string;
  responseCode: string | null;
  transactionId?: string | null;
  orderStatus?: string | null;
}

function readPendingPaymentContext(): PendingPaymentContext | null {
  if (typeof window === 'undefined') {
    return null;
  }
  try {
    const raw = window.sessionStorage.getItem(PENDING_PAYMENT_STORAGE_KEY);
    if (!raw) {
      return null;
    }
    const parsed = JSON.parse(raw) as PendingPaymentContext;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function clearPendingPaymentContext(): void {
  if (typeof window === 'undefined') {
    return;
  }
  try {
    window.sessionStorage.removeItem(PENDING_PAYMENT_STORAGE_KEY);
  } catch {
    // Ignore storage access errors
  }
}

function formatProviderLabel(provider: string | null | undefined): string {
  switch ((provider || '').toUpperCase()) {
    case 'VNPAY':
      return 'VNPay (ATM / QR / Thẻ Quốc tế)';
    case 'MOMO':
      return 'Ví điện tử MoMo';
    case 'VIETQR':
    case 'PAYOS':
      return 'VietQR · PayOS';
    default:
      return provider || 'Cổng thanh toán Atelier';
  }
}

export function PaymentResultClient() {
  const searchParams = useSearchParams();
  const queryString = searchParams.toString();

  const [pendingContext, setPendingContext] = useState<PendingPaymentContext | null>(null);
  const [loading, setLoading] = useState(true);
  const [result, setResult] = useState<PaymentReturnVerificationResult | null>(null);
  const [networkError, setNetworkError] = useState<string | null>(null);

  const verifyReturn = useCallback(async () => {
    setLoading(true);
    setNetworkError(null);

    const saved = readPendingPaymentContext();
    setPendingContext(saved);

    let effectiveQs = queryString;
    if (!effectiveQs && saved?.orderCode) {
      const fallback = new URLSearchParams({
        orderCode: saved.orderCode,
        ...(saved.provider ? { provider: saved.provider } : {}),
      });
      effectiveQs = fallback.toString();
    }

    if (!effectiveQs) {
      setResult({
        verified: false,
        paid: false,
        status: 'INVALID_REQUEST',
        orderCode: null,
        provider: null,
        amountVnd: null,
        message:
          'Không tìm thấy tham số xác thực thanh toán từ cổng giao dịch. Vui lòng kiểm tra lại đơn hàng của bạn.',
        responseCode: 'MISSING_PARAMS',
      });
      setLoading(false);
      return;
    }

    const res = await apiFetch<PaymentReturnVerificationResult>(
      `/bff/v1/storefront/payments/return?${effectiveQs}`,
      { skipAuthRefresh: true, timeoutMs: 15_000 },
    );

    setLoading(false);

    if (!res.ok || !res.data) {
      setNetworkError(
        res.error?.message ||
          'Không thể kết nối máy chủ đối soát thanh toán lúc này. Vui lòng thử kiểm tra lại sau giây lát.',
      );
      return;
    }

    setResult(res.data);
    if (res.data.verified && res.data.paid) {
      clearPendingPaymentContext();
      refreshCartCount();
    }
  }, [queryString]);

  useEffect(() => {
    void verifyReturn();
  }, [verifyReturn]);

  const resolvedOrderCode =
    result?.orderCode ??
    searchParams.get('vnp_TxnRef') ??
    searchParams.get('orderId') ??
    searchParams.get('orderCode') ??
    pendingContext?.orderCode ??
    null;

  const resolvedAmountVnd = useMemo(() => {
    if (typeof result?.amountVnd === 'number' && result.amountVnd >= 0) {
      return result.amountVnd;
    }
    if (typeof pendingContext?.amountVnd === 'number' && pendingContext.amountVnd >= 0) {
      return pendingContext.amountVnd;
    }
    return null;
  }, [pendingContext?.amountVnd, result?.amountVnd]);

  const resolvedProvider = result?.provider ?? pendingContext?.provider ?? null;

  const visualState: 'LOADING' | 'SUCCESS' | 'PENDING' | 'FAILED' = useMemo(() => {
    if (loading) return 'LOADING';
    if (networkError || !result) return 'FAILED';
    if (result.verified && result.paid) return 'SUCCESS';
    if (result.verified && result.status.toUpperCase() === 'PENDING') return 'PENDING';
    return 'FAILED';
  }, [loading, networkError, result]);

  return (
    <div className="mx-auto max-w-3xl px-4 py-12 sm:px-6 lg:px-10 lg:py-16">
      <div className="rounded-[28px] border border-[#B08A4A]/35 bg-[#FBF7EF] p-7 shadow-xl sm:p-10">
        {visualState === 'LOADING' ? (
          <div className="py-12 text-center">
            <div className="mx-auto h-12 w-12 animate-spin rounded-full border-2 border-[#B08A4A]/30 border-t-[#8A672C]" />
            <p className="eyebrow mt-6 text-[#8A672C]">Đang xác thực chữ ký HMAC</p>
            <h1 className="mt-2 font-editorial text-3xl font-light text-[#1C1410] sm:text-4xl">
              Đang đối soát kết quả thanh toán
            </h1>
            <p className="mt-3 text-sm text-[#6B5B4C]">
              Hệ thống TryVibe Atelier đang xác minh chữ ký số và đồng bộ trạng thái đơn hàng
              của bạn…
            </p>
          </div>
        ) : (
          <>
            <div className="flex flex-wrap items-start justify-between gap-4 border-b border-[#B08A4A]/25 pb-6">
              <div>
                <p className="eyebrow text-[#8A672C]">
                  {visualState === 'SUCCESS'
                    ? 'Xác thực chữ ký số thành công'
                    : visualState === 'PENDING'
                      ? 'Đang chờ xác nhận từ ngân hàng'
                      : 'Cảnh báo đối soát thanh toán'}
                </p>
                <h1 className="mt-2 font-editorial text-3xl font-light text-[#1C1410] sm:text-4xl">
                  {visualState === 'SUCCESS'
                    ? 'Thanh toán thành công'
                    : visualState === 'PENDING'
                      ? 'Đang chờ đối soát giao dịch'
                      : result?.verified && result.status.toUpperCase() === 'CANCELLED'
                        ? 'Giao dịch đã được hủy'
                        : 'Thanh toán thất bại hoặc chữ ký không hợp lệ'}
                </h1>
              </div>

              <span
                data-testid="payment-result-status-badge"
                className={`inline-flex items-center rounded-full border px-4 py-1.5 text-xs font-medium tracking-[0.14em] uppercase ${
                  visualState === 'SUCCESS'
                    ? 'border-emerald-700/30 bg-emerald-50 text-emerald-900'
                    : visualState === 'PENDING'
                      ? 'border-[#B08A4A]/50 bg-[#F4EBDA] text-[#5C431C]'
                      : 'border-red-700/30 bg-red-50 text-red-900'
                }`}
              >
                {visualState === 'SUCCESS'
                  ? 'Đã thanh toán'
                  : visualState === 'PENDING'
                    ? 'Chờ đối soát'
                    : result?.status === 'SIGNATURE_INVALID'
                      ? 'Chữ ký không hợp lệ'
                      : 'Chưa hoàn tất'}
              </span>
            </div>

            <div
              role="status"
              className={`mt-6 rounded-2xl border p-4 text-sm leading-relaxed ${
                visualState === 'SUCCESS'
                  ? 'border-emerald-300/70 bg-emerald-50/70 text-emerald-950'
                  : visualState === 'PENDING'
                    ? 'border-[#B08A4A]/40 bg-[#F4EBDA]/75 text-[#3B2E25]'
                    : 'border-red-300/80 bg-red-50/80 text-red-950'
              }`}
            >
              {networkError ||
                result?.message ||
                'Không thể xác thực trạng thái thanh toán lúc này.'}
            </div>

            <dl className="mt-6 grid gap-3 rounded-2xl border border-[#B08A4A]/25 bg-white/90 p-5 text-sm sm:grid-cols-2">
              <div className="space-y-1">
                <dt className="text-[11px] uppercase tracking-[0.18em] text-[#7A6A5B]">
                  Mã đơn hàng
                </dt>
                <dd
                  data-testid="payment-result-order-code"
                  className="font-mono text-base font-semibold text-[#1C1410]"
                >
                  {resolvedOrderCode ? `#${resolvedOrderCode}` : 'Chưa xác định'}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] uppercase tracking-[0.18em] text-[#7A6A5B]">
                  Số tiền giao dịch
                </dt>
                <dd className="font-editorial text-2xl font-medium text-[#1C1410]">
                  {resolvedAmountVnd !== null ? FORMAT_VND(resolvedAmountVnd) : '—'}
                </dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] uppercase tracking-[0.18em] text-[#7A6A5B]">
                  Cổng thanh toán
                </dt>
                <dd className="text-[#2B2019]">{formatProviderLabel(resolvedProvider)}</dd>
              </div>

              <div className="space-y-1">
                <dt className="text-[11px] uppercase tracking-[0.18em] text-[#7A6A5B]">
                  Trạng thái xác thực
                </dt>
                <dd className="font-mono text-xs text-[#5A4A3E]">
                  {result
                    ? `${result.verified ? 'VERIFIED' : 'UNVERIFIED'} · ${result.status}${result.responseCode ? ` (${result.responseCode})` : ''}`
                    : 'ERROR'}
                </dd>
              </div>
            </dl>

            <div className="mt-8 flex flex-wrap items-center gap-3">
              {resolvedOrderCode ? (
                <Link
                  href={`/don-hang/${encodeURIComponent(resolvedOrderCode)}`}
                  className="btn btn--gold !px-6 !py-3 !text-xs"
                >
                  Theo dõi đơn hàng #{resolvedOrderCode}
                </Link>
              ) : null}

              {visualState === 'PENDING' || networkError ? (
                <button
                  type="button"
                  onClick={() => void verifyReturn()}
                  className="rounded-full border border-[#8A672C]/50 bg-[#F4EBDA] px-5 py-3 text-xs font-medium uppercase tracking-[0.14em] text-[#5C431C] transition-colors hover:bg-[#EBCF8F]"
                >
                  Kiểm tra lại trạng thái
                </button>
              ) : null}

              {visualState !== 'SUCCESS' ? (
                <Link
                  href="/thanh-toan"
                  className="btn btn--line !px-6 !py-3 !text-xs"
                >
                  Quay lại trang thanh toán
                </Link>
              ) : (
                <Link
                  href="/bo-suu-tap"
                  className="btn btn--line !px-6 !py-3 !text-xs"
                >
                  Khám phá Bộ sưu tập
                </Link>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
