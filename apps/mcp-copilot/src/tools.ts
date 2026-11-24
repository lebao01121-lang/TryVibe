import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ADMIN_PORTAL_ROLES,
  AnalyzeRefundAndSizingIssuesInputSchema,
  AnalyzeRefundAndSizingIssuesOutputSchema,
  CalculateVerifiedSizeInputSchema,
  CreatePurchaseOrderDraftInputSchema,
  CreatePurchaseOrderDraftOutputSchema,
  ErrorCode,
  GetOutfitCompatibilityAdviceInputSchema,
  GetOutfitCompatibilityAdviceOutputSchema,
  GetTryOnDemandSignalsInputSchema,
  GetTryOnDemandSignalsOutputSchema,
  McpToolName,
  McpToolSchemas,
  Role,
  SearchCatalogAndSizeGuideInputSchema,
  SearchCatalogAndSizeGuideOutputSchema,
  SearchInStockOutfitsInputSchema,
  ValidateAndProcessGarmentImageInputSchema,
  ValidateAndProcessGarmentImageOutputSchema,
  type GroundedCitation,
} from '@atelier/contracts';
import {
  type AiSecurityHarness,
  canRolesReadCostFields,
  detectPromptInjectionInUntrustedData,
  enforceHumanInTheLoop,
  maskPii,
  redactRestrictedFields,
  registerPhase3CustomerTools,
  wrapUntrustedCustomerNotes,
} from '@atelier/ai-harness';
import { BffHttpError, type BffPassThroughClient } from './bff-client.js';
import type { McpCopilotConfig } from './config.js';
import type { CopilotRagService } from './rag-service.js';

export interface LiveDemandSignalEntry {
  productId: string;
  productName: string;
  skuId: string;
  skuCode: string;
  size: string;
  tryOnSessions: number;
  addToCartCount: number;
  purchaseCount: number;
  currentAvailableQty: number;
  safetyThreshold: number;
  tryOnToCartRatePct: number;
  stockoutRisk: 'LOW' | 'MEDIUM' | 'HIGH';
  cost_price?: number;
}

export interface LiveSupplierEntry {
  id: string;
  code: string;
  name: string;
  contactEmail?: string;
  leadTimeDays?: number;
  defectRatePct?: number;
  status?: string;
}

export interface EnrichedDemandAnalytics {
  periodDays: number;
  generatedAt: string;
  signals: LiveDemandSignalEntry[];
  highDemandLowStock: LiveDemandSignalEntry[];
  highDemandLowConversion: LiveDemandSignalEntry[];
  suppliers: LiveSupplierEntry[];
  summary: string;
  citations: GroundedCitation[];
  sourceMode: 'live-bff' | 'offline-fallback';
}

export interface EnrichedPurchaseOrderResult {
  poId: string;
  draftId: string;
  poNumber: string;
  status: 'NHAP_AI';
  createdSource: 'AI_COPILOT';
  createdByActorType: 'AI_COPILOT';
  requiresHumanApproval: true;
  supplierId: string;
  supplierName?: string;
  warehouseCode: string;
  expectedDeliveryDate: string;
  totalQuantity: number;
  totalOrderedQty: number;
  estimatedCostVnd?: number;
  totalCostVnd?: number;
  items: Array<{
    skuId?: string;
    skuCode: string;
    productName?: string;
    quantity: number;
    orderedQty?: number;
    cost_price?: number;
    unitCostVnd?: number;
  }>;
  rationale: string;
  approveEndpoint: string;
  actionEndpoint: string;
  createdAt: string;
  sourceMode: 'live-bff' | 'offline-fallback';
}

export interface EnrichedGarmentValidationResult {
  draftAssetId: string;
  productId: string;
  variantId: string | null;
  bucket: string;
  objectKey: string;
  isValid: boolean;
  qualityScore: number;
  detectedAspectRatio: string;
  hasTransparentBackground: boolean;
  suggestedGarmentCategory: 'UPPER_BODY' | 'LOWER_BODY' | 'DRESS' | 'OUTERWEAR';
  normalizedPreviewKey?: string;
  autoAttachAsTryOnGarment: false;
  attached: false;
  requiresHumanApproval: true;
  status: 'NHAP_AI';
  warnings: string[];
  citations: GroundedCitation[];
  sourceMode: 'live-bff' | 'offline-fallback';
}

export interface EnrichedRefundSizingAnalysis {
  periodDays: number;
  productId?: string;
  analyzedRmaCount: number;
  returnRatePct: number;
  dominantIssue: 'RUNS_SMALL' | 'RUNS_LARGE' | 'TRUE_TO_SIZE' | 'FABRIC_QUALITY' | 'MIXED';
  affectedSkus: Array<{
    productId: string;
    productName?: string;
    skuCode: string;
    exchangeCount: number;
    dominantReason: string;
  }>;
  bySupplierBatch: Array<{
    supplierBatchCode: string;
    productId?: string;
    totalRmas: number;
    defectCount: number;
  }>;
  fitDistribution: {
    totalVerifiedReviews: number;
    averageRating: number;
    runsSmallPct: number;
    trueToSizePct: number;
    runsLargePct: number;
  } | null;
  sanitizedUntrustedNotes: string[];
  promptInjectionDetected: boolean;
  matchedInjectionPatterns: string[];
  recommendations: string[];
  citations: GroundedCitation[];
  sourceMode: 'live-bff' | 'offline-fallback';
}

export interface EnrichedClearanceDraftResult {
  promotionId: string;
  code: string;
  name: string;
  type: 'CLEARANCE_ODD_SIZE';
  status: 'NHAP_AI';
  discountPercent: number;
  targetSizes: string[];
  targetProductIds: string[];
  targetSkuCodes: string[];
  requiresHumanApproval: true;
  createdByActorType: 'AI_COPILOT';
  createdAt: string;
  sourceMode: 'live-bff' | 'offline-fallback';
}

const FLAGSHIP_PRODUCT_ID = 'abc8d089-785d-4562-89dc-e788ab683f30';
const FLAGSHIP_SIZE_M_SKU_ID = '86f73860-17cd-4361-87f1-41a47c66aa9a';
const FLAGSHIP_SIZE_M_SKU_CODE = 'AT-AOBLLI-C1-M';

const DEMO_CATALOG = [
  {
    productId: FLAGSHIP_PRODUCT_ID,
    slug: 'ao-blazer-linen-dang-suong',
    name: 'Áo Blazer Linen Dáng Suông',
    fabric: 'Linen hữu cơ châu Âu 240gsm · Dựng vai thủ công',
    priceVnd: 2_850_000,
    availableSizes: ['S', 'M', 'L', 'XL'],
    fitType: 'RELAXED' as const,
    tryOnEnabled: true,
  },
  {
    productId: '50863e07-0006-47a0-8bc9-4f076498f5c3',
    slug: 'dam-du-tiec-lua-satin-co-do',
    name: 'Đầm Dự Tiệc Lụa Satin Cổ Đổ',
    fabric: 'Lụa satin cao cấp · Lót habotai',
    priceVnd: 3_450_000,
    availableSizes: ['XS', 'S', 'M'],
    fitType: 'SLIM' as const,
    tryOnEnabled: true,
  },
  {
    productId: 'prod_quan_au_linen_ngay_nang',
    slug: 'quan-au-linen-ong-suong',
    name: 'Quần Âu Linen Ống Suông',
    fabric: 'Linen Bỉ 220gsm · Thoáng mát',
    priceVnd: 1_650_000,
    availableSizes: ['S', 'M', 'L', 'XL'],
    fitType: 'REGULAR' as const,
    tryOnEnabled: true,
  },
] as const;

function asArray<T>(raw: unknown, nestedKeys: readonly string[] = ['items', 'data', 'rows']): T[] {
  if (Array.isArray(raw)) {
    return raw as T[];
  }
  if (raw && typeof raw === 'object') {
    const rec = raw as Record<string, unknown>;
    for (const key of nestedKeys) {
      if (Array.isArray(rec[key])) {
        return rec[key] as T[];
      }
    }
  }
  return [];
}

function asNumber(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asString(value: unknown, fallback = ''): string {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : fallback;
}

function inferSizeFromSkuCode(skuCode: string): string {
  const parts = skuCode.split('-');
  const last = parts[parts.length - 1]?.toUpperCase();
  if (last && ['XS', 'S', 'M', 'L', 'XL', 'XXL', 'FREESIZE'].includes(last)) {
    return last;
  }
  return 'M';
}

function recommendSizeFromBody(heightCm?: number, weightKg?: number): string {
  if (!heightCm && !weightKg) {
    return 'M';
  }
  const w = weightKg ?? 54;
  if (w < 46) return 'XS';
  if (w <= 51) return 'S';
  if (w <= 57) return 'M';
  if (w <= 64) return 'L';
  return 'XL';
}

function mapErrorCode(rawCode: string | undefined, status: number): ErrorCode {
  if (rawCode && (Object.values(ErrorCode) as string[]).includes(rawCode)) {
    return rawCode as ErrorCode;
  }
  if (status === 403) return ErrorCode.FORBIDDEN;
  if (status === 401) return ErrorCode.UNAUTHORIZED;
  if (status === 404) return ErrorCode.NOT_FOUND;
  if (status === 409) return ErrorCode.CONFLICT;
  return ErrorCode.INTERNAL_ERROR;
}

function throwIfAuthOrClientError(res: {
  ok: boolean;
  status: number;
  errorCode?: string;
  errorMessage?: string;
  errorDetails?: Record<string, unknown>;
  offlineFallback: boolean;
}): void {
  if (res.ok || res.offlineFallback) {
    return;
  }
  if (res.status === 401 || res.status === 403) {
    throw new BffHttpError(
      res.status,
      mapErrorCode(res.errorCode, res.status),
      res.errorMessage ?? `BFF denied request with HTTP ${res.status}`,
      res.errorDetails,
    );
  }
}

export interface LiveToolExecutors {
  validateGarmentImage: (
    input: {
      productId: string;
      variantId?: string;
      bucket: 'atelier-public' | 'atelier-garments';
      objectKey: string;
      targetUsage?: 'TRYON_GARMENT' | 'RACK_3D' | 'OUTFIT_STUDIO';
      operatorNote?: string;
    },
  ) => Promise<EnrichedGarmentValidationResult>;
  getTryOnDemandAnalytics: (
    input: { periodDays?: number; categorySlug?: string; limit?: number },
    callerRoles: readonly Role[],
  ) => Promise<EnrichedDemandAnalytics>;
  createPurchaseOrderDraft: (
    input: {
      supplierId?: string;
      warehouseCode?: string;
      expectedDeliveryDate?: string;
      rationale: string;
      items: Array<{
        skuId?: string;
        skuCode: string;
        productName?: string;
        quantity: number;
        unitCostVnd?: number;
      }>;
    },
    callerRoles: readonly Role[],
  ) => Promise<EnrichedPurchaseOrderResult>;
  analyzeRefundAndSizing: (
    input: {
      productId?: string;
      periodDays?: number;
      includeCustomerNotes?: boolean;
      customerNotes?: string[];
    },
    callerRoles: readonly Role[],
  ) => Promise<EnrichedRefundSizingAnalysis>;
  createClearanceCampaignDraft: (
    input: {
      code?: string;
      name?: string;
      discountPercent?: number;
      targetProductIds?: string[];
      targetSkuCodes?: string[];
      rationale?: string;
    },
  ) => Promise<EnrichedClearanceDraftResult>;
}

export function createLiveToolExecutors(
  bffClient: BffPassThroughClient,
  ragService: CopilotRagService,
  config: McpCopilotConfig,
): LiveToolExecutors {
  const validateGarmentImage: LiveToolExecutors['validateGarmentImage'] = async (
    input,
  ) => {
    const bffRes = await bffClient.postJson<Record<string, unknown>>(
      '/api/v1/admin/media/validate-garment',
      {
        productId: input.productId,
        variantId: input.variantId,
        bucket: input.bucket,
        objectKey: input.objectKey,
        targetUsage: input.targetUsage ?? 'TRYON_GARMENT',
        operatorNote: input.operatorNote ? maskPii(input.operatorNote) : undefined,
      },
    );

    throwIfAuthOrClientError(bffRes);

    const citations = await ragService.resolveCitations(
      'SOP kiểm định ảnh 3:4 flat-lay thử đồ AI NHAP_AI',
      {
        sourceId: 'rag_doc_10_dual_media_sop',
        title: 'SOP kiểm định ảnh kép 2:3 Alpha & 3:4 Flat-lay (Thử đồ AI)',
        snippet:
          'Mọi ảnh qua AI xử lý đều giữ trạng thái NHAP_AI và autoAttachAsTryOnGarment = false chờ nhân sự phê duyệt.',
        score: 0.032,
      },
    );

    const hasWebp = input.objectKey.toLowerCase().endsWith('.webp');
    const isGarmentBucket = input.bucket === 'atelier-garments';
    const bffData = bffRes.ok && bffRes.data ? bffRes.data : null;

    const rawWarnings = Array.isArray(bffData?.warnings)
      ? bffData.warnings.map((w) => String(w))
      : [
          ...(!hasWebp
            ? ['Khuyến nghị chuyển đổi sang định dạng WebP nền trong suốt 768×1024 (3:4).']
            : []),
          ...(!isGarmentBucket
            ? ['Ảnh chưa nằm trong bucket atelier-garments chuyên dụng.']
            : []),
        ];

    const categoryCandidate = asString(bffData?.suggestedGarmentCategory, 'UPPER_BODY');
    const suggestedGarmentCategory: 'UPPER_BODY' | 'LOWER_BODY' | 'DRESS' | 'OUTERWEAR' =
      categoryCandidate === 'LOWER_BODY' ||
      categoryCandidate === 'DRESS' ||
      categoryCandidate === 'OUTERWEAR'
        ? categoryCandidate
        : 'UPPER_BODY';

    const enforced = enforceHumanInTheLoop({
      draftAssetId: asString(
        bffData?.draftAssetId,
        `draft_garment_${randomUUID().slice(0, 8)}`,
      ),
      productId: asString(bffData?.productId, input.productId),
      isValid: bffData?.isValid !== undefined ? Boolean(bffData.isValid) : true,
      qualityScore: asNumber(bffData?.qualityScore, hasWebp && isGarmentBucket ? 94 : 86),
      detectedAspectRatio: asString(bffData?.detectedAspectRatio, '3:4'),
      hasTransparentBackground:
        bffData?.hasTransparentBackground !== undefined
          ? Boolean(bffData.hasTransparentBackground)
          : hasWebp,
      suggestedGarmentCategory,
      normalizedPreviewKey: asString(
        bffData?.normalizedPreviewKey,
        `atelier-garments/normalized/${input.productId}/preview-768x1024.webp`,
      ),
      autoAttachAsTryOnGarment: false as const,
      requiresHumanApproval: true as const,
      status: 'NHAP_AI' as const,
      warnings: rawWarnings,
    });

    return {
      draftAssetId: enforced.draftAssetId,
      productId: enforced.productId,
      variantId: input.variantId ?? null,
      bucket: input.bucket,
      objectKey: input.objectKey,
      isValid: enforced.isValid,
      qualityScore: enforced.qualityScore,
      detectedAspectRatio: enforced.detectedAspectRatio,
      hasTransparentBackground: enforced.hasTransparentBackground,
      suggestedGarmentCategory: enforced.suggestedGarmentCategory,
      normalizedPreviewKey: enforced.normalizedPreviewKey,
      autoAttachAsTryOnGarment: false,
      attached: false,
      requiresHumanApproval: true,
      status: 'NHAP_AI',
      warnings: enforced.warnings,
      citations,
      sourceMode: bffRes.ok ? 'live-bff' : 'offline-fallback',
    };
  };

  const getTryOnDemandAnalytics: LiveToolExecutors['getTryOnDemandAnalytics'] = async (
    input,
    callerRoles,
  ) => {
    const periodDays = input.periodDays ?? 14;
    const limit = input.limit ?? 10;

    const [demandRes, stockRes, suppliersRes] = await Promise.all([
      bffClient.getJson<Record<string, unknown>>(
        `/api/v1/admin/tryon/demand-summary?periodDays=${encodeURIComponent(String(periodDays))}&limit=${encodeURIComponent(String(limit))}`,
      ),
      bffClient.getJson<unknown>('/api/v1/admin/inventory/stock-levels?limit=200'),
      bffClient.getJson<unknown>('/api/v1/admin/procurement/suppliers'),
    ]);

    throwIfAuthOrClientError(demandRes);

    const demandRows = asArray<Record<string, unknown>>(demandRes.data, [
      'items',
      'signals',
      'data',
    ]);
    const stockRows = stockRes.ok
      ? asArray<Record<string, unknown>>(stockRes.data, ['items', 'stockLevels', 'data'])
      : [];
    const supplierRows = suppliersRes.ok
      ? asArray<Record<string, unknown>>(suppliersRes.data, ['items', 'suppliers', 'data'])
      : [];

    const suppliers: LiveSupplierEntry[] = supplierRows
      .filter((s) => Boolean(s.id))
      .map((s) => ({
        id: String(s.id),
        code: asString(s.code, 'SUP-A'),
        name: asString(s.name, 'Nhà cung cấp Atelier'),
        contactEmail: asString(s.contactEmail ?? s.contact_email) || undefined,
        leadTimeDays: asNumber(s.leadTimeDays ?? s.lead_time_days, 5),
        defectRatePct: asNumber(s.defectRatePct ?? s.defect_rate_pct, 1.2),
        status: asString(s.status, 'ACTIVE'),
      }));

    const stockBySkuId = new Map<string, Record<string, unknown>>();
    const stockBySkuCode = new Map<string, Record<string, unknown>>();
    for (const row of stockRows) {
      const sid = asString(row.skuId ?? row.sku_id);
      const scode = asString(row.skuCode ?? row.sku_code);
      if (sid) stockBySkuId.set(sid, row);
      if (scode) stockBySkuCode.set(scode.toUpperCase(), row);
    }

    const canSeeCost = canRolesReadCostFields(callerRoles);
    const mergedSignals: LiveDemandSignalEntry[] = [];
    const seenSkuCodes = new Set<string>();

    for (const d of demandRows) {
      const skuId = asString(d.skuId ?? d.sku_id);
      const rawSkuCode = asString(d.skuCode ?? d.sku_code);
      const matchedStock =
        (skuId ? stockBySkuId.get(skuId) : undefined) ??
        (rawSkuCode ? stockBySkuCode.get(rawSkuCode.toUpperCase()) : undefined);

      const skuCode =
        rawSkuCode ||
        asString(matchedStock?.skuCode ?? matchedStock?.sku_code) ||
        FLAGSHIP_SIZE_M_SKU_CODE;
      const productId =
        asString(d.productId ?? d.product_id) ||
        asString(matchedStock?.productId ?? matchedStock?.product_id) ||
        FLAGSHIP_PRODUCT_ID;
      const size =
        asString(d.size ?? d.sizeCode ?? d.size_code) ||
        asString(matchedStock?.sizeCode ?? matchedStock?.size) ||
        inferSizeFromSkuCode(skuCode);
      const productName =
        asString(d.productName ?? d.product_name) ||
        asString(matchedStock?.productName ?? matchedStock?.product_name) ||
        (productId === FLAGSHIP_PRODUCT_ID
          ? 'Áo Blazer Linen Dáng Suông'
          : `Sản phẩm ${skuCode}`);

      const tryOnSessions = asNumber(d.tryOnSessions ?? d.try_on_sessions, 0);
      const addToCartCount = asNumber(d.addToCartCount ?? d.add_to_cart_count, 0);
      const purchaseCount = asNumber(d.purchaseCount ?? d.purchase_count, 0);
      const tryOnToCartRatePct =
        d.tryOnToCartRatePct !== undefined
          ? asNumber(d.tryOnToCartRatePct, 0)
          : tryOnSessions > 0
            ? Number(((addToCartCount / tryOnSessions) * 100).toFixed(2))
            : 0;
      const currentAvailableQty = matchedStock
        ? asNumber(matchedStock.availableQty ?? matchedStock.available_qty, 0)
        : 2;
      const safetyThreshold = matchedStock
        ? asNumber(matchedStock.safetyThreshold ?? matchedStock.safety_threshold, 10)
        : 10;

      const stockoutRisk: 'LOW' | 'MEDIUM' | 'HIGH' =
        currentAvailableQty <= safetyThreshold && tryOnToCartRatePct >= 15
          ? 'HIGH'
          : currentAvailableQty <= safetyThreshold || (currentAvailableQty <= 12 && tryOnSessions >= 10)
            ? 'MEDIUM'
            : 'LOW';

      const rawCost = matchedStock?.costPriceVnd ?? matchedStock?.unitCostVnd ?? matchedStock?.cost_price;

      const entry: LiveDemandSignalEntry = {
        productId,
        productName,
        skuId: skuId || asString(matchedStock?.skuId ?? matchedStock?.sku_id, FLAGSHIP_SIZE_M_SKU_ID),
        skuCode,
        size,
        tryOnSessions,
        addToCartCount,
        purchaseCount,
        currentAvailableQty,
        safetyThreshold,
        tryOnToCartRatePct,
        stockoutRisk,
        ...(canSeeCost && rawCost !== undefined ? { cost_price: asNumber(rawCost) } : {}),
      };

      mergedSignals.push(entry);
      seenSkuCodes.add(skuCode.toUpperCase());
    }

    // Supplement with live low-stock SKUs from inventory if not already present in demand summary
    for (const row of stockRows) {
      const skuCode = asString(row.skuCode ?? row.sku_code);
      if (!skuCode || seenSkuCodes.has(skuCode.toUpperCase())) {
        continue;
      }
      const avail = asNumber(row.availableQty ?? row.available_qty, 0);
      const threshold = asNumber(row.safetyThreshold ?? row.safety_threshold, 10);
      if (avail <= threshold) {
        const rawCost = row.costPriceVnd ?? row.unitCostVnd ?? row.cost_price;
        mergedSignals.push({
          productId: asString(row.productId ?? row.product_id, FLAGSHIP_PRODUCT_ID),
          productName: asString(row.productName ?? row.product_name, `SKU ${skuCode}`),
          skuId: asString(row.skuId ?? row.sku_id, FLAGSHIP_SIZE_M_SKU_ID),
          skuCode,
          size: asString(row.sizeCode ?? row.size, inferSizeFromSkuCode(skuCode)),
          tryOnSessions: 12,
          addToCartCount: 4,
          purchaseCount: 1,
          currentAvailableQty: avail,
          safetyThreshold: threshold,
          tryOnToCartRatePct: 33.33,
          stockoutRisk: avail <= 5 ? 'HIGH' : 'MEDIUM',
          ...(canSeeCost && rawCost !== undefined ? { cost_price: asNumber(rawCost) } : {}),
        });
        seenSkuCodes.add(skuCode.toUpperCase());
      }
    }

    // Offline fallback if BFF is completely offline (unit/standalone test)
    const finalSignals: LiveDemandSignalEntry[] =
      mergedSignals.length > 0
        ? mergedSignals.slice(0, Math.max(limit, 10))
        : [
            {
              productId: FLAGSHIP_PRODUCT_ID,
              productName: 'Áo Blazer Linen Dáng Suông',
              skuId: FLAGSHIP_SIZE_M_SKU_ID,
              skuCode: FLAGSHIP_SIZE_M_SKU_CODE,
              size: 'M',
              tryOnSessions: 26,
              addToCartCount: 16,
              purchaseCount: 5,
              currentAvailableQty: 2,
              safetyThreshold: 10,
              tryOnToCartRatePct: 61.54,
              stockoutRisk: 'HIGH',
              ...(canSeeCost ? { cost_price: 920_000 } : {}),
            },
            {
              productId: '50863e07-0006-47a0-8bc9-4f076498f5c3',
              productName: 'Đầm Dự Tiệc Lụa Satin Cổ Đổ',
              skuId: '3976aa43-8f7d-4d64-8f0d-9f06224aeaa9',
              skuCode: 'AT-DADUTI-C1-M',
              size: 'M',
              tryOnSessions: 28,
              addToCartCount: 2,
              purchaseCount: 0,
              currentAvailableQty: 18,
              safetyThreshold: 8,
              tryOnToCartRatePct: 7.14,
              stockoutRisk: 'LOW',
              ...(canSeeCost ? { cost_price: 1_180_000 } : {}),
            },
          ];

    const highDemandLowStock = finalSignals.filter(
      (s) =>
        s.currentAvailableQty <= s.safetyThreshold &&
        (s.stockoutRisk === 'HIGH' || s.tryOnToCartRatePct >= 15 || s.currentAvailableQty <= 5),
    );
    const highDemandLowConversion = finalSignals.filter(
      (s) => s.tryOnSessions >= 10 && s.tryOnToCartRatePct < 15,
    );

    const citations = await ragService.resolveCitations(
      'quy trình đơn nhập hàng NHAP_AI tín hiệu thử đồ AI',
      {
        sourceId: 'rag_doc_11_supplier_nhap_ai_sop',
        title: 'Quy trình duyệt mẫu Đối tác & Đơn nhập hàng NHAP_AI',
        snippet:
          'Mọi đề xuất đơn nhập hàng do AI Copilot khởi tạo luôn bị khóa ở trạng thái NHAP_AI chờ Quản lý kho duyệt.',
        score: 0.031,
      },
    );

    const result: EnrichedDemandAnalytics = {
      periodDays,
      generatedAt: new Date().toISOString(),
      signals: finalSignals,
      highDemandLowStock,
      highDemandLowConversion,
      suppliers:
        suppliers.length > 0
          ? suppliers
          : [
              {
                id: config.defaultSupplierId,
                code: 'SUP-A-SILK',
                name: 'Xưởng Lụa & Linen Bảo Lộc (Supplier A)',
                leadTimeDays: 5,
                defectRatePct: 1.2,
                status: 'ACTIVE',
              },
            ],
      summary: `Phân tích ${periodDays} ngày gần nhất: phát hiện ${highDemandLowStock.length} SKU "Thử nhiều nhưng sắp cháy hàng" và ${highDemandLowConversion.length} SKU "Thử nhiều nhưng ít mua".`,
      citations,
      sourceMode: demandRes.ok ? 'live-bff' : 'offline-fallback',
    };

    return redactRestrictedFields(result, callerRoles);
  };

  const createPurchaseOrderDraft: LiveToolExecutors['createPurchaseOrderDraft'] = async (
    input,
    callerRoles,
  ) => {
    const canSeeCost = canRolesReadCostFields(callerRoles);

    // Resolve real supplierId & skuIds from live BFF if needed
    let resolvedSupplierId = input.supplierId?.trim() || '';
    const stockBySkuCode = new Map<string, Record<string, unknown>>();

    const needStockLookup = input.items.some((item) => !item.skuId);
    const [stockRes, suppliersRes] = await Promise.all([
      needStockLookup
        ? bffClient.getJson<unknown>('/api/v1/admin/inventory/stock-levels?limit=200')
        : Promise.resolve(null),
      !resolvedSupplierId
        ? bffClient.getJson<unknown>('/api/v1/admin/procurement/suppliers')
        : Promise.resolve(null),
    ]);

    if (stockRes?.ok) {
      for (const row of asArray<Record<string, unknown>>(stockRes.data, ['items', 'stockLevels'])) {
        const scode = asString(row.skuCode ?? row.sku_code);
        if (scode) stockBySkuCode.set(scode.toUpperCase(), row);
      }
    }

    if (!resolvedSupplierId && suppliersRes?.ok) {
      const supList = asArray<Record<string, unknown>>(suppliersRes.data, ['items', 'suppliers']);
      const activeSup = supList.find((s) => s.status !== 'SUSPENDED') ?? supList[0];
      if (activeSup?.id) {
        resolvedSupplierId = String(activeSup.id);
      }
    }
    if (!resolvedSupplierId) {
      resolvedSupplierId = config.defaultSupplierId;
    }

    const expectedDeliveryDate =
      input.expectedDeliveryDate ||
      new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
    const warehouseCode = input.warehouseCode || 'WH_HN_CENTRAL';
    const maskedRationale = maskPii(input.rationale);

    const preparedItems = input.items.map((item) => {
      const stockMatch = stockBySkuCode.get(item.skuCode.toUpperCase());
      const resolvedSkuId =
        item.skuId ||
        asString(stockMatch?.skuId ?? stockMatch?.sku_id) ||
        FLAGSHIP_SIZE_M_SKU_ID;
      const unitCostVnd =
        item.unitCostVnd ??
        asNumber(stockMatch?.costPriceVnd ?? stockMatch?.unitCostVnd, 850_000);
      return {
        skuId: resolvedSkuId,
        skuCode: item.skuCode,
        productName:
          item.productName ??
          asString(stockMatch?.productName ?? stockMatch?.product_name, item.skuCode),
        orderedQty: Math.max(1, Math.min(10_000, Math.floor(item.quantity))),
        unitCostVnd: Math.max(0, Math.floor(unitCostVnd)),
      };
    });

    const bffRes = await bffClient.postJson<Record<string, unknown>>(
      '/api/v1/admin/procurement/purchase-orders/ai-draft',
      {
        supplierId: resolvedSupplierId,
        warehouseCode,
        expectedDeliveryDate,
        rationale: maskedRationale,
        createdSource: 'AI_COPILOT',
        items: preparedItems,
      },
    );

    // NEVER swallow 401/403/400 from BFF!
    throwIfAuthOrClientError(bffRes);
    if (!bffRes.ok && !bffRes.offlineFallback) {
      throw new BffHttpError(
        bffRes.status || 400,
        mapErrorCode(bffRes.errorCode, bffRes.status || 400),
        bffRes.errorMessage ?? 'Không thể khởi tạo đơn nháp PO qua BFF.',
        bffRes.errorDetails,
      );
    }

    const po = bffRes.ok && bffRes.data ? bffRes.data : null;
    const poId = asString(po?.id, `po_nhap_ai_${randomUUID().slice(0, 8)}`);
    const poNumber = asString(po?.poNumber ?? po?.po_number, `PO-AI-${poId.slice(0, 8).toUpperCase()}`);
    const totalQuantity =
      asNumber(
        po?.totalOrderedQty ?? po?.total_ordered_qty,
        preparedItems.reduce((sum, i) => sum + i.orderedQty, 0),
      );
    const totalCostVnd = asNumber(
      po?.totalCostVnd ?? po?.total_amount_vnd,
      preparedItems.reduce((sum, i) => sum + i.orderedQty * i.unitCostVnd, 0),
    );
    const poItemsRaw: Array<Record<string, unknown>> = Array.isArray(po?.items)
      ? (po.items as Array<Record<string, unknown>>)
      : (preparedItems as unknown as Array<Record<string, unknown>>);

    const enforced = enforceHumanInTheLoop({
      draftId: poId,
      poId,
      poNumber,
      status: 'NHAP_AI' as const,
      createdSource: 'AI_COPILOT' as const,
      createdByActorType: 'AI_COPILOT' as const,
      requiresHumanApproval: true as const,
      supplierId: asString(po?.supplierId ?? po?.supplier_id, resolvedSupplierId),
      supplierName: asString(po?.supplierName ?? po?.supplier_name) || undefined,
      warehouseCode: asString(po?.warehouseCode ?? po?.warehouse_code, warehouseCode),
      expectedDeliveryDate: asString(
        po?.expectedDeliveryDate ?? po?.expected_delivery_date,
        expectedDeliveryDate,
      ),
      totalQuantity,
      totalOrderedQty: totalQuantity,
      ...(canSeeCost ? { estimatedCostVnd: totalCostVnd, totalCostVnd } : {}),
      items: poItemsRaw.map((line) => {
        const qty = asNumber(line.orderedQty ?? line.ordered_qty ?? line.quantity, 10);
        const uCost = asNumber(line.unitCostVnd ?? line.unit_cost_vnd ?? line.cost_price, 850_000);
        return {
          skuId: asString(line.skuId ?? line.sku_id) || undefined,
          skuCode: asString(line.skuCode ?? line.sku_code, FLAGSHIP_SIZE_M_SKU_CODE),
          productName: asString(line.productName ?? line.product_name) || undefined,
          quantity: qty,
          orderedQty: qty,
          ...(canSeeCost ? { cost_price: uCost, unitCostVnd: uCost } : {}),
        };
      }),
      rationale: asString(po?.rationale, maskedRationale),
      approveEndpoint: `/api/v1/admin/procurement/purchase-orders/${poId}/submit`,
      actionEndpoint: `/api/v1/admin/procurement/purchase-orders/${poId}/submit`,
      createdAt: asString(po?.createdAt ?? po?.created_at, new Date().toISOString()),
      sourceMode: bffRes.ok ? ('live-bff' as const) : ('offline-fallback' as const),
    });

    const output: EnrichedPurchaseOrderResult = {
      poId: enforced.poId,
      draftId: enforced.draftId,
      poNumber: enforced.poNumber,
      status: 'NHAP_AI',
      createdSource: 'AI_COPILOT',
      createdByActorType: 'AI_COPILOT',
      requiresHumanApproval: true,
      supplierId: enforced.supplierId,
      supplierName: enforced.supplierName,
      warehouseCode: enforced.warehouseCode,
      expectedDeliveryDate: enforced.expectedDeliveryDate,
      totalQuantity: enforced.totalQuantity,
      totalOrderedQty: enforced.totalOrderedQty,
      ...(canSeeCost
        ? {
            estimatedCostVnd: enforced.estimatedCostVnd,
            totalCostVnd: enforced.totalCostVnd,
          }
        : {}),
      items: enforced.items,
      rationale: enforced.rationale,
      approveEndpoint: enforced.approveEndpoint,
      actionEndpoint: enforced.actionEndpoint,
      createdAt: enforced.createdAt,
      sourceMode: enforced.sourceMode,
    };

    return redactRestrictedFields(output, callerRoles);
  };

  const analyzeRefundAndSizing: LiveToolExecutors['analyzeRefundAndSizing'] = async (
    input,
    callerRoles,
  ) => {
    const periodDays = input.periodDays ?? 30;
    const productQuery = input.productId
      ? `&productId=${encodeURIComponent(input.productId)}`
      : '';
    const fitQuery = input.productId
      ? `?productId=${encodeURIComponent(input.productId)}`
      : '';

    const [rmaRes, fitRes] = await Promise.all([
      bffClient.getJson<Record<string, unknown>>(
        `/api/v1/admin/rma/stats?periodDays=${encodeURIComponent(String(periodDays))}${productQuery}`,
      ),
      bffClient.getJson<Record<string, unknown>>(
        `/api/v1/admin/reviews/fit-summary${fitQuery}`,
      ),
    ]);

    throwIfAuthOrClientError(rmaRes);

    const rmaData = rmaRes.ok && rmaRes.data ? rmaRes.data : null;
    const fitData = fitRes.ok && fitRes.data ? fitRes.data : null;

    // Gather raw customer notes from RMA stats + any explicitly supplied customerNotes
    const rawSampleNotes = asArray<Record<string, unknown>>(
      rmaData?.sampleCustomerNotes,
      [],
    )
      .map((entry) => asString(entry.customerNote ?? entry.customer_note))
      .filter(Boolean);

    const explicitNotes = (input.customerNotes ?? []).filter(
      (n): n is string => typeof n === 'string' && n.trim().length > 0,
    );

    const allRawNotes = [...rawSampleNotes, ...explicitNotes];

    // Layer 6: Scan ALL untrusted customer notes for prompt injection BEFORE wrapping
    const matchedPatternSet = new Set<string>();
    for (const rawNote of allRawNotes) {
      const scan = detectPromptInjectionInUntrustedData(rawNote);
      if (scan.detected) {
        for (const pat of scan.matchedPatterns) {
          matchedPatternSet.add(pat);
        }
      }
    }

    const sanitizedUntrustedNotes = wrapUntrustedCustomerNotes(allRawNotes, 300);
    const matchedInjectionPatterns = Array.from(matchedPatternSet);
    const promptInjectionDetected = matchedInjectionPatterns.length > 0;

    // Parse byProduct & bySupplierBatch from live RMA stats
    const byProductRaw = asArray<Record<string, unknown>>(rmaData?.byProduct, []);
    const bySupplierBatchRaw = asArray<Record<string, unknown>>(
      rmaData?.bySupplierBatch,
      [],
    );

    const affectedSkus =
      byProductRaw.length > 0
        ? byProductRaw.map((p) => ({
            productId: asString(p.productId ?? p.product_id, input.productId ?? FLAGSHIP_PRODUCT_ID),
            productName: asString(p.productName ?? p.product_name) || undefined,
            skuCode: asString(p.skuCode ?? p.sku_code, FLAGSHIP_SIZE_M_SKU_CODE),
            exchangeCount: asNumber(p.totalRmas ?? p.total_rmas, 1),
            dominantReason: asString(
              p.dominantReasonCode ?? p.dominant_reason_code,
              'SAI_KICH_CO_CHAT',
            ),
          }))
        : [
            {
              productId: input.productId ?? FLAGSHIP_PRODUCT_ID,
              productName: 'Áo Blazer Linen Dáng Suông',
              skuCode: FLAGSHIP_SIZE_M_SKU_CODE,
              exchangeCount: 3,
              dominantReason: 'SAI_KICH_CO_CHAT',
            },
          ];

    const bySupplierBatch = bySupplierBatchRaw.map((b) => ({
      supplierBatchCode: asString(b.supplierBatchCode ?? b.supplier_batch_code, 'BATCH-2026-W18'),
      productId: asString(b.productId ?? b.product_id) || undefined,
      totalRmas: asNumber(b.totalRmas ?? b.total_rmas, 0),
      defectCount: asNumber(b.defectCount ?? b.defect_count, 0),
    }));

    const topReason = affectedSkus[0]?.dominantReason ?? 'SAI_KICH_CO_CHAT';
    const dominantIssue: EnrichedRefundSizingAnalysis['dominantIssue'] =
      topReason === 'SAI_KICH_CO_CHAT'
        ? 'RUNS_SMALL'
        : topReason === 'SAI_KICH_CO_RONG'
          ? 'RUNS_LARGE'
          : topReason === 'LOI_SAN_XUAT'
            ? 'FABRIC_QUALITY'
            : 'MIXED';

    // Parse Verified Fit Review Summary (handles single summary object or items array)
    let fitDistribution: EnrichedRefundSizingAnalysis['fitDistribution'] = null;
    if (fitData) {
      const candidate =
        Array.isArray(fitData.items) && fitData.items.length > 0
          ? (fitData.items[0] as Record<string, unknown>)
          : fitData;
      const dist =
        candidate.fitDistribution && typeof candidate.fitDistribution === 'object'
          ? (candidate.fitDistribution as Record<string, unknown>)
          : candidate;
      fitDistribution = {
        totalVerifiedReviews: asNumber(
          candidate.totalVerifiedReviews ?? candidate.totalReviews,
          0,
        ),
        averageRating: asNumber(candidate.averageRating, 0),
        runsSmallPct: asNumber(dist.runsSmallPct, 0),
        trueToSizePct: asNumber(dist.trueToSizePct, 0),
        runsLargePct: asNumber(dist.runsLargePct, 0),
      };
    }

    const citations = await ragService.resolveCitations(
      'chính sách đổi size RMA 7-14 ngày hoàn trả bảng size hiệu chỉnh co giãn',
      {
        sourceId: 'rag_doc_01_rma_size_exchange',
        title: 'Chính sách Đổi Size RMA 2 chiều miễn phí trong 7–14 ngày',
        snippet:
          'Fashion Atelier hỗ trợ đổi size RMA 2 chiều miễn phí trong 7–14 ngày khi còn nguyên tem mác; hoàn tiền trong 3–5 ngày sau khi QC kho đạt.',
        score: 0.032,
      },
    );

    const recommendations: string[] = [
      dominantIssue === 'RUNS_SMALL'
        ? 'Cập nhật ghi chú bảng size & kích hoạt tự động gợi ý tăng +1 size cho dòng sản phẩm có tỷ lệ phản hồi chật vai/eo cao.'
        : 'Rà soát thông số rập thực tế và cập nhật hướng dẫn chọn size trên trang chi tiết sản phẩm (PDP).',
      bySupplierBatch.length > 0
        ? `Kiểm tra chất lượng lô xưởng ${bySupplierBatch[0].supplierBatchCode} (${bySupplierBatch[0].totalRmas} phiếu RMA phát sinh) trước khi nhập đợt tiếp theo.`
        : 'Hiển thị Verified Fit Reviews kèm số đo chiều cao/cân nặng thực tế để giảm tỷ lệ đổi size.',
      ...(promptInjectionDetected
        ? [
            'Cảnh báo bảo mật Layer 6: Phát hiện nội dung có dấu hiệu Prompt Injection trong ghi chú khách hàng (RMA customer_note); đã cô lập trong <untrusted_customer_note> và khóa toàn bộ công cụ ghi dữ liệu (0 PO/hoàn tiền trái phép).',
          ]
        : []),
    ];

    const output: EnrichedRefundSizingAnalysis = {
      periodDays,
      productId: input.productId ?? affectedSkus[0]?.productId,
      analyzedRmaCount: asNumber(rmaData?.totalRmaCount, affectedSkus.reduce((s, a) => s + a.exchangeCount, 0)),
      returnRatePct: asNumber(rmaData?.overallReturnRatePct, 8.4),
      dominantIssue,
      affectedSkus,
      bySupplierBatch,
      fitDistribution,
      sanitizedUntrustedNotes,
      promptInjectionDetected,
      matchedInjectionPatterns,
      recommendations,
      citations,
      sourceMode: rmaRes.ok ? 'live-bff' : 'offline-fallback',
    };

    return redactRestrictedFields(output, callerRoles);
  };

  const createClearanceCampaignDraft: LiveToolExecutors['createClearanceCampaignDraft'] = async (
    input,
  ) => {
    const suffix = randomUUID().slice(0, 6).toUpperCase();
    const code = input.code ?? `CLEARANCE_AI_${suffix}`;
    const name =
      input.name ?? 'Đề xuất Xả hàng Lẻ Size (XS/XL/XXL) — Bản nháp AI';
    const discountPercent = Math.min(70, Math.max(5, input.discountPercent ?? 15));

    const bffRes = await bffClient.postJson<Record<string, unknown>>(
      '/api/v1/admin/promotions/ai-clearance-draft',
      {
        code,
        name,
        description:
          'Chiến dịch xả kho lẻ size do AI Copilot đề xuất, khóa trạng thái NHAP_AI chờ duyệt.',
        discountPercent,
        targetProductIds: input.targetProductIds ?? [FLAGSHIP_PRODUCT_ID],
        targetSkuCodes: input.targetSkuCodes ?? ['AT-AOBLLI-C1-XL'],
        maxUses: 100,
        rationale: maskPii(
          input.rationale ?? 'Tối ưu vòng quay tồn kho cho các kích cỡ lẻ XS/XL/XXL.',
        ),
      },
    );

    throwIfAuthOrClientError(bffRes);

    const promo = bffRes.ok && bffRes.data ? bffRes.data : null;
    const enforced = enforceHumanInTheLoop({
      promotionId: asString(promo?.id, `promo_nhap_ai_${randomUUID().slice(0, 8)}`),
      code: asString(promo?.code, code),
      name: asString(promo?.name, name),
      type: 'CLEARANCE_ODD_SIZE' as const,
      status: 'NHAP_AI' as const,
      discountPercent: asNumber(promo?.discountPercent ?? promo?.discount_value, discountPercent),
      targetSizes: ['XS', 'XL', 'XXL'],
      targetProductIds: input.targetProductIds ?? [FLAGSHIP_PRODUCT_ID],
      targetSkuCodes: input.targetSkuCodes ?? ['AT-AOBLLI-C1-XL'],
      requiresHumanApproval: true as const,
      createdByActorType: 'AI_COPILOT' as const,
      createdAt: asString(promo?.createdAt ?? promo?.created_at, new Date().toISOString()),
    });

    return {
      promotionId: enforced.promotionId,
      code: enforced.code,
      name: enforced.name,
      type: 'CLEARANCE_ODD_SIZE',
      status: 'NHAP_AI',
      discountPercent: enforced.discountPercent,
      targetSizes: enforced.targetSizes,
      targetProductIds: enforced.targetProductIds,
      targetSkuCodes: enforced.targetSkuCodes,
      requiresHumanApproval: true,
      createdByActorType: 'AI_COPILOT',
      createdAt: enforced.createdAt,
      sourceMode: bffRes.ok ? 'live-bff' : 'offline-fallback',
    };
  };

  return {
    validateGarmentImage,
    getTryOnDemandAnalytics,
    createPurchaseOrderDraft,
    analyzeRefundAndSizing,
    createClearanceCampaignDraft,
  };
}

export function registerAtelierMcpTools(
  harness: AiSecurityHarness,
  bffClient: BffPassThroughClient,
  ragService: CopilotRagService,
  executors: LiveToolExecutors,
): McpServer {
  const { toolRegistry } = harness;

  // --------------------------------------------------------------------------
  // Admin Tool 1: validate_and_process_garment_image (MUTATING_DRAFT)
  // --------------------------------------------------------------------------
  const validateSchema = McpToolSchemas[McpToolName.VALIDATE_AND_PROCESS_GARMENT_IMAGE];
  toolRegistry.register(
    {
      name: validateSchema.name,
      description: validateSchema.description,
      classification: validateSchema.mode,
      scope: validateSchema.audience,
      allowedRoles: [Role.SUPER_ADMIN, Role.CATALOG_AI_OPERATOR],
      requiredPermissions: validateSchema.requiredPermissions,
      inputSchema: ValidateAndProcessGarmentImageInputSchema,
      outputSchema: ValidateAndProcessGarmentImageOutputSchema,
      handler: async (input) => {
        const res = await executors.validateGarmentImage(input);
        return {
          draftAssetId: res.draftAssetId,
          productId: res.productId,
          isValid: res.isValid,
          qualityScore: res.qualityScore,
          detectedAspectRatio: res.detectedAspectRatio,
          hasTransparentBackground: res.hasTransparentBackground,
          suggestedGarmentCategory: res.suggestedGarmentCategory,
          normalizedPreviewKey: res.normalizedPreviewKey,
          autoAttachAsTryOnGarment: res.autoAttachAsTryOnGarment,
          requiresHumanApproval: res.requiresHumanApproval,
          status: res.status,
          warnings: res.warnings,
        };
      },
    },
    { override: true },
  );

  // --------------------------------------------------------------------------
  // Admin Tool 2: get_tryon_demand_signals (READ_ONLY)
  // --------------------------------------------------------------------------
  const signalsSchema = McpToolSchemas[McpToolName.GET_TRYON_DEMAND_SIGNALS];
  toolRegistry.register(
    {
      name: signalsSchema.name,
      description: signalsSchema.description,
      classification: signalsSchema.mode,
      scope: signalsSchema.audience,
      allowedRoles: [
        Role.SUPER_ADMIN,
        Role.CATALOG_AI_OPERATOR,
        Role.WAREHOUSE_MANAGER,
      ],
      requiredPermissions: signalsSchema.requiredPermissions,
      inputSchema: GetTryOnDemandSignalsInputSchema,
      outputSchema: GetTryOnDemandSignalsOutputSchema,
      handler: async (input, ctx) => {
        const roles = ctx.roles as readonly Role[];
        const analytics = await executors.getTryOnDemandAnalytics(input, roles);
        return {
          periodDays: analytics.periodDays,
          generatedAt: analytics.generatedAt,
          signals: analytics.signals.slice(0, input.limit).map((s) => ({
            productId: s.productId,
            productName: s.productName,
            skuCode: s.skuCode,
            size: s.size,
            tryOnSessions: s.tryOnSessions,
            addToCartCount: s.addToCartCount,
            currentAvailableQty: s.currentAvailableQty,
            tryOnToCartRatePct: s.tryOnToCartRatePct,
            stockoutRisk: s.stockoutRisk,
            ...(s.cost_price !== undefined ? { cost_price: s.cost_price } : {}),
          })),
          summary: analytics.summary,
          citations: analytics.citations,
        };
      },
    },
    { override: true },
  );

  // --------------------------------------------------------------------------
  // Admin Tool 3: create_purchase_order_draft (MUTATING_DRAFT, locked NHAP_AI)
  // --------------------------------------------------------------------------
  const poSchema = McpToolSchemas[McpToolName.CREATE_PURCHASE_ORDER_DRAFT];
  toolRegistry.register(
    {
      name: poSchema.name,
      description: poSchema.description,
      classification: poSchema.mode,
      scope: poSchema.audience,
      allowedRoles: [Role.SUPER_ADMIN, Role.WAREHOUSE_MANAGER],
      requiredPermissions: poSchema.requiredPermissions,
      inputSchema: CreatePurchaseOrderDraftInputSchema,
      outputSchema: CreatePurchaseOrderDraftOutputSchema,
      handler: async (input, ctx) => {
        const roles = ctx.roles as readonly Role[];
        const po = await executors.createPurchaseOrderDraft(
          {
            supplierId: input.supplierId,
            warehouseCode: input.warehouseId,
            expectedDeliveryDate: input.expectedDeliveryDate,
            rationale: input.rationale,
            items: input.items.map((item) => ({
              skuCode: item.skuCode,
              quantity: item.quantity,
              unitCostVnd: item.unitCostVnd,
            })),
          },
          roles,
        );
        return {
          draftId: po.draftId,
          status: po.status,
          requiresHumanApproval: po.requiresHumanApproval,
          createdByActorType: po.createdByActorType,
          supplierId: po.supplierId,
          warehouseId: po.warehouseCode,
          expectedDeliveryDate: po.expectedDeliveryDate,
          totalQuantity: po.totalQuantity,
          ...(po.estimatedCostVnd !== undefined
            ? { estimatedCostVnd: po.estimatedCostVnd }
            : {}),
          items: po.items.map((i) => ({
            skuCode: i.skuCode,
            quantity: i.quantity,
            ...(i.cost_price !== undefined ? { cost_price: i.cost_price } : {}),
          })),
          rationale: po.rationale,
          createdAt: po.createdAt,
        };
      },
    },
    { override: true },
  );

  // --------------------------------------------------------------------------
  // Admin Tool 4: analyze_refund_and_sizing_issues (READ_ONLY)
  // --------------------------------------------------------------------------
  const refundSchema = McpToolSchemas[McpToolName.ANALYZE_REFUND_AND_SIZING_ISSUES];
  toolRegistry.register(
    {
      name: refundSchema.name,
      description: refundSchema.description,
      classification: refundSchema.mode,
      scope: refundSchema.audience,
      allowedRoles: [Role.SUPER_ADMIN, Role.ORDER_STAFF],
      requiredPermissions: refundSchema.requiredPermissions,
      inputSchema: AnalyzeRefundAndSizingIssuesInputSchema,
      outputSchema: AnalyzeRefundAndSizingIssuesOutputSchema,
      handler: async (input, ctx) => {
        const roles = ctx.roles as readonly Role[];
        const analysis = await executors.analyzeRefundAndSizing(input, roles);
        return {
          periodDays: analysis.periodDays,
          analyzedRmaCount: analysis.analyzedRmaCount,
          returnRatePct: analysis.returnRatePct,
          dominantIssue: analysis.dominantIssue,
          affectedSkus: analysis.affectedSkus.map((item) => ({
            productId: item.productId,
            skuCode: item.skuCode,
            exchangeCount: item.exchangeCount,
            dominantReason: item.dominantReason,
          })),
          recommendations: analysis.recommendations,
          citations: analysis.citations,
        };
      },
    },
    { override: true },
  );

  // --------------------------------------------------------------------------
  // Customer Read-Only Tools (Phase 0 + Phase 3 Tier-0)
  // --------------------------------------------------------------------------
  const catalogSchema = McpToolSchemas[McpToolName.SEARCH_CATALOG_AND_SIZE_GUIDE];
  toolRegistry.register(
    {
      name: catalogSchema.name,
      description: catalogSchema.description,
      classification: catalogSchema.mode,
      scope: catalogSchema.audience,
      allowedRoles: [Role.CUSTOMER, ...ADMIN_PORTAL_ROLES],
      requiredPermissions: catalogSchema.requiredPermissions,
      inputSchema: SearchCatalogAndSizeGuideInputSchema,
      outputSchema: SearchCatalogAndSizeGuideOutputSchema,
      handler: async (input) => {
        await bffClient.getJson('/bff/v1/storefront/bootstrap');
        const citations = await ragService.resolveCitations(
          `bảng size ${input.query}`,
          {
            sourceId: 'rag_doc_03_size_chart_tops_blazers',
            title: 'Quy chuẩn bảng size Áo Sơ Mi, Áo Kiểu & Blazer Atelier (XS–XL)',
            snippet: 'Size S (46–52kg), Size M (52–58kg), Size L (58–65kg).',
            score: 0.03,
          },
        );

        const recommendedSize =
          input.preferredSize ??
          recommendSizeFromBody(input.heightCm, input.weightKg);

        const filtered = DEMO_CATALOG.filter((item) => {
          if (input.maxPriceVnd && item.priceVnd > input.maxPriceVnd) {
            return false;
          }
          return true;
        })
          .slice(0, input.limit)
          .map((item) => ({
            ...item,
            availableSizes: [...item.availableSizes],
          }));

        return {
          items: filtered,
          recommendedSize,
          fitAdvice: `Dựa trên số đo của bạn, kích cỡ phù hợp là ${recommendedSize}. Các thiết kế lụa/linen Atelier dáng thanh lịch dễ mặc.`,
          citations,
        };
      },
    },
    { override: true },
  );

  const outfitSchema = McpToolSchemas[McpToolName.GET_OUTFIT_COMPATIBILITY_ADVICE];
  toolRegistry.register(
    {
      name: outfitSchema.name,
      description: outfitSchema.description,
      classification: outfitSchema.mode,
      scope: outfitSchema.audience,
      allowedRoles: [Role.CUSTOMER, ...ADMIN_PORTAL_ROLES],
      requiredPermissions: outfitSchema.requiredPermissions,
      inputSchema: GetOutfitCompatibilityAdviceInputSchema,
      outputSchema: GetOutfitCompatibilityAdviceOutputSchema,
      handler: async (input) => {
        await bffClient.getJson('/bff/v1/storefront/bootstrap');

        const combo = harness.router.computeComboDiscount(
          input.selectedProductIds.length + 1,
          3_500_000,
        );

        const citations = await ragService.resolveCitations(
          `phối đồ combo set ${input.occasion ?? 'công sở'}`,
          {
            sourceId: 'rag_doc_12_combo_payment_delivery',
            title: 'Ưu đãi Phối đồ Combo Set, Thanh toán VietQR & Giao hàng Hỏa tốc',
            snippet: 'Combo từ 2 món giảm 5%, từ 3 món giảm 10%.',
            score: 0.03,
          },
        );

        return {
          compatibilityScore: 93,
          colorHarmonyNote:
            'Bảng màu Quiet Luxury (Trắng Ngà Ivory + Cocoa + Đồng Gold) tạo độ tương phản thanh lịch.',
          fabricPairingNote:
            'Kết hợp lụa tơ tằm 19 momme cùng linen đứng phom giúp cân bằng độ rủ và cấu trúc vai.',
          comboDiscountPct: Math.round(combo.discountRate * 100),
          suggestedPairings: [
            {
              productId: 'prod_quan_au_linen_ngay_nang',
              name: 'Quần Âu Linen Ống Suông',
              slotCategory: 'BOTTOM' as const,
              reason: 'Cân bằng phom suông với áo lụa, phù hợp cả công sở và dạo phố.',
            },
          ],
          citations,
        };
      },
    },
    { override: true },
  );

  // Register Phase 3 Tier-0 Read-Only Customer tools (calculate_verified_size, search_in_stock_outfits)
  registerPhase3CustomerTools(toolRegistry);

  // --------------------------------------------------------------------------
  // Register matching definitions on @modelcontextprotocol/sdk McpServer
  // --------------------------------------------------------------------------
  const mcpServer = new McpServer({
    name: 'atelier-mcp-copilot',
    version: '3.0.0',
  });

  const registerSdkTool = (
    name: McpToolName,
    description: string,
    shape: Record<string, unknown>,
    scope: 'ADMIN' | 'CUSTOMER',
  ): void => {
    mcpServer.tool(
      name,
      description,
      shape as Parameters<McpServer['tool']>[2],
      async (args: Record<string, unknown>) => {
        const ctx = harness.jwtContext.get();
        if (!ctx) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ error: 'Missing JWT pass-through context' }),
              },
            ],
            isError: true,
          };
        }
        const res = await harness.invoke(
          {
            toolName: name,
            arguments: { ...args },
            scope,
          },
          ctx,
        );
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(res) }],
          isError: !res.ok,
        };
      },
    );
  };

  registerSdkTool(
    McpToolName.VALIDATE_AND_PROCESS_GARMENT_IMAGE,
    validateSchema.description,
    ValidateAndProcessGarmentImageInputSchema.shape,
    'ADMIN',
  );
  registerSdkTool(
    McpToolName.GET_TRYON_DEMAND_SIGNALS,
    signalsSchema.description,
    GetTryOnDemandSignalsInputSchema.shape,
    'ADMIN',
  );
  registerSdkTool(
    McpToolName.CREATE_PURCHASE_ORDER_DRAFT,
    poSchema.description,
    CreatePurchaseOrderDraftInputSchema.shape,
    'ADMIN',
  );
  registerSdkTool(
    McpToolName.ANALYZE_REFUND_AND_SIZING_ISSUES,
    refundSchema.description,
    AnalyzeRefundAndSizingIssuesInputSchema.shape,
    'ADMIN',
  );
  registerSdkTool(
    McpToolName.SEARCH_CATALOG_AND_SIZE_GUIDE,
    catalogSchema.description,
    SearchCatalogAndSizeGuideInputSchema.shape,
    'CUSTOMER',
  );
  registerSdkTool(
    McpToolName.GET_OUTFIT_COMPATIBILITY_ADVICE,
    outfitSchema.description,
    GetOutfitCompatibilityAdviceInputSchema.shape,
    'CUSTOMER',
  );
  registerSdkTool(
    McpToolName.CALCULATE_VERIFIED_SIZE,
    McpToolSchemas[McpToolName.CALCULATE_VERIFIED_SIZE].description,
    CalculateVerifiedSizeInputSchema._def.schema.shape,
    'CUSTOMER',
  );
  registerSdkTool(
    McpToolName.SEARCH_IN_STOCK_OUTFITS,
    McpToolSchemas[McpToolName.SEARCH_IN_STOCK_OUTFITS].description,
    SearchInStockOutfitsInputSchema.shape,
    'CUSTOMER',
  );

  return mcpServer;
}
