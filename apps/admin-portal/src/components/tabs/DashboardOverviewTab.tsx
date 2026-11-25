'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  OrderStatus,
  Permission,
  PurchaseOrderStatus,
  RmaReasonCode,
  RmaStatus,
  RmaType,
  Role,
  hasPermission,
  type InventoryLedgerEntryDto,
  type OrderDTO,
  type ProductSpuDto,
  type PurchaseOrderDTO,
  type RmaRequestDTO,
  type StockLevelAdminDto,
  type UserSummaryDto,
} from '@atelier/contracts';
import type { AdminLiveOverviewData } from '@/lib/admin-overview';
import {
  canAccessAdminTab,
  type AdminTabKey,
} from '@/lib/admin-navigation';
import { adminFetch } from '@/lib/api-client';
import {
  AdminNavIcon,
  AlertTriangleIcon,
  BoxIcon,
  CheckCircleIcon,
  ChevronRightIcon,
  SparklesIcon,
} from '@/components/AdminIcons';
import { emitPortalToast } from '@/components/PortalToastBanner';

export interface DashboardLiveBadges {
  pendingOrdersRma: number;
  lowStockCount: number;
  openPoCount: number;
  servicesReady: number;
  servicesTotal: number;
}

export interface DashboardOverviewTabProps {
  roles: readonly Role[];
  userEmail: string;
  bffOnline: boolean;
  liveOverview: AdminLiveOverviewData | null;
  onNavigateTab: (tab: AdminTabKey) => void;
  onOpenCopilot: () => void;
  refreshNonce: number;
  darkMode?: boolean;
  onLiveBadgesChange?: (badges: DashboardLiveBadges) => void;
}

interface HealthClusterNode {
  name: string;
  port?: number | string;
  status: string;
  latencyMs?: number;
}

interface HealthClusterSnapshot {
  checkedAt?: string;
  overallStatus?: string;
  services?: HealthClusterNode[];
  infra?: HealthClusterNode[];
  ollama?: {
    reachable?: boolean;
    activeMainModel?: string;
    loadedModels?: string[];
  };
}

interface AiFunnelSnapshot {
  localAi?: {
    activeMainModel?: string;
    reachable?: boolean;
    avgTokensPerSec?: number;
  };
  funnel?: {
    tryOnModalOpens?: number;
    tryOnCompleted?: number;
    addToCartAfterTryOn?: number;
    paidOrders?: number;
  };
  tryon?: {
    totalSessions?: number;
    completedSessions?: number;
    cacheHitCount?: number;
    cacheHitRatePct?: number;
    cacheHitSavingsPct?: number;
    addToCartAfterTryonCount?: number;
    addToCartAfterTryOnSignals?: number;
  };
  orders?: {
    totalOrders?: number;
    paidOrders?: number;
    deliveredOrders?: number;
    totalRmas?: number;
  };
  payments?: {
    totalPaidVnd?: number;
  };
  inventory?: {
    lowStockCount?: number;
    outOfStockCount?: number;
    pendingAiDraftPosCount?: number;
  };
  cacheHitSavingsPct?: number;
}

interface TryOnDemandSummarySnapshot {
  items?: Array<{
    productId?: string;
    productName?: string;
    tryOnSessions?: number;
    addToCartCount?: number;
    tryOnToCartRatePct?: number;
  }>;
  signalCounts?: {
    MO_PHONG_THU?: number;
    THU_THANH_CONG?: number;
    THEM_GIO_SAU_THU?: number;
    MUA_SAU_THU?: number;
  };
  tryOnToCartRate?: number;
  tryOnToCartRatePct?: number;
}

interface DlqSnapshot {
  queues?: Array<{
    name: string;
    messageCount: number;
  }>;
}

type TimeframeKey = '7d' | '14d' | 'all';

interface ActivityBucket {
  key: string;
  label: string;
  fullDate: string;
  orderCount: number;
  revenueVnd: number;
  aiActivity: number;
}

interface RecentQueueItem {
  id: string;
  kind: 'ORDER' | 'RMA';
  code: string;
  title: string;
  subtitle: string;
  createdAt: string;
  metricLabel: string;
  statusLabel: string;
  statusTone: 'emerald' | 'gold' | 'amber' | 'rose' | 'neutral';
  canQuickApproveRma: boolean;
  rmaId?: string;
  rmaCode?: string;
}

interface CategorySlice {
  key: string;
  label: string;
  count: number;
  pct: number;
  color: string;
}

function extractList<T>(data: unknown): T[] {
  if (Array.isArray(data)) return data as T[];
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>;
    for (const key of [
      'items',
      'list',
      'rows',
      'orders',
      'rmas',
      'requests',
      'products',
      'purchaseOrders',
      'ledger',
      'users',
    ]) {
      if (Array.isArray(obj[key])) {
        return obj[key] as T[];
      }
    }
  }
  return [];
}

function formatVnd(amount: number): string {
  return `${new Intl.NumberFormat('vi-VN').format(Math.round(amount))}₫`;
}

function formatVndCompact(amount: number): string {
  if (amount >= 1_000_000_000) {
    return `${(amount / 1_000_000_000).toFixed(2)} tỷ₫`;
  }
  if (amount >= 1_000_000) {
    return `${(amount / 1_000_000).toFixed(1)} tr₫`;
  }
  return formatVnd(amount);
}

function formatClock(date: Date): string {
  return new Intl.DateTimeFormat('vi-VN', {
    hour: '2-digit',
    minute: '2-digit',
  }).format(date);
}

function formatShortDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      day: '2-digit',
      month: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

function toDayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDayLabel(dayKey: string): string {
  const parts = dayKey.split('-');
  if (parts.length !== 3) return dayKey;
  return `${parts[2]}/${parts[1]}`;
}

function normalizeNodeUp(status: string | undefined): boolean {
  const s = String(status ?? '').toUpperCase();
  return s === 'UP' || s === 'OK' || s === 'HEALTHY';
}

function resolveOrderStatusMeta(status: OrderStatus): {
  label: string;
  tone: RecentQueueItem['statusTone'];
} {
  switch (status) {
    case OrderStatus.COMPLETED:
      return { label: 'Hoàn tất', tone: 'emerald' };
    case OrderStatus.DELIVERED:
      return { label: 'Đã giao', tone: 'emerald' };
    case OrderStatus.SHIPPED:
      return { label: 'Đang giao', tone: 'gold' };
    case OrderStatus.PACKING:
      return { label: 'Đóng gói', tone: 'gold' };
    case OrderStatus.CONFIRMED:
      return { label: 'Đã xác nhận', tone: 'gold' };
    case OrderStatus.AWAITING_PAYMENT:
      return { label: 'Chờ thanh toán', tone: 'amber' };
    case OrderStatus.PENDING_RESERVATION:
      return { label: 'Chờ giữ tồn', tone: 'amber' };
    case OrderStatus.LATE_PAYMENT_NEEDS_REFUND:
      return { label: 'Thanh toán trễ', tone: 'rose' };
    case OrderStatus.FAILED_OUT_OF_STOCK:
      return { label: 'Hết hàng', tone: 'rose' };
    case OrderStatus.CANCELLED:
      return { label: 'Đã hủy', tone: 'neutral' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

function resolveRmaStatusMeta(status: string): {
  label: string;
  tone: RecentQueueItem['statusTone'];
} {
  switch (status) {
    case RmaStatus.RMA_REQUESTED:
    case 'REQUESTED':
      return { label: 'Chờ duyệt RMA', tone: 'amber' };
    case RmaStatus.RMA_APPROVED:
    case RmaStatus.INSTANT_2WAY_DISPATCHED:
    case RmaStatus.EXCHANGE_RESERVED:
      return { label: 'Đã duyệt đổi', tone: 'gold' };
    case RmaStatus.QC_INSPECTING:
    case RmaStatus.RETURN_IN_TRANSIT:
      return { label: 'Đang kiểm QC', tone: 'gold' };
    case RmaStatus.QC_PASSED:
    case RmaStatus.RMA_COMPLETED:
    case RmaStatus.EXCHANGE_SHIPPED:
      return { label: 'Hoàn tất RMA', tone: 'emerald' };
    case RmaStatus.QC_FAILED:
    case RmaStatus.RMA_REJECTED:
      return { label: 'Từ chối / Lỗi QC', tone: 'rose' };
    default:
      return { label: status, tone: 'neutral' };
  }
}

const RMA_REASON_VI: Record<RmaReasonCode, string> = {
  [RmaReasonCode.SAI_KICH_CO_CHAT]: 'Hơi chật',
  [RmaReasonCode.SAI_KICH_CO_RONG]: 'Hơi rộng',
  [RmaReasonCode.SAI_MAU_MO_TA]: 'Khác màu',
  [RmaReasonCode.LOI_SAN_XUAT]: 'Lỗi may',
  [RmaReasonCode.KHAC]: 'Lý do khác',
};

const RMA_TYPE_VI: Record<RmaType, string> = {
  [RmaType.SIZE_EXCHANGE]: 'Đổi size',
  [RmaType.COLOR_EXCHANGE]: 'Đổi màu',
  [RmaType.RETURN_REFUND]: 'Hoàn tiền',
};

function classifyProductCategory(product: ProductSpuDto): string {
  const hay =
    `${product.categorySlug ?? ''} ${product.categoryName ?? ''} ${product.name ?? ''}`.toLowerCase();
  if (
    hay.includes('blazer') ||
    hay.includes('khoac') ||
    hay.includes('khoác') ||
    hay.includes('trench') ||
    hay.includes('coat') ||
    hay.includes('jacket') ||
    hay.includes('vest')
  ) {
    return 'blazer';
  }
  if (
    hay.includes('dam') ||
    hay.includes('đầm') ||
    hay.includes('vay-du-tiec') ||
    hay.includes('váy dự tiệc') ||
    hay.includes('dress') ||
    hay.includes('gown')
  ) {
    return 'dress';
  }
  if (
    hay.includes('quan') ||
    hay.includes('quần') ||
    hay.includes('chan-vay') ||
    hay.includes('chân váy') ||
    hay.includes('skirt') ||
    hay.includes('trouser') ||
    hay.includes('pant')
  ) {
    return 'bottom';
  }
  if (
    hay.includes('phu-kien') ||
    hay.includes('phụ kiện') ||
    hay.includes('khan') ||
    hay.includes('khăn') ||
    hay.includes('tui') ||
    hay.includes('túi') ||
    hay.includes('that-lung') ||
    hay.includes('belt') ||
    hay.includes('accessory')
  ) {
    return 'accessory';
  }
  return 'tops';
}

const CATEGORY_BUCKETS: ReadonlyArray<{
  key: string;
  label: string;
  lightColor: string;
  darkColor: string;
}> = [
  {
    key: 'tops',
    label: 'Áo & Sơ mi',
    lightColor: '#B08A4A',
    darkColor: '#EBCF8F',
  },
  {
    key: 'blazer',
    label: 'Blazer & Khoác',
    lightColor: '#2B2019',
    darkColor: '#C59A55',
  },
  {
    key: 'dress',
    label: 'Đầm dự tiệc',
    lightColor: '#8C5639',
    darkColor: '#D98C5F',
  },
  {
    key: 'bottom',
    label: 'Quần & Chân váy',
    lightColor: '#3A6B52',
    darkColor: '#5EB286',
  },
  {
    key: 'accessory',
    label: 'Phụ kiện',
    lightColor: '#7A6A5B',
    darkColor: '#9D8C7B',
  },
];

function buildSmoothCurvePath(
  points: ReadonlyArray<{ x: number; y: number }>,
): string {
  if (points.length === 0) return '';
  if (points.length === 1) {
    return `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  }

  let d = `M ${points[0]!.x.toFixed(1)} ${points[0]!.y.toFixed(1)}`;
  for (let i = 0; i < points.length - 1; i += 1) {
    const p0 = points[i]!;
    const p1 = points[i + 1]!;
    const midX = (p0.x + p1.x) / 2;
    d += ` C ${midX.toFixed(1)} ${p0.y.toFixed(1)}, ${midX.toFixed(1)} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
  }
  return d;
}

export function DashboardOverviewTab({
  roles,
  userEmail,
  bffOnline,
  liveOverview,
  onNavigateTab,
  onOpenCopilot,
  refreshNonce,
  darkMode = false,
  onLiveBadgesChange,
}: DashboardOverviewTabProps) {
  const [orders, setOrders] = useState<OrderDTO[]>([]);
  const [rmas, setRmas] = useState<RmaRequestDTO[]>([]);
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [stockLevels, setStockLevels] = useState<StockLevelAdminDto[]>([]);
  const [ledgerEntries, setLedgerEntries] = useState<InventoryLedgerEntryDto[]>(
    [],
  );
  const [purchaseOrders, setPurchaseOrders] = useState<PurchaseOrderDTO[]>([]);
  const [users, setUsers] = useState<UserSummaryDto[]>([]);
  const [healthCluster, setHealthCluster] =
    useState<HealthClusterSnapshot | null>(null);
  const [aiFunnel, setAiFunnel] = useState<AiFunnelSnapshot | null>(null);
  const [tryOnDemand, setTryOnDemand] =
    useState<TryOnDemandSummarySnapshot | null>(null);
  const [dlqCount, setDlqCount] = useState<number>(0);

  const [loading, setLoading] = useState(true);
  const [lastUpdatedLabel, setLastUpdatedLabel] = useState<string>(() =>
    formatClock(new Date()),
  );
  const [timeframe, setTimeframe] = useState<TimeframeKey>('7d');
  const [hoveredBarIdx, setHoveredBarIdx] = useState<number | null>(null);
  const [hoveredDonutKey, setHoveredDonutKey] = useState<string | null>(null);
  const [approvingRmaId, setApprovingRmaId] = useState<string | null>(null);

  const canReadOrders = hasPermission(roles, Permission.ORDER_READ);
  const canManageRma = hasPermission(roles, Permission.ORDER_RMA_MANAGE);
  const canReadCatalog = hasPermission(roles, Permission.CATALOG_PRODUCT_READ);
  const canReadInventory = hasPermission(
    roles,
    Permission.INVENTORY_STOCK_READ,
  );
  const canReadPo = hasPermission(roles, Permission.INVENTORY_PO_READ);
  const canReadOpsCluster =
    hasPermission(roles, Permission.ADMIN_AUDIT_READ) ||
    hasPermission(roles, Permission.INVENTORY_STOCK_READ);
  const canReadAiFunnel =
    hasPermission(roles, Permission.ADMIN_AUDIT_READ) ||
    hasPermission(roles, Permission.TRYON_SIGNALS_READ) ||
    hasPermission(roles, Permission.INVENTORY_STOCK_READ);
  const canReadTryOn = hasPermission(roles, Permission.TRYON_SIGNALS_READ);
  const canReadUsers =
    roles.includes(Role.SUPER_ADMIN) &&
    hasPermission(roles, Permission.ADMIN_RBAC_MANAGE);
  const canReadDlq =
    roles.includes(Role.SUPER_ADMIN) &&
    hasPermission(roles, Permission.ADMIN_AUDIT_READ);

  const loadDashboardData = useCallback(async () => {
    setLoading(true);

    const [
      ordersRes,
      rmaRes,
      productsRes,
      stockRes,
      ledgerRes,
      poRes,
      clusterRes,
      funnelRes,
      tryOnRes,
      usersRes,
      dlqRes,
    ] = await Promise.all([
      canReadOrders ? adminFetch<unknown>('/api/v1/admin/orders') : null,
      canReadOrders ? adminFetch<unknown>('/api/v1/admin/rma') : null,
      canReadCatalog
        ? adminFetch<unknown>('/api/v1/admin/products?pageSize=50')
        : null,
      canReadInventory
        ? adminFetch<unknown>('/api/v1/admin/inventory/stock-levels')
        : null,
      canReadInventory
        ? adminFetch<unknown>('/api/v1/admin/inventory/ledger')
        : null,
      canReadPo
        ? adminFetch<unknown>('/api/v1/admin/procurement/purchase-orders')
        : null,
      canReadOpsCluster
        ? adminFetch<HealthClusterSnapshot>(
            '/api/v1/admin/ops/health-cluster',
            { timeoutMs: 12_000 },
          )
        : null,
      canReadAiFunnel
        ? adminFetch<AiFunnelSnapshot>('/api/v1/admin/ops/ai-funnel', {
            timeoutMs: 12_000,
          })
        : null,
      canReadTryOn
        ? adminFetch<TryOnDemandSummarySnapshot>(
            '/api/v1/admin/tryon/demand-summary',
            { timeoutMs: 10_000 },
          )
        : null,
      canReadUsers ? adminFetch<unknown>('/api/v1/admin/users') : null,
      canReadDlq
        ? adminFetch<DlqSnapshot>('/api/v1/admin/ops/dlq', { timeoutMs: 8_000 })
        : null,
    ]);

    if (ordersRes?.ok) setOrders(extractList<OrderDTO>(ordersRes.data));
    if (rmaRes?.ok) setRmas(extractList<RmaRequestDTO>(rmaRes.data));
    if (productsRes?.ok)
      setProducts(extractList<ProductSpuDto>(productsRes.data));
    if (stockRes?.ok)
      setStockLevels(extractList<StockLevelAdminDto>(stockRes.data));
    if (ledgerRes?.ok)
      setLedgerEntries(extractList<InventoryLedgerEntryDto>(ledgerRes.data));
    if (poRes?.ok)
      setPurchaseOrders(extractList<PurchaseOrderDTO>(poRes.data));
    if (clusterRes?.ok && clusterRes.data) setHealthCluster(clusterRes.data);
    if (funnelRes?.ok && funnelRes.data) setAiFunnel(funnelRes.data);
    if (tryOnRes?.ok && tryOnRes.data) setTryOnDemand(tryOnRes.data);
    if (usersRes?.ok) setUsers(extractList<UserSummaryDto>(usersRes.data));
    if (dlqRes?.ok && dlqRes.data) {
      const totalMsgs = (dlqRes.data.queues ?? []).reduce(
        (sum, q) => sum + (Number(q.messageCount) || 0),
        0,
      );
      setDlqCount(totalMsgs);
    }

    setLastUpdatedLabel(formatClock(new Date()));
    setLoading(false);
  }, [
    canReadOrders,
    canReadCatalog,
    canReadInventory,
    canReadPo,
    canReadOpsCluster,
    canReadAiFunnel,
    canReadTryOn,
    canReadUsers,
    canReadDlq,
  ]);

  useEffect(() => {
    void loadDashboardData();
  }, [loadDashboardData, refreshNonce]);

  // Derived operational KPIs
  const metrics = useMemo(() => {
    const totalOrders = Math.max(
      orders.length,
      aiFunnel?.orders?.totalOrders ?? 0,
    );
    const completedOrders = orders.filter(
      (o) =>
        o.status === OrderStatus.DELIVERED ||
        o.status === OrderStatus.COMPLETED,
    ).length;
    const activeInProgressOrders = orders.filter(
      (o) =>
        o.status === OrderStatus.PENDING_RESERVATION ||
        o.status === OrderStatus.AWAITING_PAYMENT ||
        o.status === OrderStatus.CONFIRMED ||
        o.status === OrderStatus.PACKING ||
        o.status === OrderStatus.SHIPPED,
    ).length;
    const pendingOrdersCount = orders.filter(
      (o) =>
        o.status === OrderStatus.PENDING_RESERVATION ||
        o.status === OrderStatus.AWAITING_PAYMENT ||
        o.status === OrderStatus.CONFIRMED ||
        o.status === OrderStatus.PACKING ||
        o.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
    ).length;
    const latePaymentOrders = orders.filter(
      (o) => o.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
    ).length;
    const cancelledOrders = orders.filter(
      (o) =>
        o.status === OrderStatus.CANCELLED ||
        o.status === OrderStatus.FAILED_OUT_OF_STOCK,
    ).length;

    const gmvFromOrders = orders
      .filter(
        (o) =>
          o.status !== OrderStatus.CANCELLED &&
          o.status !== OrderStatus.FAILED_OUT_OF_STOCK,
      )
      .reduce((sum, o) => sum + (Number(o.totalAmountVnd) || 0), 0);
    const totalRevenueVnd =
      gmvFromOrders > 0
        ? gmvFromOrders
        : Number(aiFunnel?.payments?.totalPaidVnd ?? 0);

    const openRmaCount = rmas.filter(
      (r) =>
        r.status !== RmaStatus.RMA_COMPLETED &&
        r.status !== RmaStatus.RMA_REJECTED,
    ).length;
    const totalRmas = Math.max(rmas.length, aiFunnel?.orders?.totalRmas ?? 0);

    const effectiveDoneCount =
      orders.length > 0
        ? completedOrders
        : Number(aiFunnel?.orders?.deliveredOrders ?? 0);
    const orderCompletionPct =
      totalOrders > 0
        ? Math.min(
            100,
            Math.round(
              ((effectiveDoneCount +
                orders.filter((o) => o.status === OrderStatus.CONFIRMED)
                  .length) /
                totalOrders) *
                100,
            ),
          )
        : 0;
    const slaCompletionPct =
      totalOrders > 0
        ? Math.max(
            0,
            Math.min(
              100,
              Math.round(
                ((totalOrders - cancelledOrders - latePaymentOrders) /
                  totalOrders) *
                  100,
              ),
            ),
          )
        : 100;

    // Try-On & AI metrics
    const demandTryOns =
      tryOnDemand?.signalCounts?.THU_THANH_CONG ??
      (tryOnDemand?.items ?? []).reduce(
        (sum, it) => sum + (Number(it.tryOnSessions) || 0),
        0,
      );
    const funnelTryOns =
      aiFunnel?.tryon?.completedSessions ??
      aiFunnel?.tryon?.totalSessions ??
      aiFunnel?.funnel?.tryOnCompleted ??
      0;
    const tryOnSessions = Math.max(demandTryOns, funnelTryOns);

    const demandAtc =
      tryOnDemand?.signalCounts?.THEM_GIO_SAU_THU ??
      (tryOnDemand?.items ?? []).reduce(
        (sum, it) => sum + (Number(it.addToCartCount) || 0),
        0,
      );
    const funnelAtc =
      aiFunnel?.tryon?.addToCartAfterTryonCount ??
      aiFunnel?.tryon?.addToCartAfterTryOnSignals ??
      aiFunnel?.funnel?.addToCartAfterTryOn ??
      0;
    const addToCartAfterTryOn = Math.max(demandAtc, funnelAtc);

    const tryOnToCartRatePct =
      typeof tryOnDemand?.tryOnToCartRatePct === 'number'
        ? Math.round(tryOnDemand.tryOnToCartRatePct)
        : typeof tryOnDemand?.tryOnToCartRate === 'number'
          ? Math.round(tryOnDemand.tryOnToCartRate * 100)
          : tryOnSessions > 0
            ? Math.round((addToCartAfterTryOn / tryOnSessions) * 100)
            : 0;

    const cacheHitPct = Math.round(
      aiFunnel?.cacheHitSavingsPct ??
        aiFunnel?.tryon?.cacheHitSavingsPct ??
        aiFunnel?.tryon?.cacheHitRatePct ??
        0,
    );

    // Inventory metrics (aggregate by unique warehouse+sku rows or fallback to products)
    let outOfStockCount = 0;
    let lowStockCount = 0;
    let healthyStockCount = 0;
    let totalAvailableUnits = 0;
    const warehouseCodes = new Set<string>();

    if (stockLevels.length > 0) {
      for (const row of stockLevels) {
        warehouseCodes.add(row.warehouseCode);
        totalAvailableUnits += Number(row.availableQty) || 0;
        if (row.availableQty <= 0) {
          outOfStockCount += 1;
        } else if (row.availableQty <= 3 || row.lowStockWarning) {
          lowStockCount += 1;
        } else {
          healthyStockCount += 1;
        }
      }
    } else if (products.length > 0) {
      for (const p of products) {
        for (const v of p.variants ?? []) {
          for (const sku of v.skus ?? []) {
            if (!sku.inStock) outOfStockCount += 1;
            else healthyStockCount += 1;
          }
        }
      }
    } else if (aiFunnel?.inventory) {
      outOfStockCount = Number(aiFunnel.inventory.outOfStockCount ?? 0);
      lowStockCount = Number(aiFunnel.inventory.lowStockCount ?? 0);
    }

    const totalSkuRows =
      stockLevels.length > 0
        ? stockLevels.length
        : outOfStockCount + lowStockCount + healthyStockCount;

    // Procurement & IAM metrics
    const totalPos = purchaseOrders.length;
    const openPos = purchaseOrders.filter(
      (po) =>
        po.status !== PurchaseOrderStatus.HOAN_TAT &&
        po.status !== PurchaseOrderStatus.DA_HUY,
    ).length;
    const aiDraftPos = Math.max(
      purchaseOrders.filter((po) => po.status === PurchaseOrderStatus.NHAP_AI)
        .length,
      Number(aiFunnel?.inventory?.pendingAiDraftPosCount ?? 0),
    );
    const totalUsers = users.length;
    const internalStaffCount = users.filter((u) =>
      u.roles.some(
        (r) =>
          r === Role.SUPER_ADMIN ||
          r === Role.CATALOG_AI_OPERATOR ||
          r === Role.WAREHOUSE_MANAGER ||
          r === Role.ORDER_STAFF,
      ),
    ).length;

    // Services health
    const clusterServices = healthCluster?.services ?? [];
    const servicesTotal =
      clusterServices.length > 0
        ? clusterServices.length
        : (liveOverview?.ledger.modules.length ?? 11);
    const servicesReady =
      clusterServices.length > 0
        ? clusterServices.filter((s) => normalizeNodeUp(s.status)).length
        : liveOverview
          ? liveOverview.ledger.modules.filter((m) => m.status === 'active')
              .length
          : bffOnline
            ? servicesTotal
            : 0;

    const ollamaModel =
      aiFunnel?.localAi?.activeMainModel ??
      healthCluster?.ollama?.activeMainModel ??
      'qwen2.5:3b';

    const rmaRatePct =
      totalOrders > 0 ? Number(((totalRmas / totalOrders) * 100).toFixed(1)) : 0;

    return {
      totalOrders,
      completedOrders: effectiveDoneCount,
      activeInProgressOrders,
      pendingOrdersCount,
      latePaymentOrders,
      cancelledOrders,
      totalRevenueVnd,
      openRmaCount,
      totalRmas,
      orderCompletionPct,
      slaCompletionPct,
      rmaRatePct,
      tryOnSessions,
      addToCartAfterTryOn,
      tryOnToCartRatePct,
      cacheHitPct,
      outOfStockCount,
      lowStockCount,
      healthyStockCount,
      totalSkuRows,
      totalAvailableUnits,
      warehouseCount: warehouseCodes.size || 3,
      totalPos,
      openPos,
      aiDraftPos,
      totalUsers,
      internalStaffCount,
      servicesReady,
      servicesTotal,
      ollamaModel,
    };
  }, [
    orders,
    rmas,
    products,
    stockLevels,
    purchaseOrders,
    users,
    healthCluster,
    aiFunnel,
    tryOnDemand,
    liveOverview,
    bffOnline,
  ]);

  // Bubble live badge counts up to shell sidebar & notification popover
  useEffect(() => {
    if (!onLiveBadgesChange) return;
    onLiveBadgesChange({
      pendingOrdersRma: metrics.pendingOrdersCount + metrics.openRmaCount,
      lowStockCount: metrics.lowStockCount + metrics.outOfStockCount,
      openPoCount: metrics.openPos,
      servicesReady: metrics.servicesReady,
      servicesTotal: metrics.servicesTotal,
    });
  }, [
    onLiveBadgesChange,
    metrics.pendingOrdersCount,
    metrics.openRmaCount,
    metrics.lowStockCount,
    metrics.outOfStockCount,
    metrics.openPos,
    metrics.servicesReady,
    metrics.servicesTotal,
  ]);

  // Build real timeframe buckets for Combo Growth Chart & KPI mini sparklines
  const chartBuckets = useMemo<ActivityBucket[]>(() => {
    const now = new Date();
    let daysCount = timeframe === '7d' ? 7 : timeframe === '14d' ? 14 : 10;

    const orderDateMap = new Map<string, { count: number; rev: number }>();
    const ledgerDateMap = new Map<string, number>();
    let earliestTs = now.getTime();

    for (const o of orders) {
      const dt = new Date(o.createdAt);
      if (Number.isNaN(dt.getTime())) continue;
      if (dt.getTime() < earliestTs) earliestTs = dt.getTime();
      const key = toDayKey(dt);
      const curr = orderDateMap.get(key) ?? { count: 0, rev: 0 };
      curr.count += 1;
      if (
        o.status !== OrderStatus.CANCELLED &&
        o.status !== OrderStatus.FAILED_OUT_OF_STOCK
      ) {
        curr.rev += Number(o.totalAmountVnd) || 0;
      }
      orderDateMap.set(key, curr);
    }

    for (const entry of ledgerEntries) {
      const dt = new Date(entry.createdAt);
      if (Number.isNaN(dt.getTime())) continue;
      if (dt.getTime() < earliestTs) earliestTs = dt.getTime();
      const key = toDayKey(dt);
      ledgerDateMap.set(key, (ledgerDateMap.get(key) ?? 0) + 1);
    }

    if (timeframe === 'all') {
      const spanDays = Math.ceil((now.getTime() - earliestTs) / 86_400_000) + 1;
      daysCount = Math.max(7, Math.min(21, spanDays));
    }

    const keys: string[] = [];
    for (let i = daysCount - 1; i >= 0; i -= 1) {
      const d = new Date(now);
      d.setHours(0, 0, 0, 0);
      d.setDate(d.getDate() - i);
      keys.push(toDayKey(d));
    }

    // Distribute live Try-On total across buckets weighted by real daily order/ledger activity (keeping exact total sum)
    const totalTryOnSignal = metrics.tryOnSessions;
    const rawWeights = keys.map((k, idx) => {
      const o = orderDateMap.get(k)?.count ?? 0;
      const l = ledgerDateMap.get(k) ?? 0;
      if (o > 0 || l > 0) return o * 3 + l + 1;
      return idx === keys.length - 1 ? 2 : 0.45;
    });
    const weightSum = rawWeights.reduce((s, w) => s + w, 0) || 1;

    return keys.map((key, idx) => {
      const o = orderDateMap.get(key) ?? { count: 0, rev: 0 };
      const ledgerHits = ledgerDateMap.get(key) ?? 0;
      const allocatedTryOn =
        totalTryOnSignal > 0
          ? Math.round((totalTryOnSignal * (rawWeights[idx] ?? 0)) / weightSum)
          : ledgerHits;

      return {
        key,
        label: formatDayLabel(key),
        fullDate: key,
        orderCount: o.count,
        revenueVnd: o.rev,
        aiActivity: Math.max(allocatedTryOn, o.count > 0 ? o.count : 0),
      };
    });
  }, [orders, ledgerEntries, timeframe, metrics.tryOnSessions]);

  // 7-bar sparkline values for Card 1
  const miniBarHeights = useMemo(() => {
    const slice = chartBuckets.slice(-7);
    const maxVal = Math.max(
      ...slice.map((b) => Math.max(b.orderCount, b.aiActivity > 0 ? 0.5 : 0)),
      1,
    );
    return slice.map((b) => {
      const score = b.orderCount > 0 ? b.orderCount : b.aiActivity > 0 ? 0.35 : 0.12;
      return Math.max(16, Math.round((score / maxVal) * 100));
    });
  }, [chartBuckets]);

  // Combined recent Orders & RMA queue for Row 3 Right
  const recentQueue = useMemo<RecentQueueItem[]>(() => {
    const orderItems: RecentQueueItem[] = orders.map((o) => {
      const statusMeta = resolveOrderStatusMeta(o.status);
      const firstItem = o.items?.[0];
      const itemTitle = firstItem
        ? `${firstItem.productName}${o.items.length > 1 ? ` (+${o.items.length - 1})` : ''}`
        : o.shippingAddress?.recipientName || 'Đơn hàng Atelier';
      return {
        id: `order-${o.id}`,
        kind: 'ORDER',
        code: o.orderCode,
        title: itemTitle,
        subtitle: `${o.shippingAddress?.recipientName || o.customerEmail || 'Khách Atelier'} · ${formatShortDateTime(o.createdAt)}`,
        createdAt: o.createdAt,
        metricLabel: formatVnd(o.totalAmountVnd),
        statusLabel: statusMeta.label,
        statusTone: statusMeta.tone,
        canQuickApproveRma: false,
      };
    });

    const rmaItems: RecentQueueItem[] = rmas.map((r) => {
      const statusMeta = resolveRmaStatusMeta(r.status);
      const isPendingApproval =
        r.status === RmaStatus.RMA_REQUESTED ||
        (r.status as string) === 'REQUESTED';
      return {
        id: `rma-${r.id}`,
        kind: 'RMA',
        code: r.rmaCode,
        title: `${RMA_TYPE_VI[r.type] ?? r.type} · ${RMA_REASON_VI[r.reasonCode] ?? r.reasonCode}`,
        subtitle: `Đơn ${r.orderCode || r.orderId.slice(0, 10)} · SL ${r.qty} · ${formatShortDateTime(r.createdAt)}`,
        createdAt: r.createdAt,
        metricLabel:
          r.refundAmountVnd && r.refundAmountVnd > 0
            ? formatVnd(r.refundAmountVnd)
            : r.exchangeMode === 'INSTANT_2WAY'
              ? 'Đổi 2 chiều'
              : 'Kiểm định QC',
        statusLabel: statusMeta.label,
        statusTone: statusMeta.tone,
        canQuickApproveRma: isPendingApproval && canManageRma,
        rmaId: r.id,
        rmaCode: r.rmaCode,
      };
    });

    // Prioritize pending RMA approvals & late-payment alerts, then newest chronologically
    return [...rmaItems, ...orderItems]
      .sort((a, b) => {
        if (a.canQuickApproveRma !== b.canQuickApproveRma) {
          return a.canQuickApproveRma ? -1 : 1;
        }
        if ((a.statusTone === 'rose') !== (b.statusTone === 'rose')) {
          return a.statusTone === 'rose' ? -1 : 1;
        }
        return (
          new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
        );
      })
      .slice(0, 6);
  }, [orders, rmas, canManageRma]);

  // Category Donut slices from live products
  const categorySlices = useMemo<CategorySlice[]>(() => {
    const counts = new Map<string, number>();
    for (const bucket of CATEGORY_BUCKETS) {
      counts.set(bucket.key, 0);
    }
    for (const product of products) {
      const bucketKey = classifyProductCategory(product);
      counts.set(bucketKey, (counts.get(bucketKey) ?? 0) + 1);
    }

    const total = products.length;
    return CATEGORY_BUCKETS.map((bucket) => {
      const count = counts.get(bucket.key) ?? 0;
      return {
        key: bucket.key,
        label: bucket.label,
        count,
        pct: total > 0 ? Math.round((count / total) * 100) : 0,
        color: darkMode ? bucket.darkColor : bucket.lightColor,
      };
    });
  }, [products, darkMode]);

  const handleQuickApproveRma = async (rmaId: string, rmaCode: string) => {
    setApprovingRmaId(rmaId);
    const res = await adminFetch<unknown>(
      `/api/v1/admin/rma/${encodeURIComponent(rmaId)}/approve`,
      { method: 'POST', body: JSON.stringify({}) },
    );
    if (res.ok) {
      emitPortalToast({
        kind: 'success',
        title: 'DUYỆT NHANH RMA',
        message: `Đã duyệt nhanh phiếu ${rmaCode} từ bảng điều hành tổng quan.`,
      });
      await loadDashboardData();
    } else {
      emitPortalToast({
        kind: 'error',
        title: 'DUYỆT RMA THẤT BẠI',
        message: res.error?.message || `Không thể duyệt phiếu ${rmaCode}.`,
      });
    }
    setApprovingRmaId(null);
  };

  // Combo chart geometry
  const chartGeom = useMemo(() => {
    const width = 640;
    const height = 236;
    const padLeft = 36;
    const padRight = 44;
    const padTop = 20;
    const padBottom = 30;
    const plotW = width - padLeft - padRight;
    const plotH = height - padTop - padBottom;
    const baseY = padTop + plotH;

    const maxOrdersRaw = Math.max(...chartBuckets.map((b) => b.orderCount), 1);
    const maxOrders = Math.max(4, Math.ceil(maxOrdersRaw / 2) * 2);
    const maxAiRaw = Math.max(...chartBuckets.map((b) => b.aiActivity), 1);
    const maxAi = Math.max(4, Math.ceil(maxAiRaw / 4) * 4);

    const stepX =
      chartBuckets.length > 0 ? plotW / chartBuckets.length : plotW;
    const barWidth = Math.min(26, Math.max(10, stepX * 0.34));

    const nodes = chartBuckets.map((bucket, idx) => {
      const cx = padLeft + stepX * idx + stepX / 2;
      const barH =
        bucket.orderCount > 0
          ? Math.max(8, (bucket.orderCount / maxOrders) * plotH)
          : 4;
      const barY = baseY - barH;
      const lineY =
        baseY -
        (bucket.aiActivity > 0
          ? Math.max(10, (bucket.aiActivity / maxAi) * plotH * 0.92)
          : 6);
      return {
        idx,
        bucket,
        cx,
        barX: cx - barWidth / 2,
        barY,
        barH,
        barWidth,
        lineY,
      };
    });

    const curvePoints = nodes.map((n) => ({ x: n.cx, y: n.lineY }));
    const linePath = buildSmoothCurvePath(curvePoints);
    const areaPath =
      nodes.length > 0
        ? `${linePath} L ${nodes[nodes.length - 1]!.cx.toFixed(1)} ${baseY} L ${nodes[0]!.cx.toFixed(1)} ${baseY} Z`
        : '';

    const yTicks = [0, 0.25, 0.5, 0.75, 1].map((ratio) => ({
      y: baseY - ratio * plotH,
      leftLabel: String(Math.round(ratio * maxOrders)),
      rightLabel: String(Math.round(ratio * maxAi)),
    }));

    return {
      width,
      height,
      padLeft,
      padRight,
      padTop,
      baseY,
      nodes,
      linePath,
      areaPath,
      yTicks,
    };
  }, [chartBuckets]);

  // Donut SVG geometry
  const donutSegments = useMemo(() => {
    const r = 56;
    const circumference = 2 * Math.PI * r;
    const total = categorySlices.reduce((sum, s) => sum + s.count, 0);
    let cumulative = 0;

    return categorySlices
      .filter((s) => s.count > 0)
      .map((s) => {
        const fraction = total > 0 ? s.count / total : 0;
        const dash = fraction * circumference;
        const offset = -cumulative * circumference;
        cumulative += fraction;
        return {
          ...s,
          r,
          circumference,
          dash: Math.max(2, dash - 2.5),
          offset,
        };
      });
  }, [categorySlices]);

  // Order status bar distribution for Row 4 Right
  const statusBar = useMemo(() => {
    const done = metrics.completedOrders;
    const processing = metrics.activeInProgressOrders;
    const alerts = metrics.openRmaCount + metrics.latePaymentOrders;
    const sum = done + processing + alerts;

    if (sum === 0) {
      return {
        done: 0,
        processing: 0,
        alerts: 0,
        donePct: 0,
        processingPct: 0,
        alertsPct: 0,
      };
    }

    const donePct = Math.round((done / sum) * 100);
    const processingPct = Math.round((processing / sum) * 100);
    const alertsPct = alerts > 0 ? Math.max(0, 100 - donePct - processingPct) : 0;

    return {
      done,
      processing,
      alerts,
      donePct,
      processingPct,
      alertsPct,
    };
  }, [
    metrics.completedOrders,
    metrics.activeInProgressOrders,
    metrics.openRmaCount,
    metrics.latePaymentOrders,
  ]);

  // Semantic theme tokens (Default Warm Atelier Light vs Optional Dark Espresso)
  const ui = darkMode
    ? {
        card: 'border-[#B08A4A]/25 bg-[#1B140F] shadow-[0_8px_28px_rgba(0,0,0,0.28)]',
        cardInteractive:
          'border-[#B08A4A]/25 bg-[#1B140F] hover:border-[#EBCF8F]/45 shadow-[0_8px_28px_rgba(0,0,0,0.28)]',
        subCard: 'border-[#B08A4A]/20 bg-[#241B14]',
        divider: 'border-[#B08A4A]/18',
        heading: 'text-[#FBF7EF]',
        body: 'text-[#E3D3BC]',
        muted: 'text-[#A8947D]',
        goldText: 'text-[#EBCF8F]',
        iconBox: 'border-[#B08A4A]/30 bg-[#2A1F17] text-[#EBCF8F]',
        pillGold: 'border-[#EBCF8F]/35 bg-[#2D2117] text-[#EBCF8F]',
        pillEmerald: 'border-emerald-500/35 bg-emerald-950/60 text-emerald-300',
        pillAmber: 'border-amber-500/35 bg-amber-950/60 text-amber-300',
        pillRose: 'border-rose-500/35 bg-rose-950/60 text-rose-300',
        pillNeutral: 'border-[#B08A4A]/20 bg-[#261D16] text-[#C8B8A2]',
        tabActive: 'bg-[#C8A15E] text-[#17100B] font-semibold',
        tabIdle:
          'border border-[#B08A4A]/25 bg-[#241B14] text-[#C8B8A2] hover:border-[#EBCF8F]/45 hover:text-[#FBF7EF]',
        chartGrid: 'rgba(235, 207, 143, 0.12)',
        chartAxis: '#A8947D',
        ringTrack: 'rgba(235, 207, 143, 0.16)',
        tooltipBg: 'border-[#EBCF8F]/40 bg-[#140E0A]/95 text-[#FBF7EF]',
      }
    : {
        card: 'border-[#B08A4A]/25 bg-[#FFFDF9] shadow-[0_2px_10px_rgba(28,20,16,0.04)]',
        cardInteractive:
          'border-[#B08A4A]/25 bg-[#FFFDF9] hover:border-[#B08A4A]/60 shadow-[0_2px_10px_rgba(28,20,16,0.04)] hover:shadow-[0_6px_18px_rgba(28,20,16,0.07)]',
        subCard: 'border-[#B08A4A]/20 bg-[#FBF7EF]',
        divider: 'border-[#B08A4A]/18',
        heading: 'text-[#1C1410]',
        body: 'text-[#4A3B31]',
        muted: 'text-[#7A6A5B]',
        goldText: 'text-[#8A672C]',
        iconBox: 'border-[#B08A4A]/30 bg-[#F4EBDA] text-[#8A672C]',
        pillGold: 'border-[#B08A4A]/40 bg-[#F4EBDA] text-[#7A571F]',
        pillEmerald: 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]',
        pillAmber: 'border-[#D9822B]/40 bg-[#FFF6E5] text-[#9A5B13]',
        pillRose: 'border-[#8B2E2E]/35 bg-[#FFF5F4] text-[#8B2E2E]',
        pillNeutral: 'border-[#B08A4A]/25 bg-[#F4EBDA]/70 text-[#5C4B41]',
        tabActive: 'bg-[#1C1410] text-[#EBCF8F] font-semibold',
        tabIdle:
          'border border-[#B08A4A]/30 bg-[#FBF7EF] text-[#5C4B41] hover:border-[#1C1410]/50 hover:text-[#1C1410]',
        chartGrid: 'rgba(176, 138, 74, 0.16)',
        chartAxis: '#7A6A5B',
        ringTrack: 'rgba(176, 138, 74, 0.18)',
        tooltipBg: 'border-[#B08A4A]/50 bg-[#1C1410] text-[#FBF7EF]',
      };

  const pillClassByTone = (tone: RecentQueueItem['statusTone']): string => {
    switch (tone) {
      case 'emerald':
        return ui.pillEmerald;
      case 'gold':
        return ui.pillGold;
      case 'amber':
        return ui.pillAmber;
      case 'rose':
        return ui.pillRose;
      default:
        return ui.pillNeutral;
    }
  };

  const primaryCtaTarget: AdminTabKey = canAccessAdminTab(roles, 'orders')
    ? 'orders'
    : 'catalog';
  const primaryCtaCount =
    primaryCtaTarget === 'orders'
      ? metrics.totalOrders + metrics.totalRmas
      : products.length;
  const primaryCtaLabel =
    primaryCtaTarget === 'orders'
      ? `+ Quản lý Đơn & RMA (${primaryCtaCount})`
      : `+ Quản lý Danh mục (${primaryCtaCount})`;

  const hoveredNode =
    hoveredBarIdx !== null ? chartGeom.nodes[hoveredBarIdx] ?? null : null;

  const kpiCompletionCircumference = 2 * Math.PI * 16;
  const kpiCompletionDash =
    (metrics.orderCompletionPct / 100) * kpiCompletionCircumference;

  const kpiStockCircumference = 2 * Math.PI * 18;
  const healthyRatio =
    metrics.totalSkuRows > 0
      ? metrics.healthyStockCount / metrics.totalSkuRows
      : 1;
  const lowRatio =
    metrics.totalSkuRows > 0 ? metrics.lowStockCount / metrics.totalSkuRows : 0;
  const outRatio =
    metrics.totalSkuRows > 0
      ? metrics.outOfStockCount / metrics.totalSkuRows
      : 0;

  return (
    <div data-testid="dashboard-overview-tab" className="space-y-5">
      {/* ROW 1 — Welcome Control Center Luxury Banner */}
      <section
        data-testid="dashboard-welcome-banner"
        className="relative overflow-hidden rounded-2xl border border-[#B08A4A]/35 bg-gradient-to-r from-[#19120D] via-[#241A13] to-[#1D1510] px-6 py-5 text-[#FBF7EF] shadow-[0_10px_30px_rgba(22,16,12,0.22)]"
      >
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -right-20 -top-20 h-56 w-56 rounded-full bg-[#EBCF8F]/12 blur-3xl"
        />
        <div
          aria-hidden="true"
          className="pointer-events-none absolute -bottom-24 left-1/3 h-48 w-64 rounded-full bg-[#B08A4A]/10 blur-3xl"
        />

        <div className="relative flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
          <div className="min-w-0 space-y-1.5">
            <div className="flex flex-wrap items-center gap-2.5 text-[11px]">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/35 bg-[#2B1F17] px-2.5 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.14em] text-[#EBCF8F]">
                <span
                  className={`h-1.5 w-1.5 rounded-full ${
                    bffOnline ? 'bg-emerald-400' : 'bg-amber-400'
                  }`}
                />
                LIVE CONTROL CENTER
              </span>
              <span className="font-mono text-[11px] text-[#DECBB1]/85">
                Cập nhật lúc {lastUpdatedLabel}
              </span>
              {loading ? (
                <span className="font-mono text-[10px] text-[#EBCF8F]/75">
                  · Đang đồng bộ dữ liệu...
                </span>
              ) : null}
            </div>

            <h2 className="font-editorial text-2xl font-medium leading-snug tracking-wide text-[#FBF7EF] sm:text-[28px]">
              Xin chào Quản trị viên, chúc bạn một ngày điều hành Atelier hiệu
              quả!
            </h2>

            <p className="text-xs text-[#DFCDAE]/80">
              Phiên nội bộ <span className="font-mono text-[#EBCF8F]">{userEmail}</span>{' '}
              · {metrics.totalOrders} đơn hàng · {metrics.totalSkuRows} SKU kho
              · {metrics.servicesReady}/{metrics.servicesTotal} dịch vụ trực
              tuyến
            </p>
          </div>

          <div className="flex shrink-0 flex-wrap items-center gap-2.5">
            <button
              type="button"
              onClick={() => onNavigateTab(primaryCtaTarget)}
              className="inline-flex items-center gap-2 rounded-xl bg-gradient-to-r from-[#C8A15E] to-[#EBCF8F] px-4 py-2.5 text-xs font-semibold text-[#17100B] shadow-sm transition-all hover:brightness-105"
            >
              <span>{primaryCtaLabel}</span>
            </button>

            <button
              type="button"
              onClick={onOpenCopilot}
              className="inline-flex items-center gap-2 rounded-xl border border-[#EBCF8F]/40 bg-[#2A1E16]/90 px-4 py-2.5 text-xs font-medium text-[#F4E3C1] transition-colors hover:border-[#EBCF8F] hover:bg-[#36261B]"
            >
              <SparklesIcon size={15} className="text-[#EBCF8F]" />
              <span>Thẩm định AI &amp; Copilot</span>
            </button>
          </div>
        </div>
      </section>

      {/* ROW 2 — 4 KPI Sparkline Cards */}
      <section
        data-testid="dashboard-kpi-grid"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        {/* KPI 1: Orders & Revenue */}
        <article
          onClick={() =>
            canAccessAdminTab(roles, 'orders') && onNavigateTab('orders')
          }
          className={`flex cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-all ${ui.cardInteractive}`}
        >
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${ui.iconBox}`}
              >
                <AdminNavIcon tab="orders" size={15} />
              </span>
              <p className={`whitespace-nowrap text-xs font-medium ${ui.muted}`}>
                Đơn hàng &amp; Doanh thu
              </p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p
                  className={`font-mono text-[26px] font-bold leading-none tabular-nums ${ui.heading}`}
                >
                  {metrics.totalOrders}
                </p>
                <p
                  className={`mt-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums ${ui.goldText}`}
                >
                  {formatVndCompact(metrics.totalRevenueVnd)} GMV
                </p>
              </div>

              {/* Mini 7-bar sparkline + Circular completion ring */}
              <div className="flex shrink-0 items-center gap-2">
                <svg
                  width="58"
                  height="38"
                  viewBox="0 0 62 40"
                  aria-hidden="true"
                  className="overflow-visible"
                >
                  <defs>
                    <linearGradient
                      id="admMiniBarGrad"
                      x1="0"
                      y1="0"
                      x2="0"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#EBCF8F" />
                      <stop offset="100%" stopColor="#B08A4A" />
                    </linearGradient>
                  </defs>
                  {miniBarHeights.map((pct, idx) => {
                    const h = Math.max(5, (pct / 100) * 32);
                    return (
                      <rect
                        key={`mb-${idx}`}
                        x={idx * 9}
                        y={38 - h}
                        width="5.5"
                        height={h}
                        rx="2.5"
                        fill="url(#admMiniBarGrad)"
                        opacity={idx === miniBarHeights.length - 1 ? 1 : 0.72}
                      />
                    );
                  })}
                </svg>

                <div className="relative flex h-10 w-10 items-center justify-center">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 40 40"
                    aria-hidden="true"
                    className="-rotate-90"
                  >
                    <circle
                      cx="20"
                      cy="20"
                      r="16"
                      fill="none"
                      stroke={ui.ringTrack}
                      strokeWidth="3.2"
                    />
                    <circle
                      cx="20"
                      cy="20"
                      r="16"
                      fill="none"
                      stroke={darkMode ? '#EBCF8F' : '#B08A4A'}
                      strokeWidth="3.2"
                      strokeLinecap="round"
                      strokeDasharray={`${kpiCompletionDash} ${kpiCompletionCircumference}`}
                    />
                  </svg>
                  <span
                    className={`absolute font-mono text-[9px] font-bold tabular-nums ${ui.heading}`}
                  >
                    {metrics.orderCompletionPct}%
                  </span>
                </div>
              </div>
            </div>
          </div>

          <div
            className={`mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11px] ${ui.divider}`}
          >
            <span className={`truncate ${ui.muted}`}>
              {metrics.completedOrders} hoàn tất · {metrics.pendingOrdersCount}{' '}
              chờ xử lý
            </span>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillEmerald}`}
            >
              {metrics.orderCompletionPct}% hoàn tất
            </span>
          </div>
        </article>

        {/* KPI 2: AI Try-On & Conversion */}
        <article
          onClick={() =>
            canAccessAdminTab(roles, 'tryon-hub') && onNavigateTab('tryon-hub')
          }
          className={`flex cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-all ${ui.cardInteractive}`}
        >
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${ui.iconBox}`}
              >
                <AdminNavIcon tab="tryon-hub" size={15} />
              </span>
              <p className={`whitespace-nowrap text-xs font-medium ${ui.muted}`}>
                Phòng Thử Đồ AI
              </p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p
                  className={`font-mono text-[26px] font-bold leading-none tabular-nums ${ui.heading}`}
                >
                  {metrics.tryOnSessions}
                  <span className={`ml-1.5 text-xs font-medium ${ui.muted}`}>
                    lượt
                  </span>
                </p>
                <p
                  className={`mt-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums ${ui.goldText}`}
                >
                  {metrics.tryOnToCartRatePct}% chuyển đổi giỏ
                </p>
              </div>

              {/* Smooth SVG wave line sparkline */}
              <svg
                width="76"
                height="42"
                viewBox="0 0 78 44"
                aria-hidden="true"
                className="shrink-0"
              >
                <defs>
                  <linearGradient id="admWaveFill" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#B08A4A" stopOpacity="0.35" />
                    <stop offset="100%" stopColor="#B08A4A" stopOpacity="0.02" />
                  </linearGradient>
                </defs>
                <path
                  d="M 4 32 C 16 32, 22 28, 30 22 C 38 14, 44 10, 50 18 C 56 26, 64 26, 74 22 L 74 40 L 4 40 Z"
                  fill="url(#admWaveFill)"
                />
                <path
                  d="M 4 32 C 16 32, 22 28, 30 22 C 38 14, 44 10, 50 18 C 56 26, 64 26, 74 22"
                  fill="none"
                  stroke={darkMode ? '#EBCF8F' : '#B08A4A'}
                  strokeWidth="2"
                  strokeLinecap="round"
                />
                <circle
                  cx="44"
                  cy="13.5"
                  r="3"
                  fill={darkMode ? '#1B140F' : '#FFFDF9'}
                  stroke={darkMode ? '#EBCF8F' : '#8A672C'}
                  strokeWidth="2"
                />
              </svg>
            </div>
          </div>

          <div
            className={`mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11px] ${ui.divider}`}
          >
            <span className={`truncate ${ui.muted}`}>
              Cache {metrics.cacheHitPct}% · {metrics.addToCartAfterTryOn} thêm
              giỏ
            </span>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillGold}`}
            >
              AI VTON &amp; RAG
            </span>
          </div>
        </article>

        {/* KPI 3: Inventory SKU & Safety Stock Zones */}
        <article
          onClick={() =>
            canAccessAdminTab(roles, 'inventory') && onNavigateTab('inventory')
          }
          className={`flex cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-all ${ui.cardInteractive}`}
        >
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${ui.iconBox}`}
              >
                <BoxIcon size={15} />
              </span>
              <p className={`whitespace-nowrap text-xs font-medium ${ui.muted}`}>
                Kho SKU &amp; Vùng tồn
              </p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p
                  className={`font-mono text-[26px] font-bold leading-none tabular-nums ${ui.heading}`}
                >
                  {metrics.totalSkuRows}
                  <span className={`ml-1.5 text-xs font-medium ${ui.muted}`}>
                    SKU
                  </span>
                </p>
                <p
                  className={`mt-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums ${ui.goldText}`}
                >
                  {new Intl.NumberFormat('vi-VN').format(
                    metrics.totalAvailableUnits,
                  )}{' '}
                  sp sẵn bán
                </p>
              </div>

              {/* Ring gauge + 3-color stock legend */}
              <div className="flex shrink-0 items-center gap-2">
                <div className="relative flex h-10 w-10 items-center justify-center">
                  <svg
                    width="40"
                    height="40"
                    viewBox="0 0 44 44"
                    aria-hidden="true"
                    className="-rotate-90"
                  >
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke={ui.ringTrack}
                      strokeWidth="3.5"
                    />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke="#2E6B47"
                      strokeWidth="3.5"
                      strokeDasharray={`${healthyRatio * kpiStockCircumference} ${kpiStockCircumference}`}
                    />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke="#D9822B"
                      strokeWidth="3.5"
                      strokeDasharray={`${lowRatio * kpiStockCircumference} ${kpiStockCircumference}`}
                      strokeDashoffset={`${-healthyRatio * kpiStockCircumference}`}
                    />
                    <circle
                      cx="22"
                      cy="22"
                      r="18"
                      fill="none"
                      stroke="#A63A3A"
                      strokeWidth="3.5"
                      strokeDasharray={`${outRatio * kpiStockCircumference} ${kpiStockCircumference}`}
                      strokeDashoffset={`${-(healthyRatio + lowRatio) * kpiStockCircumference}`}
                    />
                  </svg>
                  <span
                    className={`absolute font-mono text-[8px] font-bold tabular-nums ${ui.heading}`}
                  >
                    {metrics.healthyStockCount}/{metrics.totalSkuRows}
                  </span>
                </div>

                <div className="space-y-0.5 font-mono text-[9.5px] leading-tight">
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#A63A3A]" />
                    <span className={ui.muted}>Hết:</span>
                    <strong className={ui.heading}>
                      {metrics.outOfStockCount}
                    </strong>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#D9822B]" />
                    <span className={ui.muted}>Thấp:</span>
                    <strong className={ui.heading}>
                      {metrics.lowStockCount}
                    </strong>
                  </div>
                  <div className="flex items-center gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-[#2E6B47]" />
                    <span className={ui.muted}>Ổn:</span>
                    <strong className={ui.heading}>
                      {metrics.healthyStockCount}
                    </strong>
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            className={`mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11px] ${ui.divider}`}
          >
            <span className={`truncate ${ui.muted}`}>
              {metrics.warehouseCount} kho đồng bộ tồn thực
            </span>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                metrics.outOfStockCount > 0 ? ui.pillAmber : ui.pillGold
              }`}
            >
              Kho Trung Tâm
            </span>
          </div>
        </article>

        {/* KPI 4: B2B Procurement & IAM Staff */}
        <article
          onClick={() =>
            canAccessAdminTab(roles, 'procurement')
              ? onNavigateTab('procurement')
              : canAccessAdminTab(roles, 'iam') && onNavigateTab('iam')
          }
          className={`flex cursor-pointer flex-col justify-between rounded-2xl border p-4 transition-all ${ui.cardInteractive}`}
        >
          <div>
            <div className="flex items-center gap-2">
              <span
                className={`inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border ${ui.iconBox}`}
              >
                <AdminNavIcon tab="procurement" size={15} />
              </span>
              <p className={`whitespace-nowrap text-xs font-medium ${ui.muted}`}>
                Thu mua B2B &amp; IAM
              </p>
            </div>

            <div className="mt-3 flex items-end justify-between gap-2">
              <div className="min-w-0">
                <p
                  className={`font-mono text-[26px] font-bold leading-none tabular-nums ${ui.heading}`}
                >
                  {metrics.totalPos + metrics.totalUsers}
                </p>
                <p
                  className={`mt-1.5 whitespace-nowrap font-mono text-[11px] tabular-nums ${ui.goldText}`}
                >
                  {metrics.openPos} PO mở · {metrics.totalUsers || roles.length}{' '}
                  tài khoản
                </p>
              </div>

              {/* Dual horizontal mini progress bars */}
              <div className="w-24 shrink-0 space-y-2">
                <div>
                  <div className="flex items-center justify-between font-mono text-[9.5px]">
                    <span className={ui.muted}>PO B2B</span>
                    <strong className={ui.heading}>{metrics.totalPos}</strong>
                  </div>
                  <div
                    className={`mt-1 h-1.5 w-full overflow-hidden rounded-full ${
                      darkMode ? 'bg-[#2E2219]' : 'bg-[#EDE3D2]'
                    }`}
                  >
                    <div
                      className="h-full rounded-full bg-gradient-to-r from-[#B08A4A] to-[#EBCF8F]"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(
                            18,
                            metrics.totalPos > 0
                              ? Math.round(
                                  ((metrics.totalPos - metrics.openPos + 1) /
                                    (metrics.totalPos + 1)) *
                                    100,
                                )
                              : 24,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between font-mono text-[9.5px]">
                    <span className={ui.muted}>IAM</span>
                    <strong className={ui.heading}>
                      {metrics.totalUsers || roles.length}
                    </strong>
                  </div>
                  <div
                    className={`mt-1 h-1.5 w-full overflow-hidden rounded-full ${
                      darkMode ? 'bg-[#2E2219]' : 'bg-[#EDE3D2]'
                    }`}
                  >
                    <div
                      className="h-full rounded-full bg-[#3A6B52]"
                      style={{
                        width: `${Math.min(
                          100,
                          Math.max(
                            28,
                            metrics.totalUsers > 0
                              ? Math.round(
                                  (Math.max(1, metrics.internalStaffCount) /
                                    metrics.totalUsers) *
                                    100,
                                )
                              : 65,
                          ),
                        )}%`,
                      }}
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div
            className={`mt-3.5 flex items-center justify-between gap-2 border-t pt-2.5 text-[11px] ${ui.divider}`}
          >
            <span className={`truncate ${ui.muted}`}>
              {metrics.aiDraftPos} nháp NHAP_AI · {roles.length} vai trò phiên
            </span>
            <span
              className={`shrink-0 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillGold}`}
            >
              RBAC &amp; B2B
            </span>
          </div>
        </article>
      </section>

      {/* ROW 3 — Asymmetric 2-Column Command Grid (Combo Growth Chart + Recent Orders & RMA Queue) */}
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.62fr_1fr]">
        {/* Left: Combo Growth Chart */}
        <div className={`rounded-2xl border p-5 ${ui.card}`}>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3
                className={`font-editorial text-xl font-semibold tracking-wide ${ui.heading}`}
              >
                Biểu đồ Tăng trưởng Đơn hàng &amp; Lượt Thử Đồ AI
              </h3>
              <p className={`mt-0.5 text-xs ${ui.muted}`}>
                Phân tích đa chiều thời gian thực từ Order-RMA (:4006) &amp; AI
                Try-On Studio (:4009)
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3 text-[11px]">
              <span className={`inline-flex items-center gap-1.5 ${ui.body}`}>
                <span className="h-2.5 w-2.5 rounded-sm bg-gradient-to-b from-[#EBCF8F] to-[#B08A4A]" />
                Số đơn hàng (Cột)
              </span>
              <span className={`inline-flex items-center gap-1.5 ${ui.body}`}>
                <span
                  className="h-0.5 w-3.5 rounded-full"
                  style={{
                    backgroundColor: darkMode ? '#5EB286' : '#2E6B47',
                  }}
                />
                Lượt thử AI &amp; Doanh thu (Miền)
              </span>
            </div>
          </div>

          {/* Timeframe Selector Pills */}
          <div
            data-testid="dashboard-timeframe-tabs"
            className="mt-4 flex flex-wrap items-center justify-between gap-3"
          >
            <div className="inline-flex items-center gap-1.5">
              {(
                [
                  ['7d', '7 ngày'],
                  ['14d', '14 ngày'],
                  ['all', 'Tất cả'],
                ] as const
              ).map(([key, label]) => (
                <button
                  key={key}
                  type="button"
                  data-testid={`timeframe-${key}`}
                  onClick={() => {
                    setTimeframe(key);
                    setHoveredBarIdx(null);
                  }}
                  className={`rounded-lg px-3 py-1 text-xs transition-colors ${
                    timeframe === key ? ui.tabActive : ui.tabIdle
                  }`}
                >
                  {label}
                </button>
              ))}
            </div>

            <div
              className={`flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums ${ui.muted}`}
            >
              <span>
                Đơn kỳ:{' '}
                <strong className={ui.heading}>
                  {chartBuckets.reduce((s, b) => s + b.orderCount, 0)}
                </strong>
              </span>
              <span>
                GMV:{' '}
                <strong className={ui.goldText}>
                  {formatVndCompact(
                    chartBuckets.reduce((s, b) => s + b.revenueVnd, 0),
                  )}
                </strong>
              </span>
            </div>
          </div>

          {/* Responsive SVG Combo Chart with Interactive Hover Tooltip */}
          <div className="relative mt-4">
            {hoveredNode ? (
              <div
                className={`pointer-events-none absolute right-2 top-0 z-10 rounded-xl border px-3 py-2 text-[11px] shadow-lg backdrop-blur-sm ${ui.tooltipBg}`}
              >
                <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[#EBCF8F]">
                  Ngày {hoveredNode.bucket.label} ({hoveredNode.bucket.fullDate})
                </p>
                <div className="mt-1 space-y-0.5 font-mono tabular-nums">
                  <p>
                    Đơn hàng:{' '}
                    <strong className="text-[#EBCF8F]">
                      {hoveredNode.bucket.orderCount}
                    </strong>
                  </p>
                  <p>
                    Doanh thu:{' '}
                    <strong>{formatVnd(hoveredNode.bucket.revenueVnd)}</strong>
                  </p>
                  <p>
                    Tín hiệu AI / Kho:{' '}
                    <strong className="text-emerald-300">
                      {hoveredNode.bucket.aiActivity}
                    </strong>
                  </p>
                </div>
              </div>
            ) : null}

            <svg
              viewBox={`0 0 ${chartGeom.width} ${chartGeom.height}`}
              role="img"
              aria-label="Biểu đồ Tăng trưởng Đơn hàng và Lượt Thử Đồ AI"
              className="h-[245px] w-full select-none"
              onMouseLeave={() => setHoveredBarIdx(null)}
            >
              <defs>
                <linearGradient
                  id="admComboBarGrad"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop offset="0%" stopColor="#EBCF8F" />
                  <stop offset="55%" stopColor="#C49A55" />
                  <stop offset="100%" stopColor="#8A672C" stopOpacity="0.85" />
                </linearGradient>
                <linearGradient
                  id="admComboAreaGrad"
                  x1="0"
                  y1="0"
                  x2="0"
                  y2="1"
                >
                  <stop
                    offset="0%"
                    stopColor={darkMode ? '#5EB286' : '#2E6B47'}
                    stopOpacity="0.30"
                  />
                  <stop
                    offset="100%"
                    stopColor={darkMode ? '#5EB286' : '#2E6B47'}
                    stopOpacity="0.02"
                  />
                </linearGradient>
              </defs>

              {/* Horizontal dashed gridlines & dual Y-axes */}
              {chartGeom.yTicks.map((tick, idx) => (
                <g key={`yt-${idx}`}>
                  <line
                    x1={chartGeom.padLeft}
                    x2={chartGeom.width - chartGeom.padRight}
                    y1={tick.y}
                    y2={tick.y}
                    stroke={ui.chartGrid}
                    strokeDasharray={idx === 0 ? undefined : '3 4'}
                  />
                  <text
                    x={chartGeom.padLeft - 8}
                    y={tick.y + 3.5}
                    textAnchor="end"
                    fontSize="10"
                    fill={ui.chartAxis}
                    className="font-mono"
                  >
                    {tick.leftLabel}
                  </text>
                  <text
                    x={chartGeom.width - chartGeom.padRight + 8}
                    y={tick.y + 3.5}
                    textAnchor="start"
                    fontSize="10"
                    fill={ui.chartAxis}
                    className="font-mono"
                  >
                    {tick.rightLabel}
                  </text>
                </g>
              ))}

              {/* Smooth area fill under AI/Revenue trend */}
              {chartGeom.areaPath ? (
                <path d={chartGeom.areaPath} fill="url(#admComboAreaGrad)" />
              ) : null}

              {/* Vertical rounded gradient bars for Orders */}
              {chartGeom.nodes.map((node) => {
                const isHovered = hoveredBarIdx === node.idx;
                return (
                  <g
                    key={node.bucket.key}
                    onMouseEnter={() => setHoveredBarIdx(node.idx)}
                    className="cursor-pointer"
                  >
                    {/* Invisible wide hit column for smooth hover */}
                    <rect
                      x={node.cx - Math.max(14, node.barWidth)}
                      y={chartGeom.padTop}
                      width={Math.max(28, node.barWidth * 2)}
                      height={chartGeom.baseY - chartGeom.padTop}
                      fill="transparent"
                    />
                    {isHovered ? (
                      <line
                        x1={node.cx}
                        x2={node.cx}
                        y1={chartGeom.padTop}
                        y2={chartGeom.baseY}
                        stroke={darkMode ? '#EBCF8F' : '#B08A4A'}
                        strokeOpacity="0.45"
                        strokeDasharray="3 3"
                      />
                    ) : null}
                    <rect
                      x={node.barX}
                      y={node.barY}
                      width={node.barWidth}
                      height={node.barH}
                      rx="5"
                      fill="url(#admComboBarGrad)"
                      opacity={
                        hoveredBarIdx === null || isHovered
                          ? node.bucket.orderCount > 0
                            ? 0.96
                            : 0.35
                          : 0.45
                      }
                    />
                  </g>
                );
              })}

              {/* Smooth Cubic Bezier Trend Curve */}
              {chartGeom.linePath ? (
                <path
                  d={chartGeom.linePath}
                  fill="none"
                  stroke={darkMode ? '#5EB286' : '#2E6B47'}
                  strokeWidth="2.25"
                  strokeLinecap="round"
                />
              ) : null}

              {/* Trend Data Nodes & X-Axis Labels */}
              {chartGeom.nodes.map((node) => {
                const isHovered = hoveredBarIdx === node.idx;
                const showLabel =
                  chartGeom.nodes.length <= 10 ||
                  node.idx % 2 === 0 ||
                  node.idx === chartGeom.nodes.length - 1;
                return (
                  <g key={`pt-${node.bucket.key}`}>
                    <circle
                      cx={node.cx}
                      cy={node.lineY}
                      r={isHovered ? 5 : 3.4}
                      fill={darkMode ? '#1B140F' : '#FFFDF9'}
                      stroke={darkMode ? '#5EB286' : '#2E6B47'}
                      strokeWidth={isHovered ? 2.5 : 2}
                    />
                    {showLabel ? (
                      <text
                        x={node.cx}
                        y={chartGeom.height - 8}
                        textAnchor="middle"
                        fontSize="10"
                        fill={
                          isHovered
                            ? darkMode
                              ? '#EBCF8F'
                              : '#1C1410'
                            : ui.chartAxis
                        }
                        fontWeight={isHovered ? '700' : '400'}
                        className="font-mono"
                      >
                        {node.bucket.label}
                      </text>
                    ) : null}
                  </g>
                );
              })}
            </svg>
          </div>
        </div>

        {/* Right: Recent Orders & RMA Quick Action Queue */}
        <div
          className={`flex flex-col justify-between rounded-2xl border p-5 ${ui.card}`}
        >
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3
                  className={`font-editorial text-xl font-semibold tracking-wide ${ui.heading}`}
                >
                  Đơn hàng &amp; Yêu cầu RMA gần đây
                </h3>
                <p className={`mt-0.5 text-xs ${ui.muted}`}>
                  Duyệt hoặc chuyển xử lý nhanh ngay tại chỗ
                </p>
              </div>
              {canAccessAdminTab(roles, 'orders') ? (
                <button
                  type="button"
                  onClick={() => onNavigateTab('orders')}
                  className={`shrink-0 text-xs font-medium transition-colors hover:underline ${ui.goldText}`}
                >
                  Xem tất cả ({orders.length + rmas.length})
                </button>
              ) : null}
            </div>

            <div className="mt-4 space-y-2.5">
              {!canReadOrders ? (
                <div
                  className={`rounded-xl border p-5 text-center text-xs ${ui.subCard}`}
                >
                  <p className={`font-medium ${ui.heading}`}>
                    Phạm vi vai trò hiện tại không bao gồm sổ Đơn hàng &amp; RMA
                  </p>
                  <p className={`mt-1 ${ui.muted}`}>
                    Bạn có thể quản lý danh mục sản phẩm hoặc tín hiệu thử đồ AI
                    ngay từ thanh điều hướng.
                  </p>
                  <button
                    type="button"
                    onClick={() => onNavigateTab('catalog')}
                    className={`mt-3 rounded-lg border px-3 py-1.5 text-[11px] font-medium ${ui.pillGold}`}
                  >
                    Mở Danh mục SPU/SKU →
                  </button>
                </div>
              ) : recentQueue.length === 0 ? (
                <div
                  className={`rounded-xl border p-6 text-center text-xs ${ui.subCard} ${ui.muted}`}
                >
                  {loading
                    ? 'Đang tải danh sách đơn hàng & yêu cầu RMA...'
                    : 'Chưa có đơn hàng hoặc phiếu RMA nào cần xử lý.'}
                </div>
              ) : (
                recentQueue.map((item) => (
                  <div
                    key={item.id}
                    className={`flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${ui.subCard}`}
                  >
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <span
                        className={`inline-flex h-9 w-9 shrink-0 items-center justify-center rounded-lg border font-mono text-[10px] font-bold ${
                          item.kind === 'RMA' ? ui.pillAmber : ui.iconBox
                        }`}
                      >
                        {item.kind === 'RMA' ? 'RMA' : 'TX'}
                      </span>

                      <div className="min-w-0 flex-1">
                        <div className="flex min-w-0 items-center gap-1.5">
                          <span
                            className={`shrink-0 whitespace-nowrap font-mono text-xs font-semibold ${ui.heading}`}
                          >
                            {item.code}
                          </span>
                          <span
                            className={`min-w-0 truncate text-xs ${ui.body}`}
                            title={item.title}
                          >
                            · {item.title}
                          </span>
                        </div>
                        <p className={`mt-0.5 truncate text-[11px] ${ui.muted}`}>
                          {item.subtitle}
                        </p>
                      </div>
                    </div>

                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <span
                        className={`font-mono text-[11px] font-semibold tabular-nums ${ui.heading}`}
                      >
                        {item.metricLabel}
                      </span>

                      <div className="flex items-center gap-1.5">
                        {item.canQuickApproveRma &&
                        item.rmaId &&
                        item.rmaCode ? (
                          <button
                            type="button"
                            disabled={approvingRmaId === item.rmaId}
                            onClick={() =>
                              void handleQuickApproveRma(
                                item.rmaId!,
                                item.rmaCode!,
                              )
                            }
                            className="rounded-md bg-[#1C1410] px-2 py-0.5 text-[10px] font-semibold text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            {approvingRmaId === item.rmaId
                              ? 'Đang duyệt...'
                              : 'Duyệt nhanh'}
                          </button>
                        ) : (
                          <span
                            className={`rounded-md border px-2 py-0.5 text-[10px] font-medium ${pillClassByTone(
                              item.statusTone,
                            )}`}
                          >
                            {item.statusLabel}
                          </span>
                        )}

                        {canAccessAdminTab(roles, 'orders') ? (
                          <button
                            type="button"
                            aria-label={`Mở chi tiết ${item.code}`}
                            onClick={() => onNavigateTab('orders')}
                            className={`inline-flex h-6 w-6 items-center justify-center rounded-md border transition-colors ${ui.tabIdle}`}
                          >
                            <ChevronRightIcon size={13} />
                          </button>
                        ) : null}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        </div>
      </section>

      {/* ROW 4 — Bottom 2-Column Analytical Grid (Category Donut + Order & Cluster Status) */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Bottom Left: Category Structure Donut Chart */}
        <div className={`rounded-2xl border p-5 ${ui.card}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3
                className={`font-editorial text-xl font-semibold tracking-wide ${ui.heading}`}
              >
                Biểu đồ Donut Cơ cấu Danh mục &amp; Thiết kế
              </h3>
              <p className={`mt-0.5 text-xs ${ui.muted}`}>
                Tỷ trọng phân bổ thiết kế SPU hiện hành trên Storefront Tầm Xuân
              </p>
            </div>
            {canAccessAdminTab(roles, 'catalog') ? (
              <button
                type="button"
                onClick={() => onNavigateTab('catalog')}
                className={`shrink-0 text-xs font-medium hover:underline ${ui.goldText}`}
              >
                Chi tiết →
              </button>
            ) : null}
          </div>

          <div className="mt-5 flex flex-col items-center gap-6 sm:flex-row">
            {/* SVG Donut */}
            <div className="relative flex h-44 w-44 shrink-0 items-center justify-center">
              <svg
                viewBox="0 0 150 150"
                className="h-44 w-44 -rotate-90"
                role="img"
                aria-label="Biểu đồ Donut cơ cấu danh mục thiết kế"
              >
                <circle
                  cx="75"
                  cy="75"
                  r="56"
                  fill="none"
                  stroke={ui.ringTrack}
                  strokeWidth="16"
                />
                {donutSegments.map((seg) => {
                  const isActive =
                    hoveredDonutKey === null || hoveredDonutKey === seg.key;
                  return (
                    <circle
                      key={seg.key}
                      cx="75"
                      cy="75"
                      r={seg.r}
                      fill="none"
                      stroke={seg.color}
                      strokeWidth={hoveredDonutKey === seg.key ? 19 : 16}
                      strokeLinecap="butt"
                      strokeDasharray={`${seg.dash} ${seg.circumference}`}
                      strokeDashoffset={seg.offset}
                      opacity={isActive ? 1 : 0.35}
                      className="cursor-pointer transition-all duration-200"
                      onMouseEnter={() => setHoveredDonutKey(seg.key)}
                      onMouseLeave={() => setHoveredDonutKey(null)}
                    />
                  );
                })}
              </svg>

              <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center text-center">
                <span
                  className={`font-mono text-[10px] uppercase tracking-[0.16em] ${ui.muted}`}
                >
                  TỔNG
                </span>
                <span
                  className={`font-mono text-2xl font-bold tabular-nums ${ui.heading}`}
                >
                  {products.length}
                </span>
                <span className={`text-[10px] ${ui.muted}`}>thiết kế</span>
              </div>
            </div>

            {/* Category Breakdown List */}
            <div className="w-full flex-1 space-y-2.5">
              {categorySlices.map((slice) => (
                <div
                  key={slice.key}
                  onMouseEnter={() => setHoveredDonutKey(slice.key)}
                  onMouseLeave={() => setHoveredDonutKey(null)}
                  className={`flex items-center justify-between gap-3 rounded-xl border px-3 py-2 text-xs transition-colors ${
                    hoveredDonutKey === slice.key
                      ? darkMode
                        ? 'border-[#EBCF8F]/45 bg-[#2A1F17]'
                        : 'border-[#B08A4A]/50 bg-[#F4EBDA]/75'
                      : ui.subCard
                  }`}
                >
                  <div className="flex min-w-0 items-center gap-2.5">
                    <span
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: slice.color }}
                    />
                    <span className={`truncate font-medium ${ui.heading}`}>
                      {slice.label}
                    </span>
                  </div>
                  <div className="flex shrink-0 items-center gap-2 font-mono text-[11px] tabular-nums">
                    <strong className={ui.heading}>{slice.count} mẫu</strong>
                    <span className={ui.muted}>({slice.pct}%)</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Bottom Right: Order Status Structure & System Microservices Health */}
        <div
          className={`flex flex-col justify-between rounded-2xl border p-5 ${ui.card}`}
        >
          <div>
            <div className="flex items-start justify-between gap-2">
              <div>
                <h3
                  className={`font-editorial text-xl font-semibold tracking-wide ${ui.heading}`}
                >
                  Cơ cấu Trạng thái Đơn &amp; Sức khỏe Hệ thống
                </h3>
                <p className={`mt-0.5 text-xs ${ui.muted}`}>
                  Phân bổ tỷ lệ xử lý đơn hàng toàn hệ thống &amp; độ sẵn sàng
                  cụm dịch vụ
                </p>
              </div>
              <span
                className={`inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-xl border ${ui.iconBox}`}
              >
                <AdminNavIcon tab="ops" size={16} />
              </span>
            </div>

            {/* Multi-segment Horizontal Status Bar */}
            <div className={`mt-5 rounded-xl border p-4 ${ui.subCard}`}>
              <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-medium">
                <span
                  className={`inline-flex items-center gap-1.5 ${
                    darkMode ? 'text-emerald-300' : 'text-[#2E6B47]'
                  }`}
                >
                  <CheckCircleIcon size={14} />
                  <span>
                    Đã giao / Hoàn tất:{' '}
                    <strong className="font-mono tabular-nums">
                      {statusBar.done}
                    </strong>
                  </span>
                </span>
                <span className={ui.goldText}>
                  Đang xử lý:{' '}
                  <strong className="font-mono tabular-nums">
                    {statusBar.processing}
                  </strong>
                </span>
                <span
                  className={`inline-flex items-center gap-1 ${
                    darkMode ? 'text-rose-300' : 'text-[#A63A3A]'
                  }`}
                >
                  <AlertTriangleIcon size={13} />
                  <span>
                    RMA / Cảnh báo trễ:{' '}
                    <strong className="font-mono tabular-nums">
                      {statusBar.alerts}
                    </strong>
                  </span>
                </span>
              </div>

              <div
                className={`mt-3 flex h-3 w-full overflow-hidden rounded-full ${
                  darkMode ? 'bg-[#17100B]' : 'bg-[#E9DEC9]'
                }`}
              >
                {statusBar.donePct > 0 ? (
                  <div
                    className="h-full bg-[#2E6B47] transition-all duration-300"
                    style={{ width: `${statusBar.donePct}%` }}
                  />
                ) : null}
                {statusBar.processingPct > 0 ? (
                  <div
                    className="h-full bg-[#C8A15E] transition-all duration-300"
                    style={{ width: `${statusBar.processingPct}%` }}
                  />
                ) : null}
                {statusBar.alertsPct > 0 ? (
                  <div
                    className="h-full bg-[#A63A3A] transition-all duration-300"
                    style={{ width: `${statusBar.alertsPct}%` }}
                  />
                ) : null}
              </div>
            </div>
          </div>

          {/* 2 Bottom Summary Sub-cards */}
          <div className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className={`rounded-xl border p-4 ${ui.subCard}`}>
              <p className={`text-[11px] font-medium ${ui.muted}`}>
                Tỷ lệ hoàn tất SLA
              </p>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <p
                  className={`font-mono text-2xl font-bold tabular-nums ${ui.heading}`}
                >
                  {metrics.slaCompletionPct}%
                </p>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillEmerald}`}
                >
                  RMA {metrics.rmaRatePct}%
                </span>
              </div>
              <p className={`mt-1.5 text-[11px] ${ui.muted}`}>
                {metrics.latePaymentOrders === 0
                  ? '0 cảnh báo thanh toán trễ · Đúng chuẩn đóng gói'
                  : `${metrics.latePaymentOrders} đơn thanh toán trễ cần hoàn tiền`}
              </p>
            </div>

            <div
              onClick={() =>
                canAccessAdminTab(roles, 'ops') && onNavigateTab('ops')
              }
              className={`rounded-xl border p-4 transition-colors ${ui.subCard} ${
                canAccessAdminTab(roles, 'ops')
                  ? 'cursor-pointer hover:border-[#B08A4A]/55'
                  : ''
              }`}
            >
              <p className={`text-[11px] font-medium ${ui.muted}`}>
                Sức khỏe Microservices &amp; DLQ
              </p>
              <div className="mt-1.5 flex items-baseline justify-between gap-2">
                <p
                  className={`font-mono text-2xl font-bold tabular-nums ${ui.heading}`}
                >
                  {metrics.servicesReady}/{metrics.servicesTotal}
                  <span className={`ml-1 text-xs font-medium ${ui.muted}`}>
                    UP
                  </span>
                </p>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                    dlqCount === 0 ? ui.pillEmerald : ui.pillRose
                  }`}
                >
                  {dlqCount} DLQ
                </span>
              </div>
              <p className={`mt-1.5 truncate font-mono text-[11px] ${ui.muted}`}>
                Ollama {metrics.ollamaModel} ·{' '}
                {bffOnline ? 'BFF :4000 Live' : 'Chế độ cục bộ'}
              </p>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
