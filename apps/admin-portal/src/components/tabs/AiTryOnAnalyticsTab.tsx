'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { ProductSpuDto, StockLevelAdminDto } from '@atelier/contracts';
import {
  AnimatedTelemetryNumber,
  LiveFunnelStageBar,
  LiveStreamProgressBar,
} from '@atelier/motion-kit';
import { adminFetch } from '@/lib/api-client';
import { emitPortalToast } from '../PortalToastBanner';

export interface AiTryOnAnalyticsTabProps {
  onOpenCopilotWithPrompt?: (prompt: string) => void;
  onNavigateLookbook?: () => void;
  darkMode?: boolean;
}

interface ProviderBreakdown {
  FAL_CATVTON?: number;
  HF_GRADIO_VTON?: number;
  SMART_POSE_WARP?: number;
  PHOTOMETRIC_INPAINT?: number;
  MOCK?: number;
  CACHE_HIT?: number;
  [key: string]: number | undefined;
}

interface AiFunnelHealthPayload {
  generatedAt?: string;
  cacheHitSavingsPct?: number;
  estimatedAiCostPerOrderUsd?: number;
  tryonProviderBreakdown?: ProviderBreakdown;
  funnel?: {
    rackOrOutfitInteractions?: number;
    tryOnModalOpens?: number;
    tryOnCompleted?: number;
    addToCartAfterTryOn?: number;
    paidOrders?: number;
    providerBreakdown?: ProviderBreakdown;
  };
  tryon?: {
    totalSessions?: number;
    completedSessions?: number;
    failedSessions?: number;
    falCount?: number;
    hfGradioCount?: number;
    smartPoseWarpCount?: number;
    photometricInpaintCount?: number;
    mockCount?: number;
    cacheHitCount?: number;
    providerBreakdown?: ProviderBreakdown;
    cacheHitRatePct?: number;
    cacheHitSavingsPct?: number;
    estimatedSavingsUsd?: number;
    estimatedApiCostUsd?: number;
    openModalSignals?: number;
    addToCartAfterTryonCount?: number;
    addToCartAfterTryOnSignals?: number;
    demandEventsCount?: number;
    activeUnpurgedImagesCount?: number;
  };
  orders?: {
    totalOrders?: number;
    confirmedPaidOrders?: number;
    paidOrders?: number;
    deliveredOrders?: number;
  };
  payments?: {
    succeededCharges?: number;
  };
  sources?: {
    aiTryon?: string;
    ollama?: string;
  };
}

interface DemandSummaryRawItem {
  productId: string;
  skuId?: string | null;
  skuCode?: string | null;
  size?: string | null;
  tryOnSessions?: number;
  addToCartCount?: number;
  purchaseCount?: number;
  tryOnToCartRatePct?: number;
  tryOnToCartRate?: number;
}

interface DemandSummaryPayload {
  periodDays?: number;
  totalGroups?: number;
  items?: DemandSummaryRawItem[];
  signalCounts?: {
    MO_PHONG_THU?: number;
    THU_THANH_CONG?: number;
    THEM_GIO_SAU_THU?: number;
    MUA_SAU_THU?: number;
  };
  tryOnToCartRatePct?: number;
}

interface EnrichedDemandRow {
  rowKey: string;
  productId: string;
  productName: string;
  colorName: string;
  colorHex: string;
  skuId: string | null;
  skuCode: string;
  size: string;
  tryOnSessions: number;
  addToCartCount: number;
  purchaseCount: number;
  addToCartRatePct: number;
  availableQty: number | null;
  lowStockRisk: 'OUT' | 'LOW' | 'SAFE' | 'UNKNOWN';
}

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

function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('vi-VN', {
      hour: '2-digit',
      minute: '2-digit',
      day: '2-digit',
      month: '2-digit',
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 16);
  }
}

export function AiTryOnAnalyticsTab({
  onOpenCopilotWithPrompt,
  onNavigateLookbook,
  darkMode = false,
}: AiTryOnAnalyticsTabProps) {
  const [periodDays, setPeriodDays] = useState<number>(30);
  const [funnelData, setFunnelData] = useState<AiFunnelHealthPayload | null>(null);
  const [healthData, setHealthData] = useState<AiFunnelHealthPayload | null>(null);
  const [demandData, setDemandData] = useState<DemandSummaryPayload | null>(null);
  const [products, setProducts] = useState<ProductSpuDto[]>([]);
  const [stockLevels, setStockLevels] = useState<StockLevelAdminDto[]>([]);

  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [onlyLowStock, setOnlyLowStock] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');

  const loadAnalytics = useCallback(
    async (notify = false) => {
      setLoading(true);
      setErrorBanner(null);

      const [funnelRes, demandRes, healthRes, prodRes, stockRes] = await Promise.all([
        adminFetch<AiFunnelHealthPayload>('/api/v1/admin/ops/ai-funnel', {
          timeoutMs: 12_000,
        }),
        adminFetch<DemandSummaryPayload>(
          `/api/v1/admin/tryon/demand-summary?periodDays=${periodDays}&limit=40`,
          { timeoutMs: 12_000 },
        ),
        adminFetch<AiFunnelHealthPayload>('/api/v1/admin/ops/ai-health', {
          timeoutMs: 12_000,
        }),
        adminFetch<unknown>('/api/v1/admin/products?pageSize=50', {
          timeoutMs: 10_000,
        }),
        adminFetch<unknown>('/api/v1/admin/inventory/stock-levels', {
          timeoutMs: 10_000,
        }),
      ]);

      if (funnelRes.ok && funnelRes.data) setFunnelData(funnelRes.data);
      if (healthRes.ok && healthRes.data) setHealthData(healthRes.data);
      if (demandRes.ok && demandRes.data) setDemandData(demandRes.data);
      if (prodRes.ok) {
        setProducts(
          extractList<ProductSpuDto>(prodRes.data, ['items', 'products', 'list']),
        );
      }
      if (stockRes.ok) {
        setStockLevels(
          extractList<StockLevelAdminDto>(stockRes.data, ['items', 'list', 'rows']),
        );
      }

      if (!funnelRes.ok && !healthRes.ok && !demandRes.ok) {
        setErrorBanner(
          funnelRes.error?.message ||
            'Chưa thể kết nối dữ liệu Phòng Thử Đồ AI từ BFF (:4000) / ai-tryon (:4009).',
        );
      }

      setLoading(false);
      if (notify) {
        emitPortalToast({
          kind: 'success',
          title: 'AI TRY-ON HUB',
          message: `Đã cập nhật phễu chuyển đổi & tín hiệu nhu cầu (${periodDays} ngày).`,
        });
      }
    },
    [periodDays],
  );

  useEffect(() => {
    void loadAnalytics(false);
  }, [loadAnalytics]);

  // Merge ai-funnel + ai-health snapshot safely
  const snapshot = useMemo<AiFunnelHealthPayload>(() => {
    return {
      ...(healthData ?? {}),
      ...(funnelData ?? {}),
      funnel: funnelData?.funnel ?? healthData?.funnel,
      tryon: funnelData?.tryon ?? healthData?.tryon,
      orders: funnelData?.orders ?? healthData?.orders,
      payments: funnelData?.payments ?? healthData?.payments,
      sources: funnelData?.sources ?? healthData?.sources,
    };
  }, [funnelData, healthData]);

  // 4-Stage Conversion Funnel
  const funnelStages = useMemo(() => {
    const sc = demandData?.signalCounts;
    const modalOpens = Math.max(
      snapshot.funnel?.tryOnModalOpens ??
        snapshot.tryon?.openModalSignals ??
        snapshot.tryon?.totalSessions ??
        0,
      sc?.MO_PHONG_THU ?? 0,
    );
    const completed = Math.max(
      snapshot.funnel?.tryOnCompleted ?? snapshot.tryon?.completedSessions ?? 0,
      sc?.THU_THANH_CONG ?? 0,
    );
    const addToCart = Math.max(
      snapshot.funnel?.addToCartAfterTryOn ??
        snapshot.tryon?.addToCartAfterTryOnSignals ??
        snapshot.tryon?.addToCartAfterTryonCount ??
        0,
      sc?.THEM_GIO_SAU_THU ?? 0,
    );
    const paidOrders =
      snapshot.funnel?.paidOrders ??
      snapshot.orders?.paidOrders ??
      snapshot.orders?.confirmedPaidOrders ??
      snapshot.payments?.succeededCharges ??
      sc?.MUA_SAU_THU ??
      0;

    const baseMax = Math.max(modalOpens, completed, addToCart, paidOrders, 1);

    const safeRate = (num: number, den: number): number =>
      den > 0 ? Math.min(100, Number(((num / den) * 100).toFixed(1))) : 0;

    return {
      stages: [
        {
          step: '01',
          title: 'Mở Phòng Thử AI',
          code: 'OPEN_MODAL',
          value: modalOpens,
          barPct: Math.round((modalOpens / baseMax) * 100),
          convFromPrevPct: null as number | null,
          tone: 'espresso' as const,
        },
        {
          step: '02',
          title: 'Ướm Thành Công',
          code: 'TRYON_COMPLETED',
          value: completed,
          barPct: Math.round((completed / baseMax) * 100),
          convFromPrevPct: safeRate(completed, modalOpens),
          tone: 'gold' as const,
        },
        {
          step: '03',
          title: 'Thêm Giỏ Sau Thử',
          code: 'ADD_TO_CART_AFTER_TRYON',
          value: addToCart,
          barPct: Math.round((addToCart / baseMax) * 100),
          convFromPrevPct: safeRate(addToCart, completed),
          tone: 'blue' as const,
        },
        {
          step: '04',
          title: 'Đơn Thanh Toán',
          code: 'PAID_ORDERS',
          value: paidOrders,
          barPct: Math.round((paidOrders / baseMax) * 100),
          convFromPrevPct: safeRate(paidOrders, addToCart || completed),
          tone: 'emerald' as const,
        },
      ],
      overallTryOnToCartPct: safeRate(addToCart, completed || modalOpens),
      overallModalToPaidPct: safeRate(paidOrders, modalOpens),
    };
  }, [demandData?.signalCounts, snapshot]);

  // Privacy 15-Min Auto-Purge & 4-Tier VTON Provider metrics
  const vtonTelemetry = useMemo(() => {
    const t = snapshot.tryon;
    const pb =
      t?.providerBreakdown ??
      snapshot.tryonProviderBreakdown ??
      snapshot.funnel?.providerBreakdown ??
      {};

    const falCount = Number(pb.FAL_CATVTON ?? t?.falCount ?? 0);
    const fashnZeroGpuCount = Number(pb.HF_GRADIO_VTON ?? t?.hfGradioCount ?? 0);
    const smartPoseCount = Number(pb.SMART_POSE_WARP ?? t?.smartPoseWarpCount ?? 0);
    const photometricCount =
      Number(pb.PHOTOMETRIC_INPAINT ?? t?.photometricInpaintCount ?? 0) +
      Number(pb.MOCK ?? t?.mockCount ?? 0);
    const cacheHitCount = Number(pb.CACHE_HIT ?? t?.cacheHitCount ?? 0);

    const totalRuns =
      falCount + fashnZeroGpuCount + smartPoseCount + photometricCount + cacheHitCount;

    const cacheHitRatePct = Number(
      (
        t?.cacheHitRatePct ??
        t?.cacheHitSavingsPct ??
        snapshot.cacheHitSavingsPct ??
        (totalRuns > 0 ? (cacheHitCount / totalRuns) * 100 : 0)
      ).toFixed(1),
    );
    const estimatedSavingsUsd = Number(
      (t?.estimatedSavingsUsd ?? cacheHitCount * 0.03).toFixed(2),
    );
    const estimatedApiCostUsd = Number((t?.estimatedApiCostUsd ?? 0).toFixed(2));
    const activeUnpurgedImagesCount = Number(t?.activeUnpurgedImagesCount ?? 0);
    const privacyCompliant = activeUnpurgedImagesCount === 0;

    const tiers = [
      {
        tier: 'Tier 1',
        name: 'Fal / Fashn Cloud GPU',
        providerCode: 'FAL_CATVTON',
        count: falCount,
        pct: totalRuns > 0 ? Math.round((falCount / totalRuns) * 100) : 0,
        status: falCount > 0 ? 'Đang xử lý' : 'Dự phòng sẵn sàng',
        costBadge: 'GPU Cloud',
        barCls: 'bg-[#B08A4A]',
      },
      {
        tier: 'Tier 2',
        name: 'ZeroGPU / HF Gradio Space',
        providerCode: 'HF_GRADIO_VTON',
        count: fashnZeroGpuCount,
        pct: totalRuns > 0 ? Math.round((fashnZeroGpuCount / totalRuns) * 100) : 0,
        status: fashnZeroGpuCount > 0 ? 'Đang xử lý' : 'Dự phòng sẵn sàng',
        costBadge: 'ZeroGPU Free',
        barCls: 'bg-[#D9822B]',
      },
      {
        tier: 'Tier 3',
        name: 'Smart Pose Warp (OpenCV)',
        providerCode: 'SMART_POSE_WARP',
        count: smartPoseCount,
        pct: totalRuns > 0 ? Math.round((smartPoseCount / totalRuns) * 100) : 0,
        status: smartPoseCount > 0 ? 'Hoạt động tốt' : 'Sẵn sàng Local',
        costBadge: '0₫ Local CV',
        barCls: 'bg-[#2E5A8B]',
      },
      {
        tier: 'Tier 4',
        name: 'Photometric Inpaint (Studio)',
        providerCode: 'PHOTOMETRIC_INPAINT',
        count: photometricCount,
        pct: totalRuns > 0 ? Math.round((photometricCount / totalRuns) * 100) : 0,
        status: photometricCount > 0 ? 'Hoạt động tốt' : 'Fallback 100%',
        costBadge: '0₫ Offline',
        barCls: 'bg-[#5C736B]',
      },
    ];

    return {
      tiers,
      cacheHitCount,
      cacheHitRatePct,
      estimatedSavingsUsd,
      estimatedApiCostUsd,
      activeUnpurgedImagesCount,
      privacyCompliant,
      totalRuns,
      tryonServiceUp: snapshot.sources?.aiTryon !== 'DEGRADED',
    };
  }, [snapshot]);

  // Enrich Top Tried Garments & Low-Stock Demand Signals with Catalog + Live Stock
  const enrichedDemandRows = useMemo<EnrichedDemandRow[]>(() => {
    const productById = new Map<string, ProductSpuDto>();
    const skuLookup = new Map<
      string,
      {
        productId: string;
        productName: string;
        colorName: string;
        colorHex: string;
        sizeCode: string;
        skuCode: string;
      }
    >();

    for (const prod of products) {
      productById.set(prod.id, prod);
      for (const variant of prod.variants ?? []) {
        for (const sku of variant.skus ?? []) {
          const info = {
            productId: prod.id,
            productName: prod.name,
            colorName: variant.colorName,
            colorHex: variant.colorHex,
            sizeCode: sku.sizeCode,
            skuCode: sku.skuCode,
          };
          skuLookup.set(sku.id, info);
          skuLookup.set(sku.skuCode.toUpperCase(), info);
        }
      }
    }

    // Aggregate stock availableQty per skuId and per productId across warehouses
    const stockBySkuId = new Map<string, { availableQty: number; lowWarning: boolean }>();
    const stockBySkuCode = new Map<string, { availableQty: number; lowWarning: boolean }>();
    const stockByProductId = new Map<string, { availableQty: number; lowWarning: boolean }>();

    for (const st of stockLevels) {
      const prevSku = stockBySkuId.get(st.skuId) ?? { availableQty: 0, lowWarning: false };
      prevSku.availableQty += st.availableQty;
      prevSku.lowWarning = prevSku.lowWarning || st.lowStockWarning;
      stockBySkuId.set(st.skuId, prevSku);

      if (st.skuCode) {
        const key = st.skuCode.toUpperCase();
        const prevCode = stockBySkuCode.get(key) ?? { availableQty: 0, lowWarning: false };
        prevCode.availableQty += st.availableQty;
        prevCode.lowWarning = prevCode.lowWarning || st.lowStockWarning;
        stockBySkuCode.set(key, prevCode);
      }

      const prevProd = stockByProductId.get(st.productId) ?? {
        availableQty: 0,
        lowWarning: false,
      };
      prevProd.availableQty += st.availableQty;
      prevProd.lowWarning = prevProd.lowWarning || st.lowStockWarning;
      stockByProductId.set(st.productId, prevProd);
    }

    const rawItems = Array.isArray(demandData?.items) ? demandData.items : [];
    const mapped: EnrichedDemandRow[] = rawItems.map((item, idx) => {
      const matchedSku =
        (item.skuId ? skuLookup.get(item.skuId) : undefined) ??
        (item.skuCode ? skuLookup.get(item.skuCode.toUpperCase()) : undefined);
      const matchedProd =
        productById.get(item.productId) ??
        (matchedSku ? productById.get(matchedSku.productId) : undefined);

      const firstVariant = matchedProd?.variants?.[0];
      const stockInfo =
        (item.skuId ? stockBySkuId.get(item.skuId) : undefined) ??
        (item.skuCode ? stockBySkuCode.get(item.skuCode.toUpperCase()) : undefined) ??
        stockByProductId.get(item.productId);

      const availableQty = stockInfo ? stockInfo.availableQty : null;
      const sessions = Number(item.tryOnSessions ?? 0);
      const atc = Number(item.addToCartCount ?? 0);
      const ratePct =
        typeof item.tryOnToCartRatePct === 'number'
          ? Number(item.tryOnToCartRatePct.toFixed(1))
          : sessions > 0
            ? Number(((atc / sessions) * 100).toFixed(1))
            : 0;

      let lowStockRisk: EnrichedDemandRow['lowStockRisk'] = 'UNKNOWN';
      if (availableQty !== null) {
        if (availableQty <= 0) lowStockRisk = 'OUT';
        else if (availableQty <= 5 || stockInfo?.lowWarning) lowStockRisk = 'LOW';
        else lowStockRisk = 'SAFE';
      }

      return {
        rowKey: `${item.productId}-${item.skuId ?? item.skuCode ?? idx}`,
        productId: item.productId,
        productName:
          matchedSku?.productName ??
          matchedProd?.name ??
          `Thiết kế ${item.productId.slice(0, 10)}`,
        colorName: matchedSku?.colorName ?? firstVariant?.colorName ?? 'Màu Atelier',
        colorHex: matchedSku?.colorHex ?? firstVariant?.colorHex ?? '#B08A4A',
        skuId: item.skuId ?? null,
        skuCode: matchedSku?.skuCode ?? item.skuCode ?? item.productId.slice(0, 12),
        size: item.size ?? matchedSku?.sizeCode ?? 'M',
        tryOnSessions: sessions,
        addToCartCount: atc,
        purchaseCount: Number(item.purchaseCount ?? 0),
        addToCartRatePct: ratePct,
        availableQty,
        lowStockRisk,
      };
    });

    // If demand-summary is empty on a fresh DB, still list Try-On enabled SKUs with live stock risk
    if (mapped.length === 0 && products.length > 0) {
      for (const prod of products.filter((p) => p.isTryonEnabled).slice(0, 10)) {
        const variant = prod.variants?.[0];
        const sku = variant?.skus?.[0];
        const stockInfo =
          (sku ? stockBySkuId.get(sku.id) : undefined) ??
          stockByProductId.get(prod.id);
        const availableQty = stockInfo ? stockInfo.availableQty : null;
        let lowStockRisk: EnrichedDemandRow['lowStockRisk'] = 'UNKNOWN';
        if (availableQty !== null) {
          if (availableQty <= 0) lowStockRisk = 'OUT';
          else if (availableQty <= 5 || stockInfo?.lowWarning) lowStockRisk = 'LOW';
          else lowStockRisk = 'SAFE';
        }
        mapped.push({
          rowKey: `catalog-${prod.id}-${sku?.id ?? 'default'}`,
          productId: prod.id,
          productName: prod.name,
          colorName: variant?.colorName ?? 'Màu nguyên bản',
          colorHex: variant?.colorHex ?? '#B08A4A',
          skuId: sku?.id ?? null,
          skuCode: sku?.skuCode ?? prod.slug.toUpperCase().slice(0, 14),
          size: sku?.sizeCode ?? 'M',
          tryOnSessions: 0,
          addToCartCount: 0,
          purchaseCount: 0,
          addToCartRatePct: 0,
          availableQty,
          lowStockRisk,
        });
      }
    }

    return mapped;
  }, [demandData?.items, products, stockLevels]);

  const filteredDemandRows = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return enrichedDemandRows.filter((row) => {
      if (onlyLowStock && row.lowStockRisk !== 'LOW' && row.lowStockRisk !== 'OUT') {
        return false;
      }
      if (q) {
        const hay = `${row.productName} ${row.colorName} ${row.skuCode} ${row.size}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [enrichedDemandRows, onlyLowStock, searchQuery]);

  const maxTryOnCount = useMemo(
    () => Math.max(...enrichedDemandRows.map((r) => r.tryOnSessions), 1),
    [enrichedDemandRows],
  );

  const handleDraftPoWithCopilot = (row: EnrichedDemandRow) => {
    const qtyHint = row.availableQty !== null && row.availableQty <= 2 ? 25 : 15;
    const prompt = `Lập nháp PO NHAP_AI bổ sung khoảng ${qtyHint} chiếc cho sản phẩm "${row.productName}" (SKU ${row.skuCode}, màu ${row.colorName}, size ${row.size}) dựa trên tín hiệu Phòng Thử Đồ AI (${row.tryOnSessions} lượt ướm, tỷ lệ thêm giỏ ${row.addToCartRatePct}%, tồn kho khả dụng hiện tại: ${row.availableQty ?? 'chưa rõ'}).`;
    if (onOpenCopilotWithPrompt) {
      onOpenCopilotWithPrompt(prompt);
    }
    emitPortalToast({
      kind: 'info',
      title: 'TRỢ LÝ AI · NHAP_AI PO',
      message: `Đã gửi lệnh lập nháp PO NHAP_AI cho ${row.skuCode} (${row.productName}) sang MCP Copilot.`,
    });
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

  const getStockRiskBadge = (risk: EnrichedDemandRow['lowStockRisk']) => {
    if (risk === 'OUT') {
      return {
        label: 'Hết hàng · Khẩn',
        cls: darkMode
          ? 'border-rose-500/50 bg-rose-950/60 text-rose-300'
          : 'border-[#8B2E2E]/45 bg-[#FFF5F4] text-[#8B2E2E]',
      };
    }
    if (risk === 'LOW') {
      return {
        label: 'Sắp cạn size',
        cls: darkMode
          ? 'border-amber-500/45 bg-amber-950/55 text-amber-300'
          : 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]',
      };
    }
    if (risk === 'SAFE') {
      return {
        label: 'An toàn',
        cls: darkMode
          ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
          : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]',
      };
    }
    return {
      label: 'Đang đồng bộ',
      cls: darkMode
        ? 'border-[#B08A4A]/30 bg-[#231912] text-[#B4A391]'
        : 'border-[#B08A4A]/30 bg-[#FBF7EF] text-[#7A6A5B]',
    };
  };

  return (
    <div data-testid="ai-tryon-analytics-tab" className="space-y-6">
      {/* Header Banner */}
      <section className="rounded-3xl border border-[#B08A4A]/45 bg-gradient-to-r from-[#19120D] via-[#241A13] to-[#1D1510] p-6 text-[#FBF7EF] shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1.5 rounded-full border border-[#EBCF8F]/45 bg-[#2A1E17] px-3 py-0.5 font-mono text-[10px] uppercase tracking-[0.14em] text-[#EBCF8F]">
                <span className="relative flex h-2 w-2 items-center justify-center">
                  {vtonTelemetry.tryonServiceUp ? (
                    <span
                      aria-hidden="true"
                      className="telemetry-anim telemetry-beacon-ring absolute inset-0 rounded-full bg-emerald-400/75"
                    />
                  ) : null}
                  <span
                    className={`relative h-1.5 w-1.5 rounded-full ${
                      vtonTelemetry.tryonServiceUp ? 'bg-emerald-400' : 'bg-amber-400'
                    }`}
                  />
                </span>
                AI TRY-ON HUB · VTON 4-TIER &amp; DEMAND SIGNALS
              </span>
              <span className="font-mono text-[11px] text-[#EBCF8F]/75">
                Cập nhật: {formatDateTime(snapshot.generatedAt)}
              </span>
            </div>
            <h2 className="font-editorial mt-2 text-3xl font-light text-[#FBF7EF]">
              Phòng Thử Đồ AI &amp; Tín hiệu Nhu cầu (AI Hub)
            </h2>
            <p className="mt-1 text-xs leading-relaxed text-[#DFD2C2]/80">
              Theo dõi chuyển đổi 4 chặng từ mở Phòng thử AI đến đơn hàng thanh toán,
              phát hiện mẫu được ướm nhiều sắp cạn size để lập nháp{' '}
              <code className="text-[#EBCF8F]">NHAP_AI</code> tức thì và giám sát chuẩn
              xóa ảnh riêng tư 15 phút.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {([7, 14, 30, 90] as const).map((days) => (
              <button
                key={days}
                type="button"
                onClick={() => setPeriodDays(days)}
                className={`rounded-full px-3 py-1.5 font-mono text-[11px] transition-colors ${
                  periodDays === days
                    ? 'bg-[#EBCF8F] font-semibold text-[#1C1410]'
                    : 'border border-[#B08A4A]/40 bg-[#251B14] text-[#EBCF8F]/85 hover:border-[#EBCF8F]'
                }`}
              >
                {days} ngày
              </button>
            ))}

            {onNavigateLookbook ? (
              <button
                type="button"
                onClick={onNavigateLookbook}
                className="rounded-full border border-[#EBCF8F]/50 bg-[#2B1F16] px-4 py-1.5 text-xs font-medium text-[#EBCF8F] hover:bg-[#3A291D]"
              >
                ✦ AI Lookbook Studio
              </button>
            ) : null}

            <button
              type="button"
              disabled={loading}
              onClick={() => void loadAnalytics(true)}
              className="rounded-full bg-[#EBCF8F] px-4 py-1.5 text-xs font-semibold uppercase tracking-[0.12em] text-[#1C1410] hover:bg-[#F5DDA7] disabled:opacity-50"
            >
              {loading ? 'Đang tải...' : 'Làm mới'}
            </button>
          </div>
        </div>

        {errorBanner ? (
          <div
            role="alert"
            className="mt-4 rounded-2xl border border-rose-400/45 bg-rose-950/50 px-4 py-3 text-xs text-rose-200"
          >
            {errorBanner}
          </div>
        ) : null}
      </section>

      {/* Section 1: 4-Stage Conversion Funnel Visual */}
      <section className={`rounded-3xl border p-6 ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              4-Stage AI Try-On Conversion Funnel
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Phễu Chuyển đổi Phòng Thử Đồ AI → Doanh thu thực
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span
              className={`rounded-full border px-3 py-1 font-mono text-[11px] font-semibold ${
                darkMode
                  ? 'border-[#EBCF8F]/40 bg-[#2A1E15] text-[#EBCF8F]'
                  : 'border-[#B08A4A]/45 bg-[#F4EBDA] text-[#7A5922]'
              }`}
            >
              Ướm → Giỏ hàng: {funnelStages.overallTryOnToCartPct}%
            </span>
            <span
              className={`rounded-full border px-3 py-1 font-mono text-[11px] font-semibold ${
                darkMode
                  ? 'border-emerald-500/40 bg-emerald-950/55 text-emerald-300'
                  : 'border-[#2E6B47]/35 bg-[#EBF9F1] text-[#1E4B32]'
              }`}
            >
              Mở phòng → Đơn TT: {funnelStages.overallModalToPaidPct}%
            </span>
          </div>
        </div>

        <div className="mt-5 grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          {funnelStages.stages.map((stage, idx) => (
            <div
              key={stage.code}
              className={`relative flex flex-col justify-between rounded-2xl border p-4 ${subCardCls}`}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <span className={`font-mono text-[10px] font-semibold ${goldTextCls}`}>
                    CHẶNG {stage.step}
                  </span>
                  {stage.convFromPrevPct !== null ? (
                    <span
                      className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 font-mono text-[10px] font-semibold ${
                        darkMode
                          ? 'border-[#EBCF8F]/35 bg-[#1A130E] text-[#EBCF8F]'
                          : 'border-[#B08A4A]/40 bg-white text-[#8A672C]'
                      }`}
                    >
                      → {stage.convFromPrevPct}%
                    </span>
                  ) : (
                    <span className={`font-mono text-[10px] ${mutedCls}`}>
                      Đầu phễu 100%
                    </span>
                  )}
                </div>

                <h4 className="mt-2 text-sm font-semibold">{stage.title}</h4>
                <p className="mt-1 font-mono text-3xl font-bold tabular-nums">
                  <AnimatedTelemetryNumber value={stage.value} format="integer" />
                </p>
                <p className={`mt-0.5 font-mono text-[10px] ${mutedCls}`}>
                  {stage.code}
                </p>
              </div>

              <div className="mt-4">
                <LiveStreamProgressBar
                  percent={Math.max(stage.value > 0 ? 6 : 0, stage.barPct)}
                  tone={
                    stage.tone === 'emerald'
                      ? 'emerald'
                      : stage.tone === 'gold'
                        ? 'gold'
                        : stage.tone === 'blue'
                          ? 'amber'
                          : 'espresso'
                  }
                  height="sm"
                  isDark={darkMode}
                  ariaLabel={`${stage.title}: ${stage.barPct}%`}
                />
                <div className="mt-1.5 flex items-center justify-between font-mono text-[10px]">
                  <span className={mutedCls}>Tỷ trọng so với đỉnh</span>
                  <span className="font-semibold">
                    <AnimatedTelemetryNumber value={stage.barPct} format="percent" />
                  </span>
                </div>
              </div>

              {idx < funnelStages.stages.length - 1 ? (
                <span
                  aria-hidden="true"
                  className={`pointer-events-none absolute -right-3 top-1/2 z-10 hidden h-6 w-6 -translate-y-1/2 items-center justify-center rounded-full border font-mono text-xs xl:flex ${
                    darkMode
                      ? 'border-[#B08A4A]/45 bg-[#1A130E] text-[#EBCF8F]'
                      : 'border-[#B08A4A]/45 bg-[#FFFDF9] text-[#8A672C]'
                  }`}
                >
                  →
                </span>
              ) : null}
            </div>
          ))}
        </div>
      </section>

      {/* Section 2: Privacy 15-Min Auto-Purge & 4-Tier VTON Provider Card */}
      <div className="grid grid-cols-1 gap-6 xl:grid-cols-2">
        {/* Privacy 15-Min Auto-Purge Card */}
        <section className={`rounded-3xl border p-6 ${cardCls}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                Privacy-by-Design · 15-Minute Auto-Purge SLA
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Bảo mật Ảnh Khách hàng &amp; Tự hủy 15 phút
              </h3>
            </div>
            <span
              className={`rounded-full border px-3 py-1 font-mono text-[11px] font-semibold ${
                vtonTelemetry.privacyCompliant
                  ? darkMode
                    ? 'border-emerald-500/45 bg-emerald-950/55 text-emerald-300'
                    : 'border-[#2E6B47]/40 bg-[#EBF9F1] text-[#1E4B32]'
                  : darkMode
                    ? 'border-amber-500/45 bg-amber-950/50 text-amber-300'
                    : 'border-[#D9822B]/45 bg-[#FFF6E5] text-[#9A5B13]'
              }`}
            >
              {vtonTelemetry.privacyCompliant
                ? '✓ 100% Tuân thủ 15 phút'
                : `${vtonTelemetry.activeUnpurgedImagesCount} ảnh trong TTL`}
            </span>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-3.5 sm:grid-cols-2">
            <div className={`rounded-2xl border p-4 ${subCardCls}`}>
              <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${mutedCls}`}>
                Ảnh tạm chưa xóa (Unpurged)
              </p>
              <p
                className={`mt-1 font-mono text-4xl font-bold tabular-nums ${
                  vtonTelemetry.privacyCompliant
                    ? darkMode
                      ? 'text-emerald-300'
                      : 'text-[#1E4B32]'
                    : darkMode
                      ? 'text-amber-300'
                      : 'text-[#9A5B13]'
                }`}
              >
                {vtonTelemetry.activeUnpurgedImagesCount}
              </p>
              <p className={`mt-1 text-[11px] ${secondaryCls}`}>
                {vtonTelemetry.privacyCompliant
                  ? '0 ảnh tồn đọng — MinIO ephemeral & DB sạch 100%'
                  : 'Đang chờ tác vụ auto-purge hết hạn 15 phút'}
              </p>
            </div>

            <div className={`rounded-2xl border p-4 ${subCardCls}`}>
              <p className={`text-[10px] font-semibold uppercase tracking-[0.14em] ${mutedCls}`}>
                Redis SHA-256 Cache &amp; Tiết kiệm API
              </p>
              <p className={`mt-1 font-mono text-3xl font-bold tabular-nums ${goldTextCls}`}>
                {vtonTelemetry.cacheHitRatePct}%
              </p>
              <p className={`mt-1 font-mono text-[11px] ${secondaryCls}`}>
                Tiết kiệm:{' '}
                <strong className={darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'}>
                  ${vtonTelemetry.estimatedSavingsUsd.toFixed(2)} USD
                </strong>{' '}
                ({vtonTelemetry.cacheHitCount} cache hit)
              </p>
              <p className={`mt-0.5 font-mono text-[10px] ${mutedCls}`}>
                Chi phí Cloud GPU ước tính: ${vtonTelemetry.estimatedApiCostUsd.toFixed(2)} USD
              </p>
            </div>
          </div>

          <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
            {[
              'Khóa consent tường minh trước upload',
              'Xóa tự động MinIO + DB sau 900 giây',
              'Định danh Redis bằng SHA-256 ẩn danh',
              'Không lưu ảnh chân dung gốc vĩnh viễn',
            ].map((rule) => (
              <div
                key={rule}
                className={`flex items-center gap-2 rounded-xl border px-3 py-2 text-[11px] ${subCardCls}`}
              >
                <span className={darkMode ? 'text-emerald-300' : 'text-[#1E4B32]'}>●</span>
                <span className={secondaryCls}>{rule}</span>
              </div>
            ))}
          </div>
        </section>

        {/* 4-Tier VTON Provider Card */}
        <section className={`rounded-3xl border p-6 ${cardCls}`}>
          <div className="flex flex-wrap items-start justify-between gap-3 border-b border-[#B08A4A]/20 pb-4">
            <div>
              <p className={`ledger-eyebrow ${goldTextCls}`}>
                4-Tier VTON Synthesis Waterfall · Zero Downtime Fallback
              </p>
              <h3 className="font-editorial mt-0.5 text-2xl">
                Phân tầng Động cơ Thử Đồ (Fal / Fashn / ZeroGPU / Inpaint)
              </h3>
            </div>
            <span className={`font-mono text-[11px] ${mutedCls}`}>
              Tổng lượt dựng: <strong>{vtonTelemetry.totalRuns}</strong>
            </span>
          </div>

          <div className="mt-4 space-y-3">
            <LiveFunnelStageBar
              isDark={darkMode}
              unitLabel="lượt dựng"
              stages={vtonTelemetry.tiers.map((t, idx) => ({
                id: t.providerCode,
                stepNumber: idx + 1,
                label: `${t.tier} · ${t.name} (${t.costBadge})`,
                count: t.count,
                ratePct: t.pct,
                subLabel: t.status,
                tone:
                  idx === 0
                    ? 'gold'
                    : idx === 1
                      ? 'amber'
                      : idx === 2
                        ? 'emerald'
                        : 'slate',
              }))}
            />
          </div>
        </section>
      </div>

      {/* Section 3: Top Tried Garments & Low-Stock Demand Signals Table */}
      <section className={`overflow-hidden rounded-3xl border ${cardCls}`}>
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#B08A4A]/20 px-6 py-4">
          <div>
            <p className={`ledger-eyebrow ${goldTextCls}`}>
              Try-On Demand Signals × Multi-Warehouse Available Stock
            </p>
            <h3 className="font-editorial mt-0.5 text-2xl">
              Top Thiết kế Được Ướm Nhiều &amp; Cảnh báo Sắp cạn Size ({filteredDemandRows.length})
            </h3>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <input
              type="search"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Tìm sản phẩm, SKU, màu, size..."
              className={`w-60 rounded-full border px-4 py-1.5 text-xs outline-none ${inputCls}`}
            />
            <button
              type="button"
              onClick={() => setOnlyLowStock((prev) => !prev)}
              className={`rounded-full px-3.5 py-1.5 text-[11px] font-medium transition-colors ${
                onlyLowStock
                  ? darkMode
                    ? 'bg-amber-400 text-[#1C1410] font-semibold'
                    : 'bg-[#8B2E2E] text-white'
                  : darkMode
                    ? 'border border-[#B08A4A]/35 bg-[#231912] text-[#EBCF8F]'
                    : 'border border-[#B08A4A]/35 bg-[#FBF7EF] text-[#5C4B41]'
              }`}
            >
              {onlyLowStock ? '✓ Đang lọc Sắp cạn size' : 'Chỉ xem Sắp cạn size'}
            </button>
          </div>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left text-xs">
            <thead className={`text-[10px] uppercase tracking-[0.14em] ${tableHeadCls}`}>
              <tr>
                <th className="px-5 py-3">Thiết kế &amp; Màu / Size</th>
                <th className="px-4 py-3 text-right">Lượt ướm AI</th>
                <th className="px-4 py-3 text-right">Tỷ lệ Thêm giỏ</th>
                <th className="px-4 py-3 text-right">Tồn khả dụng</th>
                <th className="px-4 py-3">Rủi ro tồn kho</th>
                <th className="px-5 py-3 text-right">Hành động B2B AI</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[#B08A4A]/15">
              {filteredDemandRows.length === 0 ? (
                <tr>
                  <td colSpan={6} className={`px-6 py-8 text-center ${mutedCls}`}>
                    {loading
                      ? 'Đang tổng hợp tín hiệu nhu cầu Try-On...'
                      : 'Không có thiết kế nào khớp bộ lọc hiện tại.'}
                  </td>
                </tr>
              ) : (
                filteredDemandRows.map((row) => {
                  const riskBadge = getStockRiskBadge(row.lowStockRisk);
                  const sessionFillPct = Math.round(
                    (row.tryOnSessions / maxTryOnCount) * 100,
                  );

                  return (
                    <tr key={row.rowKey} className={`transition-colors ${rowHoverCls}`}>
                      <td className="px-5 py-3">
                        <div className="flex items-center gap-2.5">
                          <span
                            className="h-4 w-4 shrink-0 rounded-full border border-[#B08A4A]/45"
                            style={{ backgroundColor: row.colorHex }}
                            title={row.colorName}
                          />
                          <div className="min-w-0">
                            <p className="truncate font-semibold">{row.productName}</p>
                            <p className={`font-mono text-[10px] ${mutedCls}`}>
                              {row.colorName} · Size {row.size} · {row.skuCode}
                            </p>
                          </div>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <p className="font-mono font-semibold tabular-nums">
                          <AnimatedTelemetryNumber value={row.tryOnSessions} />
                        </p>
                        <div className="ml-auto mt-1 w-20">
                          <LiveStreamProgressBar
                            percent={sessionFillPct}
                            tone="gold"
                            height="xs"
                            isDark={darkMode}
                          />
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right font-mono tabular-nums">
                        <span className="font-semibold">{row.addToCartRatePct}%</span>
                        <p className={`text-[10px] ${mutedCls}`}>
                          {row.addToCartCount} thêm giỏ
                        </p>
                      </td>
                      <td className="px-4 py-3 text-right font-mono font-semibold tabular-nums">
                        {row.availableQty !== null ? row.availableQty : '—'}
                      </td>
                      <td className="px-4 py-3">
                        <span
                          className={`inline-flex rounded-full border px-2.5 py-0.5 text-[10px] font-semibold ${riskBadge.cls}`}
                        >
                          {riskBadge.label}
                        </span>
                      </td>
                      <td className="px-5 py-3 text-right">
                        <button
                          type="button"
                          data-testid={`draft-po-${row.skuCode}`}
                          onClick={() => handleDraftPoWithCopilot(row)}
                          className={`inline-flex items-center gap-1 rounded-full px-3.5 py-1.5 text-[11px] font-semibold transition-opacity hover:opacity-90 ${
                            row.lowStockRisk === 'OUT' || row.lowStockRisk === 'LOW'
                              ? darkMode
                                ? 'bg-[#EBCF8F] text-[#1C1410]'
                                : 'bg-[#1C1410] text-[#EBCF8F]'
                              : darkMode
                                ? 'border border-[#B08A4A]/45 bg-[#231912] text-[#EBCF8F]'
                                : 'border border-[#B08A4A]/45 bg-[#FBF7EF] text-[#1C1410] hover:bg-[#1C1410] hover:text-[#EBCF8F]'
                          }`}
                        >
                          ✦ Lập nháp PO NHAP_AI
                        </button>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
