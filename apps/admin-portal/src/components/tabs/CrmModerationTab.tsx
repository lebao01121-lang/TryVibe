'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FitFeedback,
  LoyaltyTier,
  NotificationChannel,
  OrderStatus,
  Permission,
  ReviewModerationStatus,
  hasAnyPermission,
  hasPermission,
  type AdminCustomerSummaryDto,
  type NotificationLogDto,
  type OrderDTO,
  type RmaRequestDTO,
  type Role,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import {
  adminFetch,
  buildQueryString,
  extractList,
  extractPaginatedList,
  type PaginationMeta,
} from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface CrmModerationTabProps {
  roles: readonly Role[];
  darkMode?: boolean;
  onRefreshOverview?: () => void;
}

type CrmSubTab = 'customers' | 'reviews' | 'notifications';
type SentimentFilter = 'ALL' | 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type HiddenFilter = 'ALL' | 'VISIBLE' | 'HIDDEN';

interface ExtendedAdminReview extends VerifiedReviewDto {
  productName?: string;
  productSlug?: string;
  diemCamXucNlp?: number | null;
}

const FORMAT_VND = (amount: number): string =>
  `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return 'KH';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function resolveReviewSentiment(
  rev: ExtendedAdminReview,
): { label: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE'; score: number | null } {
  const rawScore = rev.sentimentScore ?? rev.diemCamXucNlp ?? null;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore)
      ? Math.round(rawScore * 100) / 100
      : null;

  if (
    rev.sentimentLabel === 'POSITIVE' ||
    rev.sentimentLabel === 'NEUTRAL' ||
    rev.sentimentLabel === 'NEGATIVE'
  ) {
    return { label: rev.sentimentLabel, score };
  }
  if (score !== null) {
    if (score >= 0.2) return { label: 'POSITIVE', score };
    if (score <= -0.2) return { label: 'NEGATIVE', score };
  }
  return { label: 'NEUTRAL', score };
}

function isReviewHidden(rev: ExtendedAdminReview): boolean {
  if (typeof rev.isHidden === 'boolean') return rev.isHidden;
  const status = String(rev.moderationStatus ?? '').toUpperCase();
  return status === 'HIDDEN' || status === ReviewModerationStatus.REJECTED;
}

const FIT_LABEL_VI: Record<FitFeedback, string> = {
  [FitFeedback.RUNS_SMALL]: 'Hơi chật',
  [FitFeedback.TRUE_TO_SIZE]: 'Chuẩn size',
  [FitFeedback.RUNS_LARGE]: 'Hơi rộng',
};

const ORDER_STATUS_VI: Record<OrderStatus, string> = {
  [OrderStatus.PENDING_RESERVATION]: 'Chờ giữ tồn',
  [OrderStatus.FAILED_OUT_OF_STOCK]: 'Hết hàng',
  [OrderStatus.AWAITING_PAYMENT]: 'Chờ thanh toán',
  [OrderStatus.CONFIRMED]: 'Đã xác nhận',
  [OrderStatus.PACKING]: 'Đang đóng gói',
  [OrderStatus.SHIPPED]: 'Đang giao vận',
  [OrderStatus.DELIVERED]: 'Đã giao',
  [OrderStatus.COMPLETED]: 'Hoàn tất',
  [OrderStatus.CANCELLED]: 'Đã hủy',
  [OrderStatus.LATE_PAYMENT_NEEDS_REFUND]: 'Thanh toán trễ',
};

export function CrmModerationTab({
  roles,
  darkMode = false,
  onRefreshOverview,
}: CrmModerationTabProps) {
  const canModerateReviews = hasAnyPermission(roles, [
    Permission.ORDER_MANAGE,
    Permission.CATALOG_PRODUCT_WRITE,
  ]);
  const canReadOrders = hasPermission(roles, Permission.ORDER_READ);

  const [activeSubTab, setActiveSubTab] = useState<CrmSubTab>('customers');
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Sub-tab 1: Customers CRM state
  const [customers, setCustomers] = useState<AdminCustomerSummaryDto[]>([]);
  const [customerPagination, setCustomerPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [customersLoading, setCustomersLoading] = useState(true);
  const [customerSearch, setCustomerSearch] = useState('');
  const [tierFilter, setTierFilter] = useState<'ALL' | LoyaltyTier>('ALL');
  const [customerPage, setCustomerPage] = useState(1);

  // Customer Detail Drawer + Orders/RMAs lazy hydration
  const [selectedCustomer, setSelectedCustomer] =
    useState<AdminCustomerSummaryDto | null>(null);
  const [drawerOrders, setDrawerOrders] = useState<OrderDTO[]>([]);
  const [drawerRmas, setDrawerRmas] = useState<RmaRequestDTO[]>([]);
  const [drawerLoading, setDrawerLoading] = useState(false);

  // Sub-tab 2: Reviews Moderation state
  const [reviews, setReviews] = useState<ExtendedAdminReview[]>([]);
  const [reviewPagination, setReviewPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [reviewsLoading, setReviewsLoading] = useState(false);
  const [ratingFilter, setRatingFilter] = useState<string>('ALL');
  const [sentimentFilter, setSentimentFilter] =
    useState<SentimentFilter>('ALL');
  const [hiddenFilter, setHiddenFilter] = useState<HiddenFilter>('ALL');
  const [reviewSearch, setReviewSearch] = useState('');
  const [reviewPage, setReviewPage] = useState(1);
  const [confirmDeleteReview, setConfirmDeleteReview] =
    useState<ExtendedAdminReview | null>(null);

  // Sub-tab 3: Notification Logs state
  const [notifLogs, setNotifLogs] = useState<NotificationLogDto[]>([]);
  const [notifPagination, setNotifPagination] = useState<PaginationMeta>({
    page: 1,
    limit: 20,
    total: 0,
    totalPages: 1,
  });
  const [notifsLoading, setNotifsLoading] = useState(false);
  const [channelFilter, setChannelFilter] = useState<string>('ALL');
  const [notifStatusFilter, setNotifStatusFilter] = useState<string>('ALL');
  const [notifSearch, setNotifSearch] = useState('');
  const [notifPage, setNotifPage] = useState(1);
  const [expandedNotifId, setExpandedNotifId] = useState<string | null>(null);

  // Load Customers
  const loadCustomers = useCallback(async () => {
    setCustomersLoading(true);
    setErrorBanner(null);
    const qs = buildQueryString({
      q: customerSearch.trim() || undefined,
      vipTier: tierFilter !== 'ALL' ? tierFilter : undefined,
      page: customerPage,
      limit: 20,
    });
    const res = await adminFetch<unknown>(`/api/v1/admin/customers${qs}`);
    if (res.ok) {
      const parsed = extractPaginatedList<AdminCustomerSummaryDto>(
        res.data,
        ['items', 'customers', 'users', 'list'],
        20,
      );
      setCustomers(parsed.items);
      setCustomerPagination(parsed.pagination);
    } else {
      setErrorBanner(
        res.error?.message ||
          'Chưa thể tải danh sách khách hàng CRM từ BFF (/api/v1/admin/customers).',
      );
    }
    setCustomersLoading(false);
  }, [customerPage, customerSearch, tierFilter]);

  // Load Reviews
  const loadReviews = useCallback(async () => {
    setReviewsLoading(true);
    setErrorBanner(null);
    const qs = buildQueryString({
      rating: ratingFilter !== 'ALL' ? Number(ratingFilter) : undefined,
      sentiment: sentimentFilter !== 'ALL' ? sentimentFilter : undefined,
      sentimentLabel: sentimentFilter !== 'ALL' ? sentimentFilter : undefined,
      isHidden:
        hiddenFilter === 'HIDDEN'
          ? 'true'
          : hiddenFilter === 'VISIBLE'
            ? 'false'
            : undefined,
      q: reviewSearch.trim() || undefined,
      page: reviewPage,
      limit: 20,
    });
    const res = await adminFetch<unknown>(`/api/v1/admin/reviews${qs}`);
    if (res.ok) {
      const parsed = extractPaginatedList<ExtendedAdminReview>(
        res.data,
        ['items', 'reviews', 'list'],
        20,
      );
      setReviews(parsed.items);
      setReviewPagination(parsed.pagination);
    } else {
      setErrorBanner(
        res.error?.message ||
          'Chưa thể tải danh sách đánh giá cần kiểm duyệt (/api/v1/admin/reviews).',
      );
    }
    setReviewsLoading(false);
  }, [hiddenFilter, ratingFilter, reviewPage, reviewSearch, sentimentFilter]);

  // Load Notification Logs
  const loadNotificationLogs = useCallback(async () => {
    setNotifsLoading(true);
    setErrorBanner(null);
    const qs = buildQueryString({
      channel: channelFilter !== 'ALL' ? channelFilter : undefined,
      status: notifStatusFilter !== 'ALL' ? notifStatusFilter : undefined,
      q: notifSearch.trim() || undefined,
      page: notifPage,
      limit: 20,
    });
    const res = await adminFetch<unknown>(
      `/api/v1/admin/notifications/logs${qs}`,
    );
    if (res.ok) {
      const parsed = extractPaginatedList<NotificationLogDto>(
        res.data,
        ['items', 'logs', 'notifications', 'list'],
        20,
      );
      setNotifLogs(parsed.items);
      setNotifPagination(parsed.pagination);
    } else {
      setErrorBanner(
        res.error?.message ||
          'Chưa thể tải nhật ký thông báo Email / ZNS (/api/v1/admin/notifications/logs).',
      );
    }
    setNotifsLoading(false);
  }, [channelFilter, notifPage, notifSearch, notifStatusFilter]);

  useEffect(() => {
    if (activeSubTab === 'customers') {
      void loadCustomers();
    } else if (activeSubTab === 'reviews') {
      void loadReviews();
    } else {
      void loadNotificationLogs();
    }
  }, [activeSubTab, loadCustomers, loadReviews, loadNotificationLogs]);

  // Open Customer Detail Drawer & load live order/RMA history
  const handleOpenCustomerDrawer = async (
    customer: AdminCustomerSummaryDto,
  ) => {
    setSelectedCustomer(customer);
    if (!canReadOrders) {
      setDrawerOrders([]);
      setDrawerRmas([]);
      return;
    }

    setDrawerLoading(true);
    const [ordersRes, rmasRes] = await Promise.all([
      adminFetch<unknown>('/api/v1/admin/orders?limit=200'),
      adminFetch<unknown>('/api/v1/admin/rma?limit=200'),
    ]);

    const emailLower = customer.email.trim().toLowerCase();
    const matchedOrders = ordersRes.ok
      ? extractList<OrderDTO>(ordersRes.data, ['items', 'orders', 'list']).filter(
          (o) =>
            o.userId === customer.id ||
            (o.customerEmail ?? '').trim().toLowerCase() === emailLower,
        )
      : [];
    const matchedOrderIds = new Set(matchedOrders.map((o) => o.id));
    const matchedRmas = rmasRes.ok
      ? extractList<RmaRequestDTO>(rmasRes.data, ['items', 'rmas', 'list']).filter(
          (r) =>
            r.userId === customer.id || matchedOrderIds.has(r.orderId),
        )
      : [];

    setDrawerOrders(matchedOrders);
    setDrawerRmas(matchedRmas);
    setDrawerLoading(false);
  };

  // Review Moderation Actions
  const handleToggleHideReview = async (rev: ExtendedAdminReview) => {
    if (!canModerateReviews) return;
    const currentlyHidden = isReviewHidden(rev);
    const nextHidden = !currentlyHidden;
    setBusyAction(`mod-${rev.id}`);
    setErrorBanner(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/reviews/${encodeURIComponent(rev.id)}/moderation`,
      {
        method: 'PATCH',
        body: JSON.stringify({
          isHidden: nextHidden,
          moderationStatus: nextHidden ? 'HIDDEN' : 'VISIBLE',
          moderationNote: nextHidden
            ? 'Ẩn bởi quản trị viên từ CRM Moderation'
            : 'Hiển thị lại trên Storefront',
        }),
      },
    );

    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'KIỂM DUYỆT ĐÁNH GIÁ',
        message: nextHidden
          ? `Đã ẩn đánh giá của ${rev.reviewerName} khỏi Storefront.`
          : `Đã hiển thị lại đánh giá của ${rev.reviewerName} trên Storefront.`,
      });
      await loadReviews();
      onRefreshOverview?.();
    } else {
      setErrorBanner(
        res.error?.message || 'Cập nhật trạng thái kiểm duyệt đánh giá thất bại.',
      );
    }
    setBusyAction(null);
  };

  const handleConfirmDeleteReview = async () => {
    if (!confirmDeleteReview || !canModerateReviews) return;
    setBusyAction(`del-${confirmDeleteReview.id}`);
    setErrorBanner(null);

    const res = await adminFetch<unknown>(
      `/api/v1/admin/reviews/${encodeURIComponent(confirmDeleteReview.id)}`,
      { method: 'DELETE' },
    );

    if (res.ok) {
      emitPortalToast({
        kind: 'info',
        title: 'XÓA ĐÁNH GIÁ',
        message: `Đã xóa đánh giá của ${confirmDeleteReview.reviewerName} và cập nhật lại điểm trung bình.`,
      });
      setConfirmDeleteReview(null);
      await loadReviews();
      onRefreshOverview?.();
    } else {
      setErrorBanner(res.error?.message || 'Không thể xóa đánh giá này.');
    }
    setBusyAction(null);
  };

  // Client-side guard filtering on customers if backend doesn't filter by tier
  const visibleCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return customers.filter((c) => {
      const tier = c.vipTier || c.loyaltyTier;
      if (tierFilter !== 'ALL' && tier !== tierFilter) return false;
      if (q) {
        const hay = `${c.fullName} ${c.email} ${c.phone ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [customerSearch, customers, tierFilter]);

  // Theme tokens
  const cardCls = darkMode
    ? 'border-[#B08A4A]/30 bg-[#1A130E] text-[#FBF7EF]'
    : 'border-[#B08A4A]/25 bg-[#FFFDF9] text-[#1C1410]';
  const subCardCls = darkMode
    ? 'border-[#B08A4A]/25 bg-[#231912] text-[#FBF7EF]'
    : 'border-[#B08A4A]/20 bg-[#FBF7EF] text-[#1C1410]';
  const mutedCls = darkMode ? 'text-[#B4A391]' : 'text-[#7A6A5B]';
  const goldTextCls = darkMode ? 'text-[#EBCF8F]' : 'text-[#8A672C]';
  const inputCls = darkMode
    ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#FBF7EF] placeholder:text-[#8E7D6B] focus:border-[#EBCF8F]'
    : 'border-[#B08A4A]/35 bg-[#FBF7EF] text-[#1C1410] placeholder:text-[#7A6A5B] focus:border-[#1C1410]';
  const tableHeadCls = darkMode
    ? 'border-b border-[#B08A4A]/25 bg-[#241A13] text-[#EBCF8F]'
    : 'border-b border-[#B08A4A]/20 bg-[#F4EBDA]/75 text-[#8A672C]';
  const rowHoverCls = darkMode ? 'hover:bg-[#251B14]' : 'hover:bg-[#FBF7EF]/85';

  const getTierBadgeCls = (tier: LoyaltyTier): string => {
    switch (tier) {
      case LoyaltyTier.DIAMOND:
        return darkMode
          ? 'border-sky-400/45 bg-sky-950/60 text-sky-200'
          : 'border-sky-500/40 bg-sky-50 text-sky-900';
      case LoyaltyTier.GOLD:
        return darkMode
          ? 'border-[#EBCF8F]/50 bg-[#352616] text-[#EBCF8F]'
          : 'border-[#B08A4A] bg-[#FFF8EB] text-[#8A5A12]';
      case LoyaltyTier.SILVER:
        return darkMode
          ? 'border-zinc-400/40 bg-zinc-800 text-zinc-200'
          : 'border-zinc-400/50 bg-zinc-100 text-zinc-800';
      default:
        return darkMode
          ? 'border-[#B08A4A]/25 bg-[#261C15] text-[#C2B3A3]'
          : 'border-[#B08A4A]/30 bg-[#F4EBDA]/70 text-[#5C4B41]';
    }
  };

  return (
    <div data-testid="crm-moderation-tab" className="space-y-6">
      {/* Header & 3 Sub-Tabs Navigation */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Customer CRM · Reviews NLP Moderation · Notification Audit Logs
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Khách hàng VIP, Kiểm duyệt Đánh giá &amp; Nhật ký Thông báo
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Quản trị hạng thành viên VIP, điểm tín nhiệm COD &amp; quota Thử
              đồ AI; kiểm duyệt hiển thị đánh giá NLP trên Storefront và tra cứu
              nhật ký gửi Email / Zalo ZNS.
            </p>
          </div>

          <button
            type="button"
            onClick={() => {
              if (activeSubTab === 'customers') void loadCustomers();
              else if (activeSubTab === 'reviews') void loadReviews();
              else void loadNotificationLogs();
            }}
            className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] ${
              darkMode
                ? 'bg-[#EBCF8F] text-[#1C1410] hover:bg-[#F5DDA7]'
                : 'bg-[#1C1410] text-[#EBCF8F] hover:opacity-90'
            }`}
          >
            Làm mới dữ liệu
          </button>
        </div>

        {/* 3 Clean Sub-Tab Switcher Pills */}
        <div className="mt-5 flex flex-wrap gap-2">
          {(
            [
              ['customers', '1. Khách hàng VIP & Tín nhiệm'],
              ['reviews', '2. Kiểm duyệt Đánh giá (Reviews)'],
              ['notifications', '3. Nhật ký Thông báo Email / ZNS'],
            ] as const
          ).map(([key, label]) => {
            const active = activeSubTab === key;
            return (
              <button
                key={key}
                type="button"
                data-testid={`crm-subtab-${key}`}
                onClick={() => setActiveSubTab(key)}
                className={`rounded-full px-4 py-2 text-xs font-medium transition-colors ${
                  active
                    ? darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2] hover:border-[#EBCF8F]'
                      : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>

        {errorBanner ? (
          <div
            role="alert"
            className={`mt-4 rounded-2xl border px-4 py-3 text-xs ${
              darkMode
                ? 'border-rose-500/45 bg-rose-950/40 text-rose-200'
                : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]'
            }`}
          >
            {errorBanner}
          </div>
        ) : null}
      </section>

      {/* SUB-TAB 1: KHÁCH HÀNG VIP & TÍN NHIỆM */}
      {activeSubTab === 'customers' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                GET /api/v1/admin/customers · VIP Tier · Try-On Quota · COD Trust
                Score
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Danh bạ Khách hàng ({customerPagination.total})
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={customerSearch}
                onChange={(e) => {
                  setCustomerSearch(e.target.value);
                  setCustomerPage(1);
                }}
                placeholder="Tìm tên, email, SĐT..."
                className={`w-56 rounded-full border px-4 py-1.5 text-xs outline-none ${inputCls}`}
              />

              <select
                value={tierFilter}
                onChange={(e) => {
                  setTierFilter(e.target.value as 'ALL' | LoyaltyTier);
                  setCustomerPage(1);
                }}
                aria-label="Lọc theo hạng VIP"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả hạng</option>
                <option value={LoyaltyTier.DIAMOND}>DIAMOND</option>
                <option value={LoyaltyTier.GOLD}>GOLD</option>
                <option value={LoyaltyTier.SILVER}>SILVER</option>
                <option value={LoyaltyTier.BRONZE}>BRONZE</option>
              </select>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead
                className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}
              >
                <tr>
                  <th className="px-5 py-3">Khách hàng</th>
                  <th className="px-4 py-3">Hạng VIP</th>
                  <th className="px-4 py-3">Try-On Quota (Còn / Ngày)</th>
                  <th className="px-4 py-3">Tín nhiệm COD</th>
                  <th className="px-4 py-3 text-right">Đơn / RMA</th>
                  <th className="px-5 py-3 text-right">Hồ sơ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#B08A4A]/15">
                {customersLoading ? (
                  <tr>
                    <td
                      colSpan={6}
                      className={`px-6 py-8 text-center text-xs ${mutedCls}`}
                    >
                      Đang tải danh sách khách hàng CRM...
                    </td>
                  </tr>
                ) : visibleCustomers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={6}
                      className={`px-6 py-8 text-center text-xs ${mutedCls}`}
                    >
                      Không tìm thấy khách hàng nào khớp bộ lọc.
                    </td>
                  </tr>
                ) : (
                  visibleCustomers.map((c) => {
                    const tier = c.vipTier || c.loyaltyTier || LoyaltyTier.BRONZE;
                    const trust = Math.min(
                      100,
                      Math.max(0, Math.round(Number(c.codTrustScore ?? 100))),
                    );
                    const trustColor =
                      trust >= 80
                        ? 'bg-emerald-500'
                        : trust >= 50
                          ? 'bg-amber-500'
                          : 'bg-rose-500';
                    return (
                      <tr key={c.id} className={rowHoverCls}>
                        <td className="px-5 py-3.5">
                          <div className="flex items-center gap-3">
                            <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-[#B08A4A] to-[#8A672C] font-mono text-[11px] font-bold text-[#FBF7EF]">
                              {getInitials(c.fullName)}
                            </span>
                            <div>
                              <p className="font-semibold">{c.fullName}</p>
                              <p className={`font-mono text-[10.5px] ${mutedCls}`}>
                                {c.email}
                                {c.phone ? ` · ${c.phone}` : ''}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3.5">
                          <span
                            className={`inline-flex rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getTierBadgeCls(tier)}`}
                          >
                            {tier}
                          </span>
                        </td>
                        <td className="px-4 py-3.5 font-mono">
                          <span className="font-semibold">
                            {c.tryOnQuotaRemaining}
                          </span>{' '}
                          <span className={mutedCls}>
                            / {c.tryOnDailyLimit} lượt
                          </span>
                        </td>
                        <td className="px-4 py-3.5">
                          <div className="flex items-center gap-2">
                            <div className="h-2 w-20 overflow-hidden rounded-full bg-[#B08A4A]/20">
                              <div
                                style={{ width: `${trust}%` }}
                                className={`h-full rounded-full ${trustColor}`}
                              />
                            </div>
                            <span className="font-mono text-[11px] font-semibold">
                              {trust}/100
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-3.5 text-right font-mono">
                          <span className="font-semibold">
                            {c.orderCount ?? 0}
                          </span>{' '}
                          đơn ·{' '}
                          <span
                            className={
                              (c.rmaCount ?? 0) > 0
                                ? 'font-semibold text-[#D9822B]'
                                : mutedCls
                            }
                          >
                            {c.rmaCount ?? 0} RMA
                          </span>
                        </td>
                        <td className="px-5 py-3.5 text-right">
                          <button
                            type="button"
                            onClick={() => void handleOpenCustomerDrawer(c)}
                            className={`rounded-full border px-3 py-1 text-[11px] font-medium transition-colors ${
                              darkMode
                                ? 'border-[#EBCF8F]/40 text-[#EBCF8F] hover:bg-[#EBCF8F] hover:text-[#1C1410]'
                                : 'border-[#1C1410] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
                            }`}
                          >
                            Xem chi tiết
                          </button>
                        </td>
                      </tr>
                    );
                  })
                )}
              </tbody>
            </table>
          </div>

          <div className="flex items-center justify-between border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Trang {customerPagination.page} / {customerPagination.totalPages}{' '}
              · Tổng {customerPagination.total} khách hàng
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={customerPage <= 1 || customersLoading}
                onClick={() => setCustomerPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={
                  customerPage >= customerPagination.totalPages ||
                  customersLoading
                }
                onClick={() =>
                  setCustomerPage((p) =>
                    Math.min(customerPagination.totalPages, p + 1),
                  )
                }
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* SUB-TAB 2: KIỂM DUYỆT ĐÁNH GIÁ (REVIEWS MODERATION) */}
      {activeSubTab === 'reviews' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="border-b border-[#B08A4A]/20 px-6 py-4">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  GET /api/v1/admin/reviews · NLP Sentiment &amp; Storefront
                  Visibility
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Kiểm duyệt Đánh giá Khách hàng ({reviewPagination.total})
                </h3>
              </div>
              {!canModerateReviews ? (
                <span className="rounded-full border border-amber-500/40 bg-amber-500/15 px-3 py-1 font-mono text-[10px] text-amber-500">
                  Chế độ xem (cần ORDER_MANAGE / CATALOG_PRODUCT_WRITE để ẩn/xóa)
                </span>
              ) : null}
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={reviewSearch}
                onChange={(e) => {
                  setReviewSearch(e.target.value);
                  setReviewPage(1);
                }}
                placeholder="Tìm nội dung bình luận, người đánh giá..."
                className={`w-60 rounded-full border px-4 py-1.5 text-xs outline-none ${inputCls}`}
              />

              <select
                value={ratingFilter}
                onChange={(e) => {
                  setRatingFilter(e.target.value);
                  setReviewPage(1);
                }}
                aria-label="Lọc theo số sao"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả số sao (1–5★)</option>
                <option value="5">★★★★★ (5 sao)</option>
                <option value="4">★★★★ (4 sao)</option>
                <option value="3">★★★ (3 sao)</option>
                <option value="2">★★ (2 sao)</option>
                <option value="1">★ (1 sao)</option>
              </select>

              <select
                value={sentimentFilter}
                onChange={(e) => {
                  setSentimentFilter(e.target.value as SentimentFilter);
                  setReviewPage(1);
                }}
                aria-label="Lọc theo cảm xúc NLP"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả Sentiment</option>
                <option value="POSITIVE">POSITIVE · Tích cực</option>
                <option value="NEUTRAL">NEUTRAL · Trung lập</option>
                <option value="NEGATIVE">NEGATIVE · Tiêu cực</option>
              </select>

              <select
                value={hiddenFilter}
                onChange={(e) => {
                  setHiddenFilter(e.target.value as HiddenFilter);
                  setReviewPage(1);
                }}
                aria-label="Lọc theo trạng thái ẩn/hiện"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả hiển thị</option>
                <option value="VISIBLE">Đang hiển thị</option>
                <option value="HIDDEN">Đang bị ẩn</option>
              </select>
            </div>
          </div>

          <div className="divide-y divide-[#B08A4A]/15 p-4">
            {reviewsLoading ? (
              <p className={`p-8 text-center text-xs ${mutedCls}`}>
                Đang tải đánh giá từ dịch vụ notify-review (:4008)...
              </p>
            ) : reviews.length === 0 ? (
              <p className={`p-8 text-center text-xs ${mutedCls}`}>
                Không có đánh giá nào khớp bộ lọc hiện tại.
              </p>
            ) : (
              reviews.map((rev) => {
                const sentiment = resolveReviewSentiment(rev);
                const hidden = isReviewHidden(rev);
                const sentimentCls =
                  sentiment.label === 'POSITIVE'
                    ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-600'
                    : sentiment.label === 'NEGATIVE'
                      ? 'border-rose-500/45 bg-rose-500/15 text-rose-600'
                      : 'border-amber-500/40 bg-amber-500/15 text-amber-600';
                return (
                  <article
                    key={rev.id}
                    className={`my-2 rounded-2xl border p-4 text-xs ${subCardCls} ${
                      hidden ? 'opacity-75' : ''
                    }`}
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="space-y-1">
                        <div className="flex flex-wrap items-center gap-2">
                          <strong className="text-sm">{rev.reviewerName}</strong>
                          <span className="font-mono text-[#D9822B]">
                            {'★'.repeat(rev.rating)}
                            {'☆'.repeat(Math.max(0, 5 - rev.rating))}
                          </span>
                          <span
                            className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${sentimentCls}`}
                          >
                            {sentiment.label}
                            {sentiment.score !== null
                              ? ` (${sentiment.score > 0 ? '+' : ''}${sentiment.score})`
                              : ''}
                          </span>
                          <span className="rounded-full border border-[#B08A4A]/35 px-2 py-0.5 font-mono text-[10px]">
                            Size {rev.sizePurchased} ·{' '}
                            {FIT_LABEL_VI[rev.fitFeedback] ?? rev.fitFeedback}
                          </span>
                          <span
                            className={`rounded-full px-2.5 py-0.5 font-mono text-[10px] font-semibold ${
                              hidden
                                ? 'bg-[#8B2E2E] text-white'
                                : 'bg-[#2E6B47]/20 text-[#2E6B47]'
                            }`}
                          >
                            {hidden ? 'ĐÃ ẨN KHỎI STOREFRONT' : 'HIỂN THỊ'}
                          </span>
                        </div>

                        <p className={`text-[11px] ${mutedCls}`}>
                          SP: {rev.productName || rev.productId.slice(0, 14)} ·{' '}
                          {formatDateTime(rev.createdAt)}
                        </p>

                        <p className="mt-1.5 leading-relaxed">{rev.comment}</p>

                        {rev.moderationNote ? (
                          <p className={`text-[10.5px] italic ${mutedCls}`}>
                            Ghi chú kiểm duyệt: {rev.moderationNote}
                          </p>
                        ) : null}
                      </div>

                      {canModerateReviews ? (
                        <div className="flex shrink-0 items-center gap-2">
                          <button
                            type="button"
                            data-testid={`btn-toggle-review-${rev.id}`}
                            disabled={busyAction === `mod-${rev.id}`}
                            onClick={() => void handleToggleHideReview(rev)}
                            className={`rounded-full px-3.5 py-1.5 text-[10.5px] font-medium transition-colors disabled:opacity-50 ${
                              hidden
                                ? 'bg-[#2E6B47] text-white'
                                : 'border border-[#D9822B]/55 text-[#9A5B13] hover:bg-[#FFF6E5]'
                            }`}
                          >
                            {busyAction === `mod-${rev.id}`
                              ? 'Đang lưu...'
                              : hidden
                                ? 'Hiện lại'
                                : 'Ẩn đánh giá'}
                          </button>

                          <button
                            type="button"
                            data-testid={`btn-delete-review-${rev.id}`}
                            onClick={() => setConfirmDeleteReview(rev)}
                            className="rounded-full border border-[#8B2E2E]/50 px-3 py-1.5 text-[10.5px] font-medium text-[#8B2E2E] hover:bg-[#8B2E2E] hover:text-white"
                          >
                            Xóa
                          </button>
                        </div>
                      ) : null}
                    </div>
                  </article>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Trang {reviewPagination.page} / {reviewPagination.totalPages} ·
              Tổng {reviewPagination.total} đánh giá
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={reviewPage <= 1 || reviewsLoading}
                onClick={() => setReviewPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={
                  reviewPage >= reviewPagination.totalPages || reviewsLoading
                }
                onClick={() =>
                  setReviewPage((p) =>
                    Math.min(reviewPagination.totalPages, p + 1),
                  )
                }
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* SUB-TAB 3: NHẬT KÝ THÔNG BÁO EMAIL / ZNS */}
      {activeSubTab === 'notifications' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                GET /api/v1/admin/notifications/logs · Email SMTP / Zalo ZNS /
                SMS
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Nhật ký Thông báo Hệ thống ({notifPagination.total})
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={notifSearch}
                onChange={(e) => {
                  setNotifSearch(e.target.value);
                  setNotifPage(1);
                }}
                placeholder="Tìm người nhận, template, tiêu đề..."
                className={`w-56 rounded-full border px-4 py-1.5 text-xs outline-none ${inputCls}`}
              />

              <select
                value={channelFilter}
                onChange={(e) => {
                  setChannelFilter(e.target.value);
                  setNotifPage(1);
                }}
                aria-label="Lọc kênh thông báo"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả kênh</option>
                <option value={NotificationChannel.EMAIL}>EMAIL</option>
                <option value={NotificationChannel.ZALO_ZNS}>ZALO_ZNS</option>
                <option value={NotificationChannel.SMS}>SMS</option>
              </select>

              <select
                value={notifStatusFilter}
                onChange={(e) => {
                  setNotifStatusFilter(e.target.value);
                  setNotifPage(1);
                }}
                aria-label="Lọc trạng thái gửi"
                className={`rounded-full border px-3 py-1.5 text-xs ${inputCls}`}
              >
                <option value="ALL">Tất cả trạng thái</option>
                <option value="SENT">SENT</option>
                <option value="FAILED">FAILED</option>
                <option value="PENDING">PENDING</option>
              </select>
            </div>
          </div>

          <div className="divide-y divide-[#B08A4A]/15">
            {notifsLoading ? (
              <p className={`p-8 text-center text-xs ${mutedCls}`}>
                Đang tải nhật ký thông báo Email / ZNS...
              </p>
            ) : notifLogs.length === 0 ? (
              <p className={`p-8 text-center text-xs ${mutedCls}`}>
                Chưa có bản ghi thông báo nào khớp bộ lọc.
              </p>
            ) : (
              notifLogs.map((log) => {
                const expanded = expandedNotifId === log.id;
                const okStatus = log.status.toUpperCase() === 'SENT';
                return (
                  <div key={log.id} className="px-6 py-3.5 text-xs">
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="rounded-full bg-[#1C1410] px-2.5 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                            {log.channel}
                          </span>
                          <span
                            className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold ${
                              okStatus
                                ? 'bg-emerald-500/15 text-emerald-600'
                                : 'bg-rose-500/15 text-rose-600'
                            }`}
                          >
                            {log.status}
                          </span>
                          <span className="font-mono font-semibold">
                            {log.templateCode}
                          </span>
                          <span className={mutedCls}>→ {log.recipient}</span>
                        </div>
                        {log.subject ? (
                          <p className={`text-[11px] ${mutedCls}`}>
                            Tiêu đề: {log.subject}
                          </p>
                        ) : null}
                      </div>

                      <div className="flex items-center gap-3">
                        <span className={`font-mono text-[10px] ${mutedCls}`}>
                          Retry: {log.retryCount} ·{' '}
                          {formatDateTime(log.sentAt || log.createdAt)}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedNotifId(expanded ? null : log.id)
                          }
                          className="rounded-full border border-[#B08A4A]/45 px-3 py-1 text-[10px] uppercase tracking-[0.12em] text-[#B08A4A]"
                        >
                          {expanded ? 'Ẩn Payload' : 'Xem Payload'}
                        </button>
                      </div>
                    </div>

                    {expanded ? (
                      <pre className="mt-3 max-h-56 overflow-auto rounded-xl bg-[#16100C] p-3 font-mono text-[11px] text-[#EBCF8F]">
                        {JSON.stringify(
                          log.payload ?? { eventId: log.eventId },
                          null,
                          2,
                        )}
                      </pre>
                    ) : null}
                  </div>
                );
              })
            )}
          </div>

          <div className="flex items-center justify-between border-t border-[#B08A4A]/20 px-6 py-3 text-xs">
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Trang {notifPagination.page} / {notifPagination.totalPages} · Tổng{' '}
              {notifPagination.total} nhật ký
            </span>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={notifPage <= 1 || notifsLoading}
                onClick={() => setNotifPage((p) => Math.max(1, p - 1))}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                ← Trước
              </button>
              <button
                type="button"
                disabled={
                  notifPage >= notifPagination.totalPages || notifsLoading
                }
                onClick={() =>
                  setNotifPage((p) =>
                    Math.min(notifPagination.totalPages, p + 1),
                  )
                }
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-[11px] disabled:opacity-40"
              >
                Sau →
              </button>
            </div>
          </div>
        </section>
      ) : null}

      {/* SLIDE-OVER CUSTOMER DETAIL DRAWER */}
      {selectedCustomer ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Hồ sơ chi tiết khách hàng"
          data-testid="crm-customer-drawer"
          className="fixed inset-0 z-50 flex justify-end bg-[#1C1410]/65 backdrop-blur-xs"
        >
          <div
            className={`adm-drawer-enter flex h-full w-full max-w-xl flex-col overflow-y-auto border-l p-6 shadow-2xl ${cardCls}`}
          >
            <div className="flex items-start justify-between border-b border-[#B08A4A]/25 pb-4">
              <div className="flex items-center gap-3">
                <span className="flex h-11 w-11 items-center justify-center rounded-2xl bg-gradient-to-br from-[#B08A4A] to-[#8A672C] font-mono text-sm font-bold text-[#FBF7EF]">
                  {getInitials(selectedCustomer.fullName)}
                </span>
                <div>
                  <p className={`ledger-eyebrow ${goldTextCls}`}>
                    Customer 360° Profile
                  </p>
                  <h3 className="font-editorial text-2xl">
                    {selectedCustomer.fullName}
                  </h3>
                  <p className={`font-mono text-[11px] ${mutedCls}`}>
                    {selectedCustomer.email}
                    {selectedCustomer.phone ? ` · ${selectedCustomer.phone}` : ''}
                  </p>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setSelectedCustomer(null)}
                className="rounded-full border border-[#B08A4A]/40 px-3 py-1 text-xs"
              >
                Đóng
              </button>
            </div>

            {/* VIP + Quota + Trust Score KPIs */}
            <div className="mt-5 grid grid-cols-3 gap-3 text-xs">
              <div className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                <p className={`text-[10px] uppercase ${mutedCls}`}>Hạng VIP</p>
                <p className="mt-1 font-mono text-base font-bold">
                  {selectedCustomer.vipTier || selectedCustomer.loyaltyTier}
                </p>
              </div>
              <div className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                <p className={`text-[10px] uppercase ${mutedCls}`}>
                  Tín nhiệm COD
                </p>
                <p className="mt-1 font-mono text-base font-bold">
                  {Math.round(selectedCustomer.codTrustScore)} / 100
                </p>
              </div>
              <div className={`rounded-2xl border p-3.5 ${subCardCls}`}>
                <p className={`text-[10px] uppercase ${mutedCls}`}>
                  Try-On hôm nay
                </p>
                <p className="mt-1 font-mono text-base font-bold">
                  {selectedCustomer.tryOnQuotaRemaining}/
                  {selectedCustomer.tryOnDailyLimit}
                </p>
              </div>
            </div>

            {/* Order History */}
            <div className="mt-6 space-y-2.5 text-xs">
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Lịch sử Đơn hàng ({drawerOrders.length})
              </p>
              {!canReadOrders ? (
                <p className={`rounded-2xl border p-4 ${subCardCls} ${mutedCls}`}>
                  Vai trò hiện tại không có quyền <code>order.read</code> để xem
                  chi tiết đơn hàng.
                </p>
              ) : drawerLoading ? (
                <p className={`p-4 text-center ${mutedCls}`}>
                  Đang tải lịch sử đơn hàng &amp; RMA...
                </p>
              ) : drawerOrders.length === 0 ? (
                <p className={`rounded-2xl border p-4 ${subCardCls} ${mutedCls}`}>
                  Khách hàng chưa có đơn hàng nào.
                </p>
              ) : (
                drawerOrders.map((ord) => (
                  <div
                    key={ord.id}
                    className={`rounded-2xl border p-3.5 ${subCardCls}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold">
                        {ord.orderCode}
                      </span>
                      <span className="font-mono text-[10.5px] font-semibold">
                        {ORDER_STATUS_VI[ord.status] ?? ord.status}
                      </span>
                    </div>
                    <p className={`mt-1 font-mono text-[11px] ${mutedCls}`}>
                      {formatDateTime(ord.createdAt)} · {ord.paymentMethod} ·{' '}
                      <strong>{FORMAT_VND(ord.totalAmountVnd)}</strong>
                    </p>
                  </div>
                ))
              )}
            </div>

            {/* RMA History */}
            <div className="mt-6 space-y-2.5 text-xs">
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Lịch sử Đổi / Trả hàng RMA ({drawerRmas.length})
              </p>
              {drawerRmas.length === 0 ? (
                <p className={`rounded-2xl border p-4 ${subCardCls} ${mutedCls}`}>
                  Chưa phát sinh yêu cầu RMA nào.
                </p>
              ) : (
                drawerRmas.map((rma) => (
                  <div
                    key={rma.id}
                    className={`rounded-2xl border p-3.5 ${subCardCls}`}
                  >
                    <div className="flex items-center justify-between">
                      <span className="font-mono font-bold">{rma.rmaCode}</span>
                      <span className="rounded-full bg-[#1C1410] px-2 py-0.5 font-mono text-[10px] text-[#EBCF8F]">
                        {rma.status}
                      </span>
                    </div>
                    <p className={`mt-1 text-[11px] ${mutedCls}`}>
                      {rma.type} · {rma.reasonCode} ·{' '}
                      {formatDateTime(rma.createdAt)}
                    </p>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      ) : null}

      {/* MODAL: Confirm Delete Review */}
      {confirmDeleteReview ? (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Xác nhận xóa đánh giá"
          className="fixed inset-0 z-50 flex items-center justify-center bg-[#1C1410]/70 p-4 backdrop-blur-sm"
        >
          <div className="w-full max-w-md rounded-3xl border border-[#8B2E2E]/40 bg-[#FBF7EF] p-6 text-[#1C1410] shadow-2xl">
            <p className="ledger-eyebrow text-[#8B2E2E]">
              DELETE /api/v1/admin/reviews/:id
            </p>
            <h3 className="font-editorial mt-1 text-3xl">
              Xác nhận xóa đánh giá?
            </h3>
            <p className="mt-2 text-xs text-[#5C4B41]">
              Đánh giá của <strong>{confirmDeleteReview.reviewerName}</strong> sẽ
              bị xóa/lưu trữ và điểm đánh giá trung bình của sản phẩm sẽ được
              tính lại.
            </p>
            <div className="mt-5 flex justify-end gap-2">
              <button
                type="button"
                onClick={() => setConfirmDeleteReview(null)}
                className="rounded-full border border-[#B08A4A]/40 px-4 py-2 text-xs text-[#5C4B41]"
              >
                Hủy
              </button>
              <button
                type="button"
                disabled={busyAction === `del-${confirmDeleteReview.id}`}
                onClick={() => void handleConfirmDeleteReview()}
                className="rounded-full bg-[#8B2E2E] px-5 py-2 text-xs font-medium uppercase tracking-[0.14em] text-white disabled:opacity-50"
              >
                {busyAction === `del-${confirmDeleteReview.id}`
                  ? 'Đang xóa...'
                  : 'Xác nhận xóa'}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
