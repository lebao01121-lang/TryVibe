import {
  ADMIN_PORTAL_ROLES,
  CalculateVerifiedSizeInputSchema,
  CalculateVerifiedSizeOutputSchema,
  FitFeedback,
  FitPreference,
  McpToolName,
  McpToolSchemas,
  Role,
  SearchInStockOutfitsInputSchema,
  SearchInStockOutfitsOutputSchema,
  SizeCode,
  type CalculateVerifiedSizeInput,
  type CalculateVerifiedSizeOutput,
  type GroundedCitation,
  type ProductFitStatsDto,
  type SearchInStockOutfitsInput,
  type SearchInStockOutfitsOutput,
} from '@atelier/contracts';
import type { McpToolRegistry } from './tool-registry';

export interface Tier0CatalogItemSnapshot {
  productId: string;
  slug: string;
  name: string;
  categorySlug: string;
  fabricComposition: string;
  stretchLevel: 'NONE' | 'LIGHT' | 'HIGH';
  minPriceVnd: number;
  inStockSizes: readonly SizeCode[];
  isTryonEnabled: boolean;
  occasionSlugs: readonly string[];
  seasonSlugs: readonly string[];
  lookbookMainUrl: string | null;
  fitStats?: ProductFitStatsDto | null;
}

export interface Tier0SizeChartRow {
  sizeCode: SizeCode;
  heightMinCm: number;
  heightMaxCm: number;
  weightMinKg: number;
  weightMaxKg: number;
  bustCm: number;
  waistCm: number;
  hipCm: number;
}

const DEFAULT_TIER0_SIZE_CHART: readonly Tier0SizeChartRow[] = [
  { sizeCode: SizeCode.XS, heightMinCm: 150, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 46, bustCm: 80, waistCm: 62, hipCm: 86 },
  { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 163, weightMinKg: 46, weightMaxKg: 52, bustCm: 84, waistCm: 66, hipCm: 90 },
  { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 168, weightMinKg: 52, weightMaxKg: 58, bustCm: 88, waistCm: 70, hipCm: 94 },
  { sizeCode: SizeCode.L, heightMinCm: 163, heightMaxCm: 172, weightMinKg: 58, weightMaxKg: 65, bustCm: 93, waistCm: 75, hipCm: 99 },
  { sizeCode: SizeCode.XL, heightMinCm: 166, heightMaxCm: 176, weightMinKg: 65, weightMaxKg: 74, bustCm: 98, waistCm: 80, hipCm: 104 },
];

export const DEFAULT_TIER0_CATALOG_SNAPSHOT: readonly Tier0CatalogItemSnapshot[] = [
  {
    productId: 'prod_blazer_linen_01',
    slug: 'ao-blazer-linen-dang-suong',
    name: 'Áo Blazer Linen Dáng Suông',
    categorySlug: 'ao-blazer',
    fabricComposition: '100% Linen hữu cơ Bỉ 240gsm',
    stretchLevel: 'NONE',
    minPriceVnd: 2_890_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L, SizeCode.XL],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['xuan-tam-xuan', 'thu-hoang-hon'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/ao-blazer-linen-dang-suong-lookbook.webp',
    fitStats: {
      productId: 'prod_blazer_linen_01',
      runsSmallPct: 67,
      trueToSizePct: 33,
      runsLargePct: 0,
      totalReviews: 6,
      averageRating: 4.8,
      dominantFeedback: FitFeedback.RUNS_SMALL,
    },
  },
  {
    productId: 'prod_ao_so_mi_lua_02',
    slug: 'ao-so-mi-lua-to-tam-tam-xuan',
    name: 'Áo Sơ Mi Lụa Tơ Tằm Tầm Xuân',
    categorySlug: 'ao-so-mi',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 19 momme',
    stretchLevel: 'NONE',
    minPriceVnd: 1_850_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co', 'atelier-di-san'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/ao-so-mi-lua-to-tam-tam-xuan-lookbook.webp',
    fitStats: {
      productId: 'prod_ao_so_mi_lua_02',
      runsSmallPct: 17,
      trueToSizePct: 83,
      runsLargePct: 0,
      totalReviews: 6,
      averageRating: 4.9,
      dominantFeedback: FitFeedback.TRUE_TO_SIZE,
    },
  },
  {
    productId: 'prod_dam_du_tiec_03',
    slug: 'dam-du-tiec-lua-satin-co-do',
    name: 'Đầm Dự Tiệc Lụa Satin Cổ Đổ',
    categorySlug: 'dam-du-tiec',
    fabricComposition: '100% Lụa Satin tơ tằm 22 momme',
    stretchLevel: 'NONE',
    minPriceVnd: 3_490_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L],
    isTryonEnabled: true,
    occasionSlugs: ['du-tiec-toi', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['thu-hoang-hon', 'atelier-di-san'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/dam-du-tiec-lua-satin-co-do-lookbook.webp',
    fitStats: {
      productId: 'prod_dam_du_tiec_03',
      runsSmallPct: 67,
      trueToSizePct: 33,
      runsLargePct: 0,
      totalReviews: 6,
      averageRating: 4.8,
      dominantFeedback: FitFeedback.RUNS_SMALL,
    },
  },
  {
    productId: 'prod_quan_tay_04',
    slug: 'quan-tay-ong-suong-xep-ly-doi',
    name: 'Quần Tây Ống Suông Xếp Ly Đôi',
    categorySlug: 'quan-chan-vay',
    fabricComposition: '68% Wool pha mịn · 30% Viscose · 2% Elastane',
    stretchLevel: 'LIGHT',
    minPriceVnd: 1_890_000,
    inStockSizes: [SizeCode.S, SizeCode.M, SizeCode.L, SizeCode.XL],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'trien-lam-nghe-thuat'],
    seasonSlugs: ['thu-hoang-hon', 'dong-cashmere'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/quan-tay-ong-suong-xep-ly-doi-lookbook.webp',
    fitStats: {
      productId: 'prod_quan_tay_04',
      runsSmallPct: 0,
      trueToSizePct: 80,
      runsLargePct: 20,
      totalReviews: 5,
      averageRating: 4.7,
      dominantFeedback: FitFeedback.TRUE_TO_SIZE,
    },
  },
];

export interface Phase3CustomerToolsOptions {
  catalogSnapshot?: readonly Tier0CatalogItemSnapshot[];
  resolveFitStats?: (
    productIdOrSlug: string,
  ) => Promise<ProductFitStatsDto | null> | ProductFitStatsDto | null;
}

function foldVietnameseText(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function executeTier0VerifiedSize(
  input: CalculateVerifiedSizeInput,
  options: {
    productId?: string;
    productSlug?: string;
    fitStats?: ProductFitStatsDto | null;
    stretchLevel?: 'NONE' | 'LIGHT' | 'HIGH';
    sizeChart?: readonly Tier0SizeChartRow[];
  } = {},
): CalculateVerifiedSizeOutput {
  const rows = options.sizeChart ?? DEFAULT_TIER0_SIZE_CHART;
  const stretchLevel = options.stretchLevel ?? 'NONE';
  const productSlug = input.productSlug ?? options.productSlug ?? 'ao-blazer-linen-dang-suong';
  const productId = input.productId ?? options.productId ?? productSlug;

  let bestIndex = 0;
  let bestPenalty = Number.POSITIVE_INFINITY;

  rows.forEach((row, idx) => {
    const hMid = (row.heightMinCm + row.heightMaxCm) / 2;
    const wMid = (row.weightMinKg + row.weightMaxKg) / 2;
    let penalty =
      (Math.abs(input.heightCm - hMid) / 4.5) * 0.9 +
      (Math.abs(input.weightKg - wMid) / 3.5) * 1.4;

    if (input.weightKg > row.weightMaxKg) {
      penalty += (input.weightKg - row.weightMaxKg) * 0.65;
    }
    if (input.bustCm !== undefined && input.bustCm !== null) {
      penalty += Math.abs(input.bustCm - row.bustCm) / 3.0;
    }
    if (input.waistCm !== undefined && input.waistCm !== null) {
      penalty += Math.abs(input.waistCm - row.waistCm) / 2.6;
    }
    if (input.hipCm !== undefined && input.hipCm !== null) {
      penalty += Math.abs(input.hipCm - row.hipCm) / 3.0;
    }

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestIndex = idx;
    }
  });

  const baseRow = rows[bestIndex];
  const fitNotes: string[] = [
    `Tính toán định lượng Tier-0 (0 token) theo vóc dáng ${input.heightCm}cm · ${input.weightKg}kg (độ co giãn vải ${stretchLevel}).`,
  ];

  let chosenIndex = bestIndex;
  let crowdAdjusted = false;
  let crowdAdjustmentReason: string | null = null;
  const fitStats = options.fitStats ?? null;

  const weightSpan = Math.max(1, baseRow.weightMaxKg - baseRow.weightMinKg);
  const weightPosition = (input.weightKg - baseRow.weightMinKg) / weightSpan;
  const inUpperHalfOrBoundary =
    weightPosition >= 0.45 ||
    (input.waistCm !== undefined &&
      input.waistCm !== null &&
      input.waistCm >= baseRow.waistCm) ||
    (input.bustCm !== undefined &&
      input.bustCm !== null &&
      input.bustCm >= baseRow.bustCm);

  if (
    fitStats &&
    fitStats.totalReviews >= 3 &&
    fitStats.runsSmallPct >= 50 &&
    (input.fitPreference !== FitPreference.SLIM || inUpperHalfOrBoundary) &&
    chosenIndex + 1 < rows.length
  ) {
    chosenIndex += 1;
    const bumpedSize = rows[chosenIndex].sizeCode;
    crowdAdjusted = true;
    crowdAdjustmentReason = `${fitStats.runsSmallPct}% người mua mẫu này đánh giá form hơi ôm, hệ thống gợi ý nhích lên Size ${bumpedSize} để thoải mái vai và cử động.`;
    fitNotes.unshift(crowdAdjustmentReason);
  } else if (
    fitStats &&
    fitStats.totalReviews >= 3 &&
    fitStats.runsLargePct >= 55 &&
    input.fitPreference !== FitPreference.RELAXED &&
    chosenIndex - 1 >= 0
  ) {
    chosenIndex -= 1;
    const downSize = rows[chosenIndex].sizeCode;
    crowdAdjusted = true;
    crowdAdjustmentReason = `${fitStats.runsLargePct}% người mua mẫu này đánh giá form hơi rộng, hệ thống gợi ý lùi xuống Size ${downSize} để ôm dáng gọn gàng hơn.`;
    fitNotes.unshift(crowdAdjustmentReason);
  } else if (
    input.fitPreference === FitPreference.RELAXED &&
    stretchLevel === 'NONE' &&
    inUpperHalfOrBoundary &&
    chosenIndex + 1 < rows.length
  ) {
    chosenIndex += 1;
    fitNotes.push(
      `Đã điều chỉnh lên Size ${rows[chosenIndex].sizeCode} theo gu mặc RELAXED với chất liệu không co giãn.`,
    );
  }

  const chosen = rows[chosenIndex];
  const confidence = Number(
    Math.max(0.55, Math.min(0.95, 0.88 - Math.min(0.25, bestPenalty * 0.06))).toFixed(2),
  );

  const alternatives: Array<{ sizeCode: SizeCode; reason: string }> = [];
  if (chosenIndex + 1 < rows.length) {
    alternatives.push({
      sizeCode: rows[chosenIndex + 1].sizeCode,
      reason: `Chọn Size ${rows[chosenIndex + 1].sizeCode} nếu thích phom rộng rãi hơn.`,
    });
  }
  if (chosenIndex - 1 >= 0) {
    alternatives.push({
      sizeCode: rows[chosenIndex - 1].sizeCode,
      reason: `Chọn Size ${rows[chosenIndex - 1].sizeCode} nếu thích phom ôm sát hơn.`,
    });
  }

  const citations: GroundedCitation[] = [
    {
      sourceId: 'kb_size_chart_tops_blazers',
      title: 'Bảng thông số size chuẩn Atelier & hiệu chỉnh theo đánh giá thực tế',
      snippet: `Cỡ ${chosen.sizeCode}: chiều cao ${chosen.heightMinCm}-${chosen.heightMaxCm}cm, cân nặng ${chosen.weightMinKg}-${chosen.weightMaxKg}kg.`,
      score: 1,
    },
  ];

  return {
    productId,
    productSlug,
    recommendedSize: chosen.sizeCode,
    confidence,
    crowdAdjusted,
    crowdAdjustmentReason,
    fitNotes,
    fitStats,
    alternatives,
    citations,
  };
}

export function executeTier0SearchInStockOutfits(
  input: SearchInStockOutfitsInput,
  catalog: readonly Tier0CatalogItemSnapshot[] = DEFAULT_TIER0_CATALOG_SNAPSHOT,
): SearchInStockOutfitsOutput {
  const foldedQ = input.query ? foldVietnameseText(input.query) : '';

  const matched = catalog.filter((item) => {
    if (input.occasion && !item.occasionSlugs.includes(input.occasion)) {
      return false;
    }
    if (input.season && !item.seasonSlugs.includes(input.season)) {
      return false;
    }
    if (input.size && !item.inStockSizes.includes(input.size)) {
      return false;
    }
    if (
      input.maxBudgetVnd !== undefined &&
      item.minPriceVnd > input.maxBudgetVnd
    ) {
      return false;
    }
    if (input.tryOnOnly && !item.isTryonEnabled) {
      return false;
    }
    if (foldedQ) {
      const haystack = foldVietnameseText(
        `${item.name} ${item.categorySlug} ${item.fabricComposition} ${item.occasionSlugs.join(' ')}`,
      );
      const tokens = foldedQ.split(' ').filter(Boolean);
      if (!tokens.every((t) => haystack.includes(t))) {
        return false;
      }
    }
    return true;
  });

  const limited = matched.slice(0, input.limit);

  const citations: GroundedCitation[] = [
    {
      sourceId: 'catalog_in_stock_index_tier0',
      title: 'Tồn kho thực tế theo size tại Tầm Xuân Atelier (Tier-0)',
      snippet: `Tìm thấy ${matched.length} thiết kế đang còn hàng khớp bộ lọc khách hàng.`,
      score: 1,
    },
  ];

  return {
    items: limited.map((item) => ({
      productId: item.productId,
      slug: item.slug,
      name: item.name,
      categorySlug: item.categorySlug,
      minPriceVnd: item.minPriceVnd,
      inStockSizes: [...item.inStockSizes],
      isTryonEnabled: item.isTryonEnabled,
      lookbookMainUrl: item.lookbookMainUrl,
    })),
    totalMatched: matched.length,
    appliedFilters: {
      ...(input.query ? { query: input.query } : {}),
      ...(input.occasion ? { occasion: input.occasion } : {}),
      ...(input.season ? { season: input.season } : {}),
      ...(input.size ? { size: input.size } : {}),
      ...(input.maxBudgetVnd !== undefined ? { maxBudgetVnd: input.maxBudgetVnd } : {}),
      tryOnOnly: input.tryOnOnly,
    },
    citations,
  };
}

export function registerPhase3CustomerTools(
  registry: McpToolRegistry,
  options: Phase3CustomerToolsOptions = {},
): McpToolRegistry {
  const catalog = options.catalogSnapshot ?? DEFAULT_TIER0_CATALOG_SNAPSHOT;
  const calcSchema = McpToolSchemas[McpToolName.CALCULATE_VERIFIED_SIZE];
  const outfitSearchSchema = McpToolSchemas[McpToolName.SEARCH_IN_STOCK_OUTFITS];

  registry.register(
    {
      name: calcSchema.name,
      description: calcSchema.description,
      classification: calcSchema.mode,
      scope: calcSchema.audience,
      allowedRoles: [Role.CUSTOMER, ...ADMIN_PORTAL_ROLES],
      requiredPermissions: calcSchema.requiredPermissions,
      inputSchema: CalculateVerifiedSizeInputSchema,
      outputSchema: CalculateVerifiedSizeOutputSchema,
      handler: async (input) => {
        const lookupKey = input.productSlug ?? input.productId ?? '';
        const catalogMatch = catalog.find(
          (item) => item.slug === lookupKey || item.productId === lookupKey,
        );
        const liveStats = options.resolveFitStats
          ? await options.resolveFitStats(lookupKey)
          : undefined;
        const effectiveStats =
          liveStats !== undefined ? liveStats : (catalogMatch?.fitStats ?? null);

        return executeTier0VerifiedSize(input, {
          productId: catalogMatch?.productId ?? input.productId ?? lookupKey,
          productSlug: catalogMatch?.slug ?? input.productSlug ?? lookupKey,
          stretchLevel: catalogMatch?.stretchLevel ?? 'NONE',
          fitStats: effectiveStats,
        });
      },
    },
    { override: true },
  );

  registry.register(
    {
      name: outfitSearchSchema.name,
      description: outfitSearchSchema.description,
      classification: outfitSearchSchema.mode,
      scope: outfitSearchSchema.audience,
      allowedRoles: [Role.CUSTOMER, ...ADMIN_PORTAL_ROLES],
      requiredPermissions: outfitSearchSchema.requiredPermissions,
      inputSchema: SearchInStockOutfitsInputSchema,
      outputSchema: SearchInStockOutfitsOutputSchema,
      handler: async (input) => executeTier0SearchInStockOutfits(input, catalog),
    },
    { override: true },
  );

  return registry;
}
