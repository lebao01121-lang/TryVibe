'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  FitFeedback,
  LoyaltyTier,
  OrderStatus,
  Permission,
  Role,
  hasPermission,
  type OrderDTO,
  type ProductFitStatsDto,
  type ProductSpuDto,
  type UserSummaryDto,
  type VerifiedReviewDto,
} from '@atelier/contracts';
import { adminFetch } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface CustomersReviewsTabProps {
  roles: readonly Role[];
  darkMode?: boolean;
}

type SentimentLabel = 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE';
type FitCodeFilter = 'ALL' | 'CHAT' | 'VUA' | 'RONG';
type SentimentFilter = 'ALL' | SentimentLabel;
type ActiveSubPanel = 'ALL' | 'CUSTOMERS' | 'REVIEWS';
type VipTierFilter = 'ALL' | 'VIP' | 'MEMBER';

interface AdminReviewEntry extends VerifiedReviewDto {
  sentimentLabel?: SentimentLabel;
  diemCamXucNlp?: number | null;
  fitFeedbackLabelVi?: string;
}

interface ProductReviewsPayload {
  productId: string;
  fitStats: ProductFitStatsDto | null;
  reviews: AdminReviewEntry[];
  total: number;
}

interface ProductFitMatrixRow {
  product: ProductSpuDto;
  fitStats: ProductFitStatsDto | null;
  reviews: AdminReviewEntry[];
  runsSmallPct: number;
  trueToSizePct: number;
  runsLargePct: number;
  totalReviews: number;
  averageRating: number;
  needsSizeUpWarning: boolean;
}

interface FlattenedReviewRow {
  review: AdminReviewEntry;
  productId: string;
  productName: string;
  productSlug: string;
  fitCode: 'CHAT' | 'VUA' | 'RONG';
  fitLabelVi: string;
  sentimentScore: number;
  sentimentLabel: SentimentLabel;
}

interface CustomerDirectoryEntry {
  key: string;
  userId: string | null;
  fullName: string;
  email: string;
  phone: string;
  orderCount: number;
  lifetimeValueVnd: number;
  loyaltyTier: LoyaltyTier | null;
  vipTier: 'Atelier VIP' | 'Thành viên';
  latestOrderCode: string | null;
  latestOrderStatus: OrderStatus | null;
  latestOrderAt: string | null;
  accountStatus: string | null;
}

const VIP_LTV_THRESHOLD_VND = 5_000_000;

function extractList<T>(data: unknown, keys: string[]): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const rec = data as Record<string, unknown>;
    for (const key of keys) {
      if (Array.isArray(rec[key])) {
        return rec[key] as T[];
      }
    }
  }
  return [];
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;
}

function formatDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

function getInitials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (parts.length === 0) return 'KH';
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return `${parts[0]![0] ?? ''}${parts[parts.length - 1]![0] ?? ''}`.toUpperCase();
}

function mapFitCode(fit: FitFeedback): {
  code: 'CHAT' | 'VUA' | 'RONG';
  labelVi: string;
} {
  if (fit === FitFeedback.RUNS_SMALL) {
    return { code: 'CHAT', labelVi: 'Hơi chật' };
  }
  if (fit === FitFeedback.RUNS_LARGE) {
    return { code: 'RONG', labelVi: 'Hơi rộng' };
  }
  return { code: 'VUA', labelVi: 'Chuẩn size' };
}

function resolveSentiment(review: AdminReviewEntry): {
  score: number;
  label: SentimentLabel;
} {
  const rawScore = review.sentimentScore ?? review.diemCamXucNlp;
  const score =
    typeof rawScore === 'number' && Number.isFinite(rawScore)
      ? Math.round(Math.min(1, Math.max(-1, rawScore)) * 100) / 100
      : 0;

  if (
    review.sentimentLabel === 'POSITIVE' ||
    review.sentimentLabel === 'NEUTRAL' ||
    review.sentimentLabel === 'NEGATIVE'
  ) {
    return { score, label: review.sentimentLabel };
  }
  if (score >= 0.2) return { score, label: 'POSITIVE' };
  if (score <= -0.2) return { score, label: 'NEGATIVE' };
  return { score, label: 'NEUTRAL' };
}

function computeFitPercentages(
  fitStats: ProductFitStatsDto | null,
  reviews: AdminReviewEntry[],
): {
  runsSmallPct: number;
  trueToSizePct: number;
  runsLargePct: number;
  totalReviews: number;
  averageRating: number;
} {
  if (fitStats && fitStats.totalReviews > 0) {
    return {
      runsSmallPct: Math.round(fitStats.runsSmallPct),
      trueToSizePct: Math.round(fitStats.trueToSizePct),
      runsLargePct: Math.round(fitStats.runsLargePct),
      totalReviews: fitStats.totalReviews,
      averageRating: fitStats.averageRating,
    };
  }
  if (reviews.length === 0) {
    return {
      runsSmallPct: 0,
      trueToSizePct: 0,
      runsLargePct: 0,
      totalReviews: 0,
      averageRating: 0,
    };
  }
  let small = 0;
  let large = 0;
  let ratingSum = 0;
  for (const r of reviews) {
    ratingSum += r.rating;
    if (r.fitFeedback === FitFeedback.RUNS_SMALL) small += 1;
    else if (r.fitFeedback === FitFeedback.RUNS_LARGE) large += 1;
  }
  const total = reviews.length;
  const runsSmallPct = Math.round((small / total) * 100);
  const runsLargePct = Math.round((large / total) * 100);
  const trueToSizePct = Math.max(0, 100 - runsSmallPct - runsLargePct);
  return {
    runsSmallPct,
    trueToSizePct,
    runsLargePct,
    totalReviews: total,
    averageRating: Math.round((ratingSum / total) * 10) / 10,
  };
}

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

export function CustomersReviewsTab({
  roles,
  darkMode = false,
}: CustomersReviewsTabProps) {
  const canReadUsers = hasPermission(roles, Permission.ADMIN_RBAC_MANAGE);
  const canReadOrders = hasPermission(roles, Permission.ORDER_READ);
  const canReadCatalog = hasPermission(roles, Permission.CATALOG_PRODUCT_READ);

  const [users, setUsers] = useState<UserSummaryDto[]>([]);
  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [reviewsMap, setReviewsMap] = useState<Record<string, ProductReviewsPayload>>(
    {},
  );

  const [loading, setLoading] = useState(true);
  const [loadingReviews, setLoadingReviews] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<string | null>(null);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  // Navigation & Filters
  const [activeSubPanel, setActiveSubPanel] = useState<ActiveSubPanel>('ALL');
  const [customerSearch, setCustomerSearch] = useState('');
  const [vipFilter, setVipFilter] = useState<VipTierFilter>('ALL');

  const [selectedProductId, setSelectedProductId] = useState<string>('ALL');
  const [fitFilter, setFitFilter] = useState<FitCodeFilter>('ALL');
  const [sentimentFilter, setSentimentFilter] = useState<SentimentFilter>('ALL');
  const [reviewSearch, setReviewSearch] = useState('');

  const loadAll = useCallback(
    async (notify = false) => {
      setLoading(true);
      setErrorBanner(null);

      const [usersRes, ordersRes, productsRes] = await Promise.all([
        canReadUsers
          ? adminFetch<unknown>('/api/v1/admin/users?limit=200')
          : Promise.resolve(null),
        canReadOrders
          ? adminFetch<unknown>('/api/v1/admin/orders?limit=200')
          : Promise.resolve(null),
        canReadCatalog
          ? adminFetch<unknown>('/api/v1/admin/products?pageSize=50')
          : Promise.resolve(null),
      ]);

      if (usersRes?.ok) {
        setUsers(extractList<UserSummaryDto>(usersRes.data, ['items', 'users', 'list']));
      }
      if (ordersRes?.ok) {
        setOrders(extractList<OrderDTO>(ordersRes.data, ['items', 'orders', 'list']));
      }

      const productList = productsRes?.ok
        ? extractList<ProductSpuDto>(productsRes.data, ['items', 'products', 'list'])
        : [];
      setProducts(productList);

      if (
        (!usersRes || !usersRes.ok) &&
        (!ordersRes || !ordersRes.ok) &&
        (!productsRes || !productsRes.ok)
      ) {
        setErrorBanner(
          'Chưa thể kết nối dữ liệu Khách hàng & Đánh giá từ BFF (:4000).',
        );
      }

      setLoading(false);

      // Fetch verified fit reviews in controlled batches of 6 via BFF storefront route
      if (productList.length > 0) {
        setLoadingReviews(true);
        const batchTargets = productList.slice(0, 24);
        const nextMap: Record<string, ProductReviewsPayload> = {};
        const chunkSize = 6;

        for (let i = 0; i < batchTargets.length; i += chunkSize) {
          const chunk = batchTargets.slice(i, i + chunkSize);
          const results = await Promise.all(
            chunk.map(async (prod) => {
              let res = await adminFetch<ProductReviewsPayload>(
                `/bff/v1/storefront/products/${encodeURIComponent(prod.slug)}/reviews`,
                { timeoutMs: 7000 },
              );
              if (!res.ok && res.status === 404) {
                res = await adminFetch<ProductReviewsPayload>(
                  `/api/v1/admin/products/${encodeURIComponent(prod.id)}/reviews`,
                  { timeoutMs: 7000 },
                );
              }
              return { productId: prod.id, res };
            }),
          );

          for (const { productId, res } of results) {
            if (res.ok && res.data) {
              const reviewsArr = Array.isArray(res.data.reviews) ? res.data.reviews : [];
              nextMap[productId] = {
                productId: res.data.productId || productId,
                fitStats: res.data.fitStats ?? null,
                reviews: reviewsArr,
                total:
                  typeof res.data.total === 'number'
                    ? res.data.total
                    : reviewsArr.length,
              };
            }
          }
        }

        setReviewsMap(nextMap);
        setLoadingReviews(false);
      } else {
        setReviewsMap({});
      }

      setLastUpdated(new Date().toISOString());
      if (notify) {
        emitPortalToast({
          kind: 'success',
          title: 'KHÁCH HÀNG & ĐỘ VỪA',
          message: 'Đã đồng bộ danh bạ khách hàng và ma trận đánh giá độ vừa mới nhất.',
        });
      }
    },
    [canReadCatalog, canReadOrders, canReadUsers],
  );

  useEffect(() => {
    void loadAll(false);
  }, [loadAll]);

  // Build merged Customer Directory from live CUSTOMER accounts + order buyer profiles
  const customerDirectory = useMemo<CustomerDirectoryEntry[]>(() => {
    const map = new Map<string, CustomerDirectoryEntry>();

    // 1. Seed from CUSTOMER accounts in auth-customer (if SUPER_ADMIN)
    for (const u of users) {
      if (!u.roles.includes(Role.CUSTOMER)) continue;
      const key = u.email.trim().toLowerCase();
      const isVipByLoyalty =
        u.loyaltyTier === LoyaltyTier.GOLD || u.loyaltyTier === LoyaltyTier.DIAMOND;
      map.set(key, {
        key,
        userId: u.id,
        fullName: u.fullName || u.email.split('@')[0] || 'Khách hàng',
        email: u.email,
        phone: u.phone || '—',
        orderCount: 0,
        lifetimeValueVnd: 0,
        loyaltyTier: u.loyaltyTier,
        vipTier: isVipByLoyalty ? 'Atelier VIP' : 'Thành viên',
        latestOrderCode: null,
        latestOrderStatus: null,
        latestOrderAt: null,
        accountStatus: u.status,
      });
    }

    // 2. Enrich / derive from live Orders
    const sortedOrders = [...orders].sort(
      (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
    );

    for (const ord of sortedOrders) {
      const normalizedEmail = (ord.customerEmail || '').trim().toLowerCase();
      const normalizedPhone = (ord.shippingAddress?.phone || '').trim();
      const key =
        normalizedEmail ||
        (normalizedPhone ? `phone:${normalizedPhone}` : `order:${ord.userId || ord.id}`);

      const existing = map.get(key);
      const isValidSpend =
        ord.status !== OrderStatus.CANCELLED &&
        ord.status !== OrderStatus.FAILED_OUT_OF_STOCK;

      if (existing) {
        existing.orderCount += 1;
        if (isValidSpend) {
          existing.lifetimeValueVnd += ord.totalAmountVnd;
        }
        if (existing.phone === '—' && normalizedPhone) {
          existing.phone = normalizedPhone;
        }
        if (!existing.latestOrderAt) {
          existing.latestOrderCode = ord.orderCode;
          existing.latestOrderStatus = ord.status;
          existing.latestOrderAt = ord.createdAt;
        }
        if (
          existing.lifetimeValueVnd >= VIP_LTV_THRESHOLD_VND ||
          existing.orderCount >= 3 ||
          existing.loyaltyTier === LoyaltyTier.GOLD ||
          existing.loyaltyTier === LoyaltyTier.DIAMOND
        ) {
          existing.vipTier = 'Atelier VIP';
        }
      } else {
        const ltv = isValidSpend ? ord.totalAmountVnd : 0;
        map.set(key, {
          key,
          userId: ord.userId,
          fullName:
            ord.shippingAddress?.recipientName ||
            (normalizedEmail ? normalizedEmail.split('@')[0] ?? 'Khách hàng' : 'Khách vãng lai'),
          email: ord.customerEmail || 'Khách đặt nhanh',
          phone: normalizedPhone || '—',
          orderCount: 1,
          lifetimeValueVnd: ltv,
          loyaltyTier: null,
          vipTier: ltv >= VIP_LTV_THRESHOLD_VND ? 'Atelier VIP' : 'Thành viên',
          latestOrderCode: ord.orderCode,
          latestOrderStatus: ord.status,
          latestOrderAt: ord.createdAt,
          accountStatus: ord.userId ? 'VERIFIED' : 'GUEST',
        });
      }
    }

    return Array.from(map.values()).sort(
      (a, b) =>
        b.lifetimeValueVnd - a.lifetimeValueVnd || b.orderCount - a.orderCount,
    );
  }, [orders, users]);

  const filteredCustomers = useMemo(() => {
    const q = customerSearch.trim().toLowerCase();
    return customerDirectory.filter((c) => {
      if (vipFilter === 'VIP' && c.vipTier !== 'Atelier VIP') return false;
      if (vipFilter === 'MEMBER' && c.vipTier !== 'Thành viên') return false;
      if (q) {
        const hay = `${c.fullName} ${c.email} ${c.phone} ${c.latestOrderCode ?? ''}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [customerDirectory, customerSearch, vipFilter]);

  // Build Product Fit Matrix
  const productFitMatrix = useMemo<ProductFitMatrixRow[]>(() => {
    return products
      .map((product) => {
        const payload = reviewsMap[product.id];
        const reviews = payload?.reviews ?? [];
        const stats = computeFitPercentages(payload?.fitStats ?? null, reviews);
        const needsSizeUpWarning = stats.totalReviews > 0 && stats.runsSmallPct >= 50;
        return {
          product,
          fitStats: payload?.fitStats ?? null,
          reviews,
          runsSmallPct: stats.runsSmallPct,
          trueToSizePct: stats.trueToSizePct,
          runsLargePct: stats.runsLargePct,
          totalReviews: stats.totalReviews,
          averageRating: stats.averageRating,
          needsSizeUpWarning,
        };
      })
      .sort((a, b) => {
        if (a.needsSizeUpWarning !== b.needsSizeUpWarning) {
          return a.needsSizeUpWarning ? -1 : 1;
        }
        return b.totalReviews - a.totalReviews || b.runsSmallPct - a.runsSmallPct;
      });
  }, [products, reviewsMap]);

  // Flattened Verified Reviews across all loaded products
  const allFlattenedReviews = useMemo<FlattenedReviewRow[]>(() => {
    const list: FlattenedReviewRow[] = [];
    for (const row of productFitMatrix) {
      for (const rev of row.reviews) {
        const fit = mapFitCode(rev.fitFeedback);
        const sentiment = resolveSentiment(rev);
        list.push({
          review: rev,
          productId: row.product.id,
          productName: row.product.name,
          productSlug: row.product.slug,
          fitCode: fit.code,
          fitLabelVi: rev.fitFeedbackLabelVi || fit.labelVi,
          sentimentScore: sentiment.score,
          sentimentLabel: sentiment.label,
        });
      }
    }
    return list.sort(
      (a, b) =>
        new Date(b.review.createdAt).getTime() - new Date(a.review.createdAt).getTime(),
    );
  }, [productFitMatrix]);

  const filteredReviews = useMemo(() => {
    const q = reviewSearch.trim().toLowerCase();
    return allFlattenedReviews.filter((item) => {
      if (selectedProductId !== 'ALL' && item.productId !== selectedProductId) {
        return false;
      }
      if (fitFilter !== 'ALL' && item.fitCode !== fitFilter) {
        return false;
      }
      if (sentimentFilter !== 'ALL' && item.sentimentLabel !== sentimentFilter) {
        return false;
      }
      if (q) {
        const hay = `${item.productName} ${item.review.reviewerName} ${item.review.comment} ${item.review.sizePurchased}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [allFlattenedReviews, fitFilter, reviewSearch, selectedProductId, sentimentFilter]);

  // Top KPI Aggregates
  const kpis = useMemo(() => {
    const totalCustomers = customerDirectory.length;
    const vipCount = customerDirectory.filter((c) => c.vipTier === 'Atelier VIP').length;

    const productsWithReviews = productFitMatrix.filter((r) => r.totalReviews > 0);
    const totalReviews = productsWithReviews.reduce((s, r) => s + r.totalReviews, 0);
    const weightedTrueToSize =
      totalReviews > 0
        ? Math.round(
            productsWithReviews.reduce(
              (s, r) => s + r.trueToSizePct * r.totalReviews,
              0,
            ) / totalReviews,
          )
        : 0;
    const avgRating =
      totalReviews > 0
        ? Number(
            (
              productsWithReviews.reduce(
                (s, r) => s + r.averageRating * r.totalReviews,
                0,
              ) / totalReviews
            ).toFixed(1),
          )
        : 0;
    const runsSmallAlertCount = productFitMatrix.filter(
      (r) => r.needsSizeUpWarning,
    ).length;

    const positiveReviews = allFlattenedReviews.filter(
      (r) => r.sentimentLabel === 'POSITIVE',
    ).length;
    const positivePct =
      allFlattenedReviews.length > 0
        ? Math.round((positiveReviews / allFlattenedReviews.length) * 100)
        : 0;

    return {
      totalCustomers,
      vipCount,
      totalReviews,
      weightedTrueToSize,
      avgRating,
      runsSmallAlertCount,
      positivePct,
    };
  }, [allFlattenedReviews, customerDirectory, productFitMatrix]);

  // Theme tokens for Kem Atelier (Light) vs Espresso Tối (Dark)
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

  const getOrderBadgeCls = (status: OrderStatus | null): string => {
    if (!status) {
      return darkMode
        ? 'border-[#B08A4A]/25 bg-[#261C15] text-[#B4A391]'
        : 'border-[#B08A4A]/25 bg-[#FBF7EF] text-[#7A6A5B]';
    }
    if (
      status === OrderStatus.DELIVERED ||
      status === OrderStatus.COMPLETED ||
      status === OrderStatus.CONFIRMED
    ) {
      return darkMode
        ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
        : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
    }
    if (
      status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND ||
      status === OrderStatus.FAILED_OUT_OF_STOCK
    ) {
      return darkMode
        ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
        : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#8B2E2E]';
    }
    if (status === OrderStatus.CANCELLED) {
      return darkMode
        ? 'border-[#7A6A5B]/40 bg-[#261E19] text-[#B4A391]'
        : 'border-[#7A6A5B]/35 bg-[#F4EBDA]/65 text-[#5C4B41]';
    }
    return darkMode
      ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'
      : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
  };

  const getFitPillCls = (code: 'CHAT' | 'VUA' | 'RONG'): string => {
    if (code === 'CHAT') {
      return darkMode
        ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
        : 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]';
    }
    if (code === 'RONG') {
      return darkMode
        ? 'border-amber-500/45 bg-amber-950/50 text-amber-300'
        : 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]';
    }
    return darkMode
      ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
      : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]';
  };

  const getSentimentPillCls = (label: SentimentLabel): string => {
    if (label === 'POSITIVE') {
      return darkMode
        ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
        : 'border-emerald-300 bg-emerald-50 text-emerald-800';
    }
    if (label === 'NEGATIVE') {
      return darkMode
        ? 'border-rose-500/45 bg-rose-950/55 text-rose-300'
        : 'border-rose-300 bg-rose-50 text-rose-800';
    }
    return darkMode
      ? 'border-amber-500/40 bg-amber-950/50 text-amber-300'
      : 'border-amber-300 bg-amber-50 text-amber-900';
  };

  return (
    <div data-testid="customers-reviews-tab" className="space-y-6">
      {/* Header Control Strip */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Customer CRM &amp; Verified Fit Reviews · NLP Sentiment Matrix
            </p>
            <h2 className="font-editorial mt-1 text-3xl font-normal tracking-tight">
              Khách hàng &amp; Đánh giá Độ vừa (Verified Fit Reviews)
            </h2>
            <p className={`mt-1 text-xs leading-relaxed ${mutedCls}`}>
              Hợp nhất danh bạ khách hàng xác thực, giá trị trọn đời (LTV) và phản hồi
              phom dáng thực tế kèm tự động phát hiện mẫu cần nhích size AI (
              <code>runsSmallPct ≥ 50%</code>).
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2.5">
            {lastUpdated ? (
              <span className={`font-mono text-[11px] ${mutedCls}`}>
                Đồng bộ: {formatDate(lastUpdated)}
              </span>
            ) : null}
            <button
              type="button"
              disabled={loading || loadingReviews}
              onClick={() => void loadAll(true)}
              className={`rounded-full px-4 py-2 text-xs font-medium uppercase tracking-[0.14em] transition-opacity disabled:opacity-50 ${
                darkMode
                  ? 'bg-[#EBCF8F] text-[#1C1410] hover:bg-[#F5DDA7]'
                  : 'bg-[#1C1410] text-[#EBCF8F] hover:opacity-90'
              }`}
            >
              {loading || loadingReviews ? 'Đang đồng bộ...' : 'Làm mới dữ liệu'}
            </button>
          </div>
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

        {/* Top 4-KPI Strip */}
        <div className="mt-5 grid grid-cols-1 gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng khách hàng xác thực
            </p>
            <p className="mt-1.5 font-mono text-3xl font-semibold tabular-nums">
              {kpis.totalCustomers}
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className={secondaryCls}>
                <strong className={goldTextCls}>{kpis.vipCount}</strong> Atelier VIP
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${
                  darkMode
                    ? 'border-[#EBCF8F]/35 bg-[#2D2117] text-[#EBCF8F]'
                    : 'border-[#B08A4A]/40 bg-[#F4EBDA] text-[#7A5922]'
                }`}
              >
                CRM Live
              </span>
            </div>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tổng đánh giá độ vừa
            </p>
            <p className="mt-1.5 font-mono text-3xl font-semibold tabular-nums">
              {kpis.totalReviews}
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className={secondaryCls}>
                ★ <strong>{kpis.avgRating > 0 ? kpis.avgRating.toFixed(1) : '—'}</strong> / 5.0
              </span>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${getSentimentPillCls('POSITIVE')}`}
              >
                {kpis.positivePct}% Tích cực
              </span>
            </div>
          </div>

          <div className={`rounded-2xl border p-4 ${subCardCls}`}>
            <p className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${mutedCls}`}>
              Tỷ lệ chuẩn size TB
            </p>
            <p className="mt-1.5 font-mono text-3xl font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
              <span className={darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'}>
                {kpis.weightedTrueToSize}%
              </span>
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className={secondaryCls}>Độ khớp phom Atelier</span>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] ${getFitPillCls('VUA')}`}
              >
                VUA · Chuẩn
              </span>
            </div>
          </div>

          <div
            className={`rounded-2xl border p-4 ${
              kpis.runsSmallAlertCount > 0
                ? darkMode
                  ? 'border-rose-500/45 bg-rose-950/35 text-[#FBF7EF]'
                  : 'border-[#8B2E2E]/40 bg-[#FFF5F4] text-[#1C1410]'
                : subCardCls
            }`}
          >
            <p
              className={`text-[10px] font-semibold uppercase tracking-[0.16em] ${
                kpis.runsSmallAlertCount > 0
                  ? darkMode
                    ? 'text-rose-300'
                    : 'text-[#8B2E2E]'
                  : mutedCls
              }`}
            >
              Cảnh báo &ldquo;Hơi chật ≥ 50%&rdquo;
            </p>
            <p
              className={`mt-1.5 font-mono text-3xl font-semibold tabular-nums ${
                kpis.runsSmallAlertCount > 0
                  ? darkMode
                    ? 'text-rose-300'
                    : 'text-[#8B2E2E]'
                  : ''
              }`}
            >
              {kpis.runsSmallAlertCount}
            </p>
            <div className="mt-2 flex items-center justify-between text-[11px]">
              <span className={secondaryCls}>Tự động nhích size AI</span>
              <span
                className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                  kpis.runsSmallAlertCount > 0
                    ? getFitPillCls('CHAT')
                    : getFitPillCls('VUA')
                }`}
              >
                {kpis.runsSmallAlertCount > 0 ? 'Cần hiệu chỉnh' : 'Ổn định'}
              </span>
            </div>
          </div>
        </div>

        {/* Sub-Panel Switcher */}
        <div className="mt-5 flex flex-wrap items-center gap-2 border-t border-[#B08A4A]/20 pt-4">
          {(
            [
              ['ALL', `Tổng hợp cả 2 (${kpis.totalCustomers} KH · ${kpis.totalReviews} ĐG)`],
              ['CUSTOMERS', `Danh sách Khách hàng (${kpis.totalCustomers})`],
              ['REVIEWS', `Đánh giá Độ vừa & NLP (${kpis.totalReviews})`],
            ] as const
          ).map(([key, label]) => {
            const active = activeSubPanel === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => setActiveSubPanel(key)}
                className={`rounded-full px-4 py-1.5 text-xs font-medium transition-colors ${
                  active
                    ? darkMode
                      ? 'bg-[#EBCF8F] text-[#1C1410]'
                      : 'bg-[#1C1410] text-[#EBCF8F]'
                    : darkMode
                      ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#DFD2C2] hover:border-[#EBCF8F]/60'
                      : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]'
                }`}
              >
                {label}
              </button>
            );
          })}
        </div>
      </section>

      {/* SUB-PANEL 1: Customer Directory */}
      {activeSubPanel === 'ALL' || activeSubPanel === 'CUSTOMERS' ? (
        <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Customer Directory · Tài khoản CUSTOMER &amp; Hồ sơ mua hàng
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Danh sách Khách hàng ({filteredCustomers.length})
              </h3>
            </div>

            <div className="flex flex-wrap items-center gap-2">
              <input
                type="search"
                value={customerSearch}
                onChange={(e) => setCustomerSearch(e.target.value)}
                placeholder="Tìm tên, email, SĐT, mã đơn..."
                className={`w-64 rounded-full border px-4 py-1.5 text-xs outline-none ${inputCls}`}
              />
              {(
                [
                  ['ALL', 'Tất cả'],
                  ['VIP', 'Atelier VIP'],
                  ['MEMBER', 'Thành viên'],
                ] as const
              ).map(([tier, label]) => (
                <button
                  key={tier}
                  type="button"
                  onClick={() => setVipFilter(tier)}
                  className={`rounded-full px-3 py-1.5 text-[11px] font-medium transition-colors ${
                    vipFilter === tier
                      ? darkMode
                        ? 'bg-[#EBCF8F] text-[#1C1410]'
                        : 'bg-[#1C1410] text-[#EBCF8F]'
                      : darkMode
                        ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                        : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {!canReadUsers && !canReadOrders ? (
            <div className="p-6 text-xs">
              <p className={`rounded-2xl border p-4 ${subCardCls} ${mutedCls}`}>
                Vai trò hiện tại không có quyền <code>ORDER_READ</code> hoặc{' '}
                <code>ADMIN_RBAC_MANAGE</code> để xem danh bạ cá nhân khách hàng. Vui
                lòng chuyển sang mục <strong>Đánh giá Độ vừa &amp; NLP</strong> bên dưới.
              </p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
                  <tr>
                    <th className="px-5 py-3">Khách hàng</th>
                    <th className="px-4 py-3">Phân hạng VIP</th>
                    <th className="px-4 py-3 text-right">Số đơn</th>
                    <th className="px-4 py-3 text-right">Tổng chi tiêu (LTV)</th>
                    <th className="px-5 py-3">Đơn hàng gần nhất</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-[#B08A4A]/15">
                  {filteredCustomers.length === 0 ? (
                    <tr>
                      <td colSpan={5} className={`px-6 py-8 text-center ${mutedCls}`}>
                        {loading
                          ? 'Đang tải danh sách khách hàng...'
                          : 'Không tìm thấy khách hàng khớp từ khóa.'}
                      </td>
                    </tr>
                  ) : (
                    filteredCustomers.slice(0, 50).map((cust) => (
                      <tr key={cust.key} className={`transition-colors ${rowHoverCls}`}>
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <span
                              className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full border font-mono text-[11px] font-semibold ${
                                cust.vipTier === 'Atelier VIP'
                                  ? darkMode
                                    ? 'border-[#EBCF8F]/60 bg-[#2E2216] text-[#EBCF8F]'
                                    : 'border-[#B08A4A]/60 bg-[#1C1410] text-[#EBCF8F]'
                                  : darkMode
                                    ? 'border-[#B08A4A]/30 bg-[#241A13] text-[#DFD2C2]'
                                    : 'border-[#B08A4A]/30 bg-[#F4EBDA] text-[#1C1410]'
                              }`}
                            >
                              {getInitials(cust.fullName)}
                            </span>
                            <div className="min-w-0">
                              <p className="truncate font-medium">{cust.fullName}</p>
                              <p className={`truncate font-mono text-[11px] ${mutedCls}`}>
                                {cust.email} · {cust.phone}
                              </p>
                            </div>
                          </div>
                        </td>
                        <td className="px-4 py-3">
                          <span
                            className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${
                              cust.vipTier === 'Atelier VIP'
                                ? darkMode
                                  ? 'border-[#EBCF8F]/50 bg-[#2E2216] text-[#EBCF8F]'
                                  : 'border-[#B08A4A]/55 bg-[#1C1410] text-[#EBCF8F]'
                                : darkMode
                                  ? 'border-[#B08A4A]/25 bg-[#241A13] text-[#D8CBB8]'
                                  : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                            }`}
                          >
                            {cust.vipTier === 'Atelier VIP' ? '✦ ' : ''}
                            {cust.vipTier}
                            {cust.loyaltyTier ? ` · ${cust.loyaltyTier}` : ''}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">
                          {cust.orderCount}
                        </td>
                        <td
                          className={`px-4 py-3 text-right font-mono font-semibold tabular-nums ${goldTextCls}`}
                        >
                          {formatVnd(cust.lifetimeValueVnd)}
                        </td>
                        <td className="px-5 py-3">
                          {cust.latestOrderStatus ? (
                            <div className="flex flex-wrap items-center gap-2">
                              <span
                                className={`rounded-full border px-2.5 py-0.5 text-[10px] font-medium ${getOrderBadgeCls(
                                  cust.latestOrderStatus,
                                )}`}
                              >
                                {ORDER_STATUS_VI[cust.latestOrderStatus] ??
                                  cust.latestOrderStatus}
                              </span>
                              <span className={`font-mono text-[10px] ${mutedCls}`}>
                                {cust.latestOrderCode} · {formatDate(cust.latestOrderAt)}
                              </span>
                            </div>
                          ) : (
                            <span className={`text-[11px] ${mutedCls}`}>
                              Chưa phát sinh đơn
                            </span>
                          )}
                        </td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          )}
        </section>
      ) : null}

      {/* SUB-PANEL 2: Verified Fit Reviews & Sentiment Matrix */}
      {activeSubPanel === 'ALL' || activeSubPanel === 'REVIEWS' ? (
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[1.08fr_1.22fr]">
          {/* Left: Product Fit Distribution Bars & Auto-Size Calibration Matrix */}
          <section className={`rounded-3xl border p-6 ${cardCls}`}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Fit Distribution Matrix · 3-Segment Garment Fit Telemetry
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Phân bố Độ vừa theo Thiết kế ({productFitMatrix.length} SPU)
                </h3>
              </div>
              {selectedProductId !== 'ALL' ? (
                <button
                  type="button"
                  onClick={() => setSelectedProductId('ALL')}
                  className={`rounded-full border px-3 py-1 text-[11px] ${
                    darkMode
                      ? 'border-[#EBCF8F]/40 bg-[#231912] text-[#EBCF8F]'
                      : 'border-[#B08A4A]/45 bg-[#FBF7EF] text-[#8A672C]'
                  }`}
                >
                  Xem tất cả SPU
                </button>
              ) : null}
            </div>

            <div className="mt-4 max-h-[540px] space-y-3 overflow-y-auto pr-1">
              {loading && productFitMatrix.length === 0 ? (
                <p className={`rounded-2xl border p-6 text-center text-xs ${subCardCls} ${mutedCls}`}>
                  Đang tải ma trận độ vừa sản phẩm...
                </p>
              ) : productFitMatrix.length === 0 ? (
                <p className={`rounded-2xl border p-6 text-center text-xs ${subCardCls} ${mutedCls}`}>
                  Chưa có dữ liệu sản phẩm trong danh mục.
                </p>
              ) : (
                productFitMatrix.map((row) => {
                  const isSelected = selectedProductId === row.product.id;
                  return (
                    <button
                      key={row.product.id}
                      type="button"
                      onClick={() =>
                        setSelectedProductId(isSelected ? 'ALL' : row.product.id)
                      }
                      className={`w-full rounded-2xl border p-4 text-left transition-all ${
                        isSelected
                          ? darkMode
                            ? 'border-[#EBCF8F] bg-[#2B2017] ring-1 ring-[#EBCF8F]/40'
                            : 'border-[#1C1410] bg-[#F4EBDA]/75 ring-1 ring-[#1C1410]/20'
                          : row.needsSizeUpWarning
                            ? darkMode
                              ? 'border-rose-500/45 bg-rose-950/25 hover:border-rose-400/70'
                              : 'border-[#8B2E2E]/35 bg-[#FFF9F8] hover:border-[#8B2E2E]/65'
                            : `${subCardCls} hover:border-[#B08A4A]/60`
                      }`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0 flex-1">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="truncate text-sm font-semibold">
                              {row.product.name}
                            </p>
                            <span
                              className={`rounded-full px-2 py-0.5 font-mono text-[10px] ${
                                darkMode
                                  ? 'bg-[#140E0A] text-[#EBCF8F]'
                                  : 'bg-[#F4EBDA] text-[#8A672C]'
                              }`}
                            >
                              {row.product.categorySlug}
                            </span>
                          </div>
                          <p className={`mt-0.5 truncate text-[11px] ${mutedCls}`}>
                            {row.product.fabricComposition} ·{' '}
                            {row.totalReviews > 0
                              ? `★ ${row.averageRating.toFixed(1)} (${row.totalReviews} đánh giá)`
                              : 'Chưa có đánh giá độ vừa'}
                          </p>
                        </div>

                        {row.needsSizeUpWarning ? (
                          <span
                            className={`shrink-0 rounded-full border px-2.5 py-1 font-mono text-[10px] font-semibold ${getFitPillCls('CHAT')}`}
                          >
                            ⚡ Tự động hiệu chỉnh Size AI
                          </span>
                        ) : null}
                      </div>

                      {/* 3-Segment Fit Distribution Bar */}
                      <div className="mt-3">
                        <div
                          className={`flex h-2.5 w-full overflow-hidden rounded-full ${
                            darkMode ? 'bg-[#140E0A]' : 'bg-[#E9DFCE]'
                          }`}
                        >
                          {row.totalReviews > 0 ? (
                            <>
                              {row.runsSmallPct > 0 ? (
                                <div
                                  style={{ width: `${row.runsSmallPct}%` }}
                                  className="bg-rose-600 transition-all"
                                  title={`Hơi chật: ${row.runsSmallPct}%`}
                                />
                              ) : null}
                              {row.trueToSizePct > 0 ? (
                                <div
                                  style={{ width: `${row.trueToSizePct}%` }}
                                  className="bg-emerald-600 transition-all"
                                  title={`Chuẩn size: ${row.trueToSizePct}%`}
                                />
                              ) : null}
                              {row.runsLargePct > 0 ? (
                                <div
                                  style={{ width: `${row.runsLargePct}%` }}
                                  className="bg-amber-500 transition-all"
                                  title={`Hơi rộng: ${row.runsLargePct}%`}
                                />
                              ) : null}
                            </>
                          ) : null}
                        </div>

                        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 font-mono text-[10px]">
                          <span className={darkMode ? 'text-rose-300' : 'text-[#8B2E2E]'}>
                            Hơi chật: <strong>{row.runsSmallPct}%</strong>
                          </span>
                          <span
                            className={darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'}
                          >
                            Chuẩn size: <strong>{row.trueToSizePct}%</strong>
                          </span>
                          <span className={darkMode ? 'text-amber-300' : 'text-[#9A5B13]'}>
                            Hơi rộng: <strong>{row.runsLargePct}%</strong>
                          </span>
                        </div>
                      </div>
                    </button>
                  );
                })
              )}
            </div>
          </section>

          {/* Right: Filterable Verified Fit Review Cards */}
          <section className={`rounded-3xl border p-6 ${cardCls}`}>
            <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
              <div>
                <p className={`ledger-eyebrow ${goldTextCls}`}>
                  Verified Fit Feed · Số đo cơ thể &amp; Cảm xúc NLP
                </p>
                <h3 className="font-editorial mt-0.5 text-2xl">
                  Thẻ Đánh giá Xác thực ({filteredReviews.length})
                </h3>
              </div>

              <input
                type="search"
                value={reviewSearch}
                onChange={(e) => setReviewSearch(e.target.value)}
                placeholder="Lọc nội dung, người mua, size..."
                className={`w-56 rounded-full border px-3.5 py-1.5 text-xs outline-none ${inputCls}`}
              />
            </div>

            {/* Fit + Sentiment Filter Bars */}
            <div className="mt-3.5 space-y-2">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`mr-1 font-mono text-[10px] uppercase ${mutedCls}`}>
                  Độ vừa:
                </span>
                {(
                  [
                    ['ALL', 'Tất cả'],
                    ['CHAT', 'CHAT · Hơi chật'],
                    ['VUA', 'VUA · Chuẩn size'],
                    ['RONG', 'RONG · Hơi rộng'],
                  ] as const
                ).map(([code, label]) => (
                  <button
                    key={code}
                    type="button"
                    onClick={() => setFitFilter(code)}
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
                      fitFilter === code
                        ? darkMode
                          ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                          : 'bg-[#1C1410] text-[#EBCF8F]'
                        : darkMode
                          ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                          : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                <span className={`mr-1 font-mono text-[10px] uppercase ${mutedCls}`}>
                  NLP:
                </span>
                {(
                  [
                    ['ALL', 'Tất cả'],
                    ['POSITIVE', 'POSITIVE'],
                    ['NEUTRAL', 'NEUTRAL'],
                    ['NEGATIVE', 'NEGATIVE'],
                  ] as const
                ).map(([sent, label]) => (
                  <button
                    key={sent}
                    type="button"
                    onClick={() => setSentimentFilter(sent)}
                    className={`rounded-full px-2.5 py-1 font-mono text-[10px] transition-colors ${
                      sentimentFilter === sent
                        ? darkMode
                          ? 'bg-[#EBCF8F] text-[#1C1410] font-semibold'
                          : 'bg-[#1C1410] text-[#EBCF8F]'
                        : darkMode
                          ? 'border border-[#B08A4A]/30 bg-[#231912] text-[#DFD2C2]'
                          : 'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41]'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            </div>

            <div className="mt-4 max-h-[460px] space-y-3 overflow-y-auto pr-1">
              {loadingReviews && filteredReviews.length === 0 ? (
                <p className={`rounded-2xl border p-6 text-center text-xs ${subCardCls} ${mutedCls}`}>
                  Đang tải thẻ đánh giá xác thực &amp; phân tích NLP...
                </p>
              ) : filteredReviews.length === 0 ? (
                <p className={`rounded-2xl border p-6 text-center text-xs ${subCardCls} ${mutedCls}`}>
                  Chưa có đánh giá độ vừa nào khớp bộ lọc hiện tại.
                </p>
              ) : (
                filteredReviews.slice(0, 40).map((item) => {
                  const r = item.review;
                  const bodyText =
                    r.reviewerHeightCm && r.reviewerWeightKg
                      ? `${r.reviewerHeightCm}cm / ${r.reviewerWeightKg}kg`
                      : 'Số đo ẩn danh';
                  return (
                    <article
                      key={r.id}
                      className={`rounded-2xl border p-4 text-xs ${subCardCls}`}
                    >
                      <div className="flex flex-wrap items-start justify-between gap-2">
                        <div className="min-w-0">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="font-semibold">{r.reviewerName}</span>
                            <span
                              className={`font-mono text-[11px] ${goldTextCls}`}
                              aria-label={`${r.rating} trên 5 sao`}
                            >
                              {'★'.repeat(Math.max(1, Math.min(5, r.rating)))}
                              {'☆'.repeat(Math.max(0, 5 - r.rating))}
                            </span>
                            <span className={`font-mono text-[10px] ${mutedCls}`}>
                              Size {r.sizePurchased}
                            </span>
                          </div>
                          <p className={`mt-0.5 truncate text-[11px] font-medium ${secondaryCls}`}>
                            {item.productName}
                          </p>
                        </div>

                        <span className={`font-mono text-[10px] ${mutedCls}`}>
                          {formatDate(r.createdAt)}
                        </span>
                      </div>

                      {/* Body Measurements + Fit Pill + NLP Sentiment Pill */}
                      <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] ${
                            darkMode
                              ? 'border-[#B08A4A]/35 bg-[#140E0A] text-[#EBCF8F]'
                              : 'border-[#B08A4A]/35 bg-white text-[#5C4B41]'
                          }`}
                        >
                          Số đo: {bodyText}
                        </span>

                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getFitPillCls(item.fitCode)}`}
                        >
                          {item.fitCode} · {item.fitLabelVi}
                        </span>

                        <span
                          className={`rounded-full border px-2.5 py-0.5 font-mono text-[10px] font-semibold ${getSentimentPillCls(item.sentimentLabel)}`}
                        >
                          {item.sentimentLabel} (
                          {item.sentimentScore >= 0 ? '+' : ''}
                          {item.sentimentScore.toFixed(2)})
                        </span>
                      </div>

                      <p className={`mt-2.5 break-words leading-relaxed ${secondaryCls}`}>
                        {r.comment}
                      </p>
                    </article>
                  );
                })
              )}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}
