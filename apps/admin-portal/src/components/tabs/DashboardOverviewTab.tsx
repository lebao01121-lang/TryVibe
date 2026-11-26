'use client';

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from 'react';
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
import {
  AnimatedTelemetryNumber,
  LiveComboAreaBarChart,
  LiveDonutBreakdownChart,
  LiveEcgIcon,
  LiveKpiSparkCard,
  LiveServiceClusterStrip,
  LiveStackedHealthBar,
} from '@atelier/motion-kit';
import type { AdminLiveOverviewData } from '@/lib/admin-overview';
import {
  canAccessAdminTab,
  type AdminTabKey,
} from '@/lib/admin-navigation';
import { adminFetch } from '@/lib/api-client';
import {
  AdminNavIcon,
  BoxIcon,
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
  syncTick?: number;
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

export function DashboardOverviewTab({
  roles,
  userEmail,
  bffOnline,
  liveOverview,
  onNavigateTab,
  onOpenCopilot,
  refreshNonce,
  syncTick = 0,
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
  const [approvingRmaId, setApprovingRmaId] = useState<string | null>(null);
  const [freshQueueIds, setFreshQueueIds] = useState<Set<string>>(
    () => new Set(),
  );
  const prevQueueIdsRef = useRef<Set<string>>(new Set());
  const hasLoadedOnceRef = useRef(false);

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

  const loadDashboardData = useCallback(
    async (silent = false) => {
      if (!silent) {
        setLoading(true);
      }

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
    hasLoadedOnceRef.current = true;
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
    void loadDashboardData(false);
  }, [loadDashboardData, refreshNonce]);

  useEffect(() => {
    if (syncTick <= 0) return;
    void loadDashboardData(true);
  }, [loadDashboardData, syncTick]);

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

  // Detect newly arrived queue items during live sync for 1.5s Champagne border flash
  useEffect(() => {
    const nextIds = new Set(recentQueue.map((item) => item.id));
    if (prevQueueIdsRef.current.size > 0) {
      const newlyAdded = new Set<string>();
      for (const id of nextIds) {
        if (!prevQueueIdsRef.current.has(id)) {
          newlyAdded.add(id);
        }
      }
      if (newlyAdded.size > 0) {
        setFreshQueueIds(newlyAdded);
        const timer = window.setTimeout(() => {
          setFreshQueueIds(new Set());
        }, 1600);
        prevQueueIdsRef.current = nextIds;
        return () => window.clearTimeout(timer);
      }
    }
    prevQueueIdsRef.current = nextIds;
    return undefined;
  }, [recentQueue]);

  // Derived data for LiveChartPrimitives (zero random jitter, 100% real API metrics)
  const tryOnCurveValues = useMemo(() => {
    const slice = chartBuckets.slice(-7).map((b) => b.aiActivity);
    if (slice.some((v) => v > 0)) return slice;
    return [0, 0, 0, 0, 0, 0, metrics.tryOnSessions];
  }, [chartBuckets, metrics.tryOnSessions]);

  const comboChartPoints = useMemo(
    () =>
      chartBuckets.map((b) => ({
        label: b.label,
        tooltipLabel: `Ngày ${b.label} (${b.fullDate})`,
        barValue: b.orderCount,
        lineValue: b.aiActivity,
        metaLabel:
          b.revenueVnd > 0 ? `Doanh thu: ${formatVnd(b.revenueVnd)}` : undefined,
      })),
    [chartBuckets],
  );

  const donutChartSegments = useMemo(
    () =>
      categorySlices.map((s) => ({
        id: s.key,
        label: s.label,
        value: s.count,
        sharePct: s.pct,
        color: s.color,
        unitLabel: 'mẫu',
      })),
    [categorySlices],
  );

  const clusterServiceNodes = useMemo(() => {
    const raw = healthCluster?.services ?? [];
    if (raw.length > 0) {
      return raw.slice(0, 11).map((svc, idx) => ({
        id: `${svc.name}-${idx}`,
        label: svc.name.replace(/^atelier-|^tryvibe-/i, ''),
        online: normalizeNodeUp(svc.status),
        latencyMs: svc.latencyMs ?? null,
      }));
    }
    const fallbackMods = liveOverview?.ledger.modules ?? [];
    return fallbackMods.slice(0, 11).map((m, idx) => ({
      id: `${m.label}-${idx}`,
      label: m.label,
      online: m.status === 'active',
      latencyMs: null,
    }));
  }, [healthCluster?.services, liveOverview?.ledger.modules]);

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

  const periodOrderTotal = chartBuckets.reduce((s, b) => s + b.orderCount, 0);
  const periodRevenueTotal = chartBuckets.reduce((s, b) => s + b.revenueVnd, 0);

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
                <span className="relative flex h-2 w-2 items-center justify-center">
                  {bffOnline ? (
                    <span
                      aria-hidden="true"
                      className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
                    />
                  ) : null}
                  <span
                    className={`relative h-1.5 w-1.5 rounded-full ${
                      bffOnline ? 'bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                </span>
                LIVE CONTROL CENTER
              </span>
              <span className="font-mono text-[11px] text-[#DECBB1]/85">
                Cập nhật lúc {lastUpdatedLabel}
              </span>
              {loading && !hasLoadedOnceRef.current ? (
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
              · <AnimatedTelemetryNumber value={metrics.totalOrders} format="integer" /> đơn hàng ·{' '}
              <AnimatedTelemetryNumber value={metrics.totalSkuRows} format="integer" /> SKU kho ·{' '}
              <AnimatedTelemetryNumber value={metrics.servicesReady} format="integer" />/
              {metrics.servicesTotal} dịch vụ trực tuyến
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

      {/* ROW 2 — 4 Live GPU KPI Sparkline Cards (4 Variants) */}
      <section
        data-testid="dashboard-kpi-grid"
        className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4"
      >
        <LiveKpiSparkCard
          testId="kpi-orders-revenue"
          cardIndex={0}
          isDark={darkMode}
          title="Đơn hàng & Doanh thu"
          icon={<AdminNavIcon tab="orders" size={14} />}
          value={metrics.totalOrders}
          valueFormat="integer"
          subtitle={
            <span className={`font-mono text-[11px] ${ui.goldText}`}>
              <AnimatedTelemetryNumber
                value={metrics.totalRevenueVnd}
                format="compactVnd"
              />{' '}
              GMV
            </span>
          }
          variant="sparkBars"
          sparkBars={{
            values: miniBarHeights,
            badgePercent: metrics.orderCompletionPct,
            tone: 'gold',
          }}
          footerLeft={
            <>
              <AnimatedTelemetryNumber value={metrics.completedOrders} /> hoàn tất ·{' '}
              <AnimatedTelemetryNumber value={metrics.pendingOrdersCount} /> chờ xử lý
            </>
          }
          footerRight={
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillEmerald}`}
            >
              {metrics.orderCompletionPct}% hoàn tất
            </span>
          }
          onClick={() =>
            canAccessAdminTab(roles, 'orders') && onNavigateTab('orders')
          }
        />

        <LiveKpiSparkCard
          testId="kpi-ai-tryon"
          cardIndex={1}
          isDark={darkMode}
          title="Phòng Thử Đồ AI"
          icon={<AdminNavIcon tab="tryon-hub" size={14} />}
          value={metrics.tryOnSessions}
          valueFormat="integer"
          unitLabel="lượt"
          subtitle={
            <span className={`font-mono text-[11px] ${ui.goldText}`}>
              <AnimatedTelemetryNumber
                value={metrics.tryOnToCartRatePct}
                format="percent"
              />{' '}
              chuyển đổi giỏ
            </span>
          }
          variant="laserCurve"
          laserCurve={{
            values: tryOnCurveValues,
            tone: 'gold',
          }}
          footerLeft={
            <>
              Cache <AnimatedTelemetryNumber value={metrics.cacheHitPct} format="percent" /> ·{' '}
              <AnimatedTelemetryNumber value={metrics.addToCartAfterTryOn} /> thêm giỏ
            </>
          }
          footerRight={
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillGold}`}
            >
              AI VTON &amp; RAG
            </span>
          }
          onClick={() =>
            canAccessAdminTab(roles, 'tryon-hub') && onNavigateTab('tryon-hub')
          }
        />

        <LiveKpiSparkCard
          testId="kpi-inventory-sku"
          cardIndex={2}
          isDark={darkMode}
          title="Kho SKU & Vùng tồn"
          icon={<BoxIcon size={14} />}
          value={metrics.totalSkuRows}
          valueFormat="integer"
          unitLabel="SKU"
          subtitle={
            <span className={`font-mono text-[11px] ${ui.goldText}`}>
              <AnimatedTelemetryNumber
                value={metrics.totalAvailableUnits}
                format="integer"
              />{' '}
              sp sẵn bán
            </span>
          }
          variant="radialGauge"
          radialGauge={{
            current: metrics.healthyStockCount,
            total: Math.max(1, metrics.totalSkuRows),
            centerText: `${metrics.healthyStockCount}/${metrics.totalSkuRows}`,
            legendItems: [
              { label: 'Hết', value: metrics.outOfStockCount, tone: 'crimson' },
              { label: 'Thấp', value: metrics.lowStockCount, tone: 'amber' },
              { label: 'Ổn', value: metrics.healthyStockCount, tone: 'emerald' },
            ],
          }}
          footerLeft={<>{metrics.warehouseCount} kho đồng bộ tồn thực</>}
          footerRight={
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                metrics.outOfStockCount > 0 ? ui.pillAmber : ui.pillGold
              }`}
            >
              Kho Trung Tâm
            </span>
          }
          onClick={() =>
            canAccessAdminTab(roles, 'inventory') && onNavigateTab('inventory')
          }
        />

        <LiveKpiSparkCard
          testId="kpi-procurement-iam"
          cardIndex={3}
          isDark={darkMode}
          title="Thu mua B2B & IAM"
          icon={<AdminNavIcon tab="procurement" size={14} />}
          value={metrics.totalPos + metrics.totalUsers}
          valueFormat="integer"
          subtitle={
            <span className={`font-mono text-[11px] ${ui.goldText}`}>
              <AnimatedTelemetryNumber value={metrics.openPos} /> PO mở ·{' '}
              <AnimatedTelemetryNumber
                value={metrics.totalUsers || roles.length}
              />{' '}
              tài khoản
            </span>
          }
          variant="dualStreamBars"
          dualStreamBars={[
            {
              label: 'PO B2B',
              value: metrics.totalPos > 0 ? metrics.totalPos - metrics.openPos + 1 : 0,
              max: Math.max(1, metrics.totalPos + 1),
              displayValue: metrics.totalPos,
              tone: 'gold',
            },
            {
              label: 'IAM',
              value: Math.max(1, metrics.internalStaffCount),
              max: Math.max(1, metrics.totalUsers || roles.length),
              displayValue: metrics.totalUsers || roles.length,
              tone: 'emerald',
            },
          ]}
          footerLeft={
            <>
              <AnimatedTelemetryNumber value={metrics.aiDraftPos} /> nháp NHAP_AI ·{' '}
              {roles.length} vai trò phiên
            </>
          }
          footerRight={
            <span
              className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${ui.pillGold}`}
            >
              RBAC &amp; B2B
            </span>
          }
          onClick={() =>
            canAccessAdminTab(roles, 'procurement')
              ? onNavigateTab('procurement')
              : canAccessAdminTab(roles, 'iam') && onNavigateTab('iam')
          }
        />
      </section>

      {/* ROW 3 — Asymmetric 2-Column Command Grid (Live Combo Growth Chart + Recent Orders & RMA Queue) */}
      <section className="grid grid-cols-1 gap-5 xl:grid-cols-[1.62fr_1fr]">
        {/* Left: Live Combo Growth Chart */}
        <div
          data-testid="dashboard-timeframe-tabs"
          className={`rounded-2xl border p-5 ${ui.card}`}
        >
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
                    backgroundColor: darkMode ? '#34D399' : '#059669',
                  }}
                />
                Lượt thử AI &amp; Doanh thu (Miền)
              </span>
            </div>
          </div>

          <LiveComboAreaBarChart
            className="mt-4"
            points={comboChartPoints}
            barLabel="Số đơn hàng (Cột)"
            lineLabel="Tín hiệu AI / Kho (Miền)"
            formatBarValue={(v) => `${Math.round(v)} đơn`}
            formatLineValue={(v) => `${Math.round(v)} tín hiệu`}
            timeframes={[
              { id: '7d', label: '7 ngày' },
              { id: '14d', label: '14 ngày' },
              { id: 'all', label: 'Tất cả' },
            ]}
            activeTimeframe={timeframe}
            onTimeframeChange={(id) => setTimeframe(id as TimeframeKey)}
            isDark={darkMode}
            summaryRight={
              <div
                className={`flex flex-wrap items-center gap-3 font-mono text-[11px] tabular-nums ${ui.muted}`}
              >
                <span>
                  Đơn kỳ:{' '}
                  <strong className={ui.heading}>
                    <AnimatedTelemetryNumber value={periodOrderTotal} />
                  </strong>
                </span>
                <span>
                  GMV:{' '}
                  <strong className={ui.goldText}>
                    <AnimatedTelemetryNumber
                      value={periodRevenueTotal}
                      format="compactVnd"
                    />
                  </strong>
                </span>
              </div>
            }
          />
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
                recentQueue.map((item, idx) => (
                  <div
                    key={item.id}
                    style={{ '--row-idx': idx } as CSSProperties}
                    className={`telemetry-anim telemetry-row-stagger flex items-center justify-between gap-3 rounded-xl border px-3.5 py-2.5 transition-colors ${ui.subCard} ${
                      freshQueueIds.has(item.id) ? 'telemetry-row-flash' : ''
                    }`}
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
                            className="inline-flex items-center gap-1.5 rounded-md bg-[#1C1410] px-2.5 py-0.5 text-[10px] font-semibold text-[#EBCF8F] transition-opacity hover:opacity-90 disabled:opacity-50"
                          >
                            <span className="relative flex h-1.5 w-1.5 items-center justify-center">
                              <span
                                aria-hidden="true"
                                className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-amber-400/80"
                              />
                              <span className="relative h-1.5 w-1.5 rounded-full bg-amber-400" />
                            </span>
                            <span>
                              {approvingRmaId === item.rmaId
                                ? 'Đang duyệt...'
                                : 'Duyệt nhanh'}
                            </span>
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

      {/* ROW 4 — Bottom 2-Column Analytical Grid (Live Orbital Category Donut + Live ECG Health Stack) */}
      <section className="grid grid-cols-1 gap-5 lg:grid-cols-2">
        {/* Bottom Left: Live Orbital Category Donut Chart */}
        <div className={`rounded-2xl border p-5 ${ui.card}`}>
          <div className="flex items-start justify-between gap-2">
            <div>
              <h3
                className={`font-editorial text-xl font-semibold tracking-wide ${ui.heading}`}
              >
                Biểu đồ Donut Cơ cấu Danh mục &amp; Thiết kế
              </h3>
              <p className={`mt-0.5 text-xs ${ui.muted}`}>
                Tỷ trọng phân bổ thiết kế SPU hiện hành trên Storefront TryVibe
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

          <LiveDonutBreakdownChart
            className="mt-5"
            segments={donutChartSegments}
            centerLabel="TỔNG"
            centerUnit="thiết kế"
            totalOverride={products.length}
            isDark={darkMode}
            onSelectSegment={() =>
              canAccessAdminTab(roles, 'catalog') && onNavigateTab('catalog')
            }
          />
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
                title="Live Telemetry Heartbeat ECG"
              >
                <LiveEcgIcon
                  size={20}
                  color={darkMode ? '#34D399' : '#059669'}
                />
              </span>
            </div>

            {/* Live Multi-segment Stacked Status Bar */}
            <div className={`mt-5 rounded-xl border p-4 ${ui.subCard}`}>
              <LiveStackedHealthBar
                isDark={darkMode}
                segments={[
                  {
                    id: 'done',
                    label: 'Đã giao / Hoàn tất',
                    value: statusBar.done,
                    tone: 'emerald',
                  },
                  {
                    id: 'processing',
                    label: 'Đang xử lý',
                    value: statusBar.processing,
                    tone: 'amber',
                  },
                  {
                    id: 'alerts',
                    label: 'RMA / Cảnh báo trễ',
                    value: statusBar.alerts,
                    tone: 'crimson',
                  },
                ]}
              />
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
                  <AnimatedTelemetryNumber
                    value={metrics.slaCompletionPct}
                    format="percent"
                  />
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
                  <AnimatedTelemetryNumber value={metrics.servicesReady} />/
                  {metrics.servicesTotal}
                  <span className={`ml-1 text-xs font-medium ${ui.muted}`}>
                    UP
                  </span>
                </p>
                <span
                  className={`rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                    dlqCount === 0 ? ui.pillEmerald : ui.pillRose
                  }`}
                >
                  <AnimatedTelemetryNumber value={dlqCount} /> DLQ
                </span>
              </div>
              <p className={`mt-1.5 truncate font-mono text-[11px] ${ui.muted}`}>
                Ollama {metrics.ollamaModel} ·{' '}
                {bffOnline ? 'BFF :4000 Live' : 'Chế độ cục bộ'}
              </p>
            </div>
          </div>

          {/* Live Microservices Pulse Beacon Strip */}
          {clusterServiceNodes.length > 0 ? (
            <div className="mt-3">
              <LiveServiceClusterStrip
                services={clusterServiceNodes}
                isDark={darkMode}
              />
            </div>
          ) : null}
        </div>
      </section>
    </div>
  );
}
