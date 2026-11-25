import { z } from 'zod';
import {
  ADMIN_PORTAL_ROLES,
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

export type Tier0CanonicalSize = 'XS' | 'S' | 'M' | 'L' | 'XL';
export type Tier0StretchLevel = 'NONE' | 'LOW' | 'LIGHT' | 'MEDIUM' | 'HIGH';
export type Tier0FitZoneName = 'shoulder' | 'chest' | 'waist' | 'hip';
export type Tier0FitZoneStatus = 'TIGHT' | 'SNUG' | 'IDEAL' | 'RELAXED';
export type Tier0FitZoneStatusVi =
  | 'CHẬT'
  | 'ÔM VỪA'
  | 'CHUẨN PHOM'
  | 'RỘNG THOẢI MÁI';

export interface Tier0AnatomicalFitZone {
  zone: Tier0FitZoneName;
  labelVi: 'Vai' | 'Ngực' | 'Eo' | 'Hông';
  status: Tier0FitZoneStatus;
  statusVi: Tier0FitZoneStatusVi;
  easeCm: number;
  bodyCm: number;
  garmentCm: number;
}

export type Tier0AllSizesFitZones = Record<
  Tier0CanonicalSize,
  Tier0AnatomicalFitZone[]
>;

export interface Tier0EstimatedMeasurements {
  bustCm: number;
  waistCm: number;
  hipCm: number;
  shoulderCm: number;
  interpolated: boolean;
}

export interface Tier0CalculateVerifiedSizeInput
  extends Omit<CalculateVerifiedSizeInput, 'fitPreference'> {
  slug?: string;
  fitPreference?:
    | FitPreference
    | 'SNUG'
    | 'TRUE_TO_SIZE'
    | 'RELAXED';
  stretchLevel?: Tier0StretchLevel;
}

export interface Tier0CalculateVerifiedSizeOutput
  extends CalculateVerifiedSizeOutput {
  fitZones: Tier0AnatomicalFitZone[];
  allSizesFitZones: Tier0AllSizesFitZones;
  estimatedMeasurements: Tier0EstimatedMeasurements;
  rationaleVi: string;
}

const Tier0FitZoneSchema = z.object({
  zone: z.enum(['shoulder', 'chest', 'waist', 'hip']),
  labelVi: z.enum(['Vai', 'Ngực', 'Eo', 'Hông']),
  status: z.enum(['TIGHT', 'SNUG', 'IDEAL', 'RELAXED']),
  statusVi: z.enum(['CHẬT', 'ÔM VỪA', 'CHUẨN PHOM', 'RỘNG THOẢI MÁI']),
  easeCm: z.number(),
  bodyCm: z.number(),
  garmentCm: z.number(),
});

export const Tier0CalculateVerifiedSizeInputSchema = z
  .object({
    productId: z.string().min(1).optional(),
    productSlug: z.string().min(1).optional(),
    slug: z.string().min(1).optional(),
    heightCm: z.number().min(120).max(230),
    weightKg: z.number().min(25).max(200),
    bustCm: z.number().min(50).max(180).nullable().optional(),
    waistCm: z.number().min(40).max(170).nullable().optional(),
    hipCm: z.number().min(50).max(190).nullable().optional(),
    shoulderCm: z.number().min(28).max(70).nullable().optional(),
    fitPreference: z
      .enum(['SLIM', 'REGULAR', 'RELAXED', 'SNUG', 'TRUE_TO_SIZE'])
      .default('REGULAR'),
    stretchLevel: z
      .enum(['NONE', 'LOW', 'LIGHT', 'MEDIUM', 'HIGH'])
      .optional(),
  })
  .refine((v) => Boolean(v.productId || v.productSlug || v.slug), {
    message: 'Either productId, productSlug, or slug is required',
  });

export const Tier0CalculateVerifiedSizeOutputSchema =
  CalculateVerifiedSizeOutputSchema.extend({
    fitZones: z.array(Tier0FitZoneSchema),
    allSizesFitZones: z.object({
      XS: z.array(Tier0FitZoneSchema),
      S: z.array(Tier0FitZoneSchema),
      M: z.array(Tier0FitZoneSchema),
      L: z.array(Tier0FitZoneSchema),
      XL: z.array(Tier0FitZoneSchema),
    }),
    estimatedMeasurements: z.object({
      bustCm: z.number(),
      waistCm: z.number(),
      hipCm: z.number(),
      shoulderCm: z.number(),
      interpolated: z.boolean(),
    }),
    rationaleVi: z.string(),
  });

export interface Tier0CatalogItemSnapshot {
  productId: string;
  slug: string;
  name: string;
  categorySlug: string;
  fabricComposition: string;
  stretchLevel: Tier0StretchLevel;
  fitType?: 'SLIM' | 'REGULAR' | 'RELAXED' | 'OVERSIZE';
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
  shoulderCm?: number;
}

const DEFAULT_TIER0_SIZE_CHART: readonly Tier0SizeChartRow[] = [
  { sizeCode: SizeCode.XS, heightMinCm: 150, heightMaxCm: 158, weightMinKg: 40, weightMaxKg: 46, bustCm: 80, waistCm: 62, hipCm: 86, shoulderCm: 36 },
  { sizeCode: SizeCode.S, heightMinCm: 155, heightMaxCm: 163, weightMinKg: 46, weightMaxKg: 52, bustCm: 84, waistCm: 66, hipCm: 90, shoulderCm: 37.5 },
  { sizeCode: SizeCode.M, heightMinCm: 160, heightMaxCm: 168, weightMinKg: 52, weightMaxKg: 58, bustCm: 88, waistCm: 70, hipCm: 94, shoulderCm: 39 },
  { sizeCode: SizeCode.L, heightMinCm: 163, heightMaxCm: 172, weightMinKg: 58, weightMaxKg: 65, bustCm: 93, waistCm: 75, hipCm: 99, shoulderCm: 40.5 },
  { sizeCode: SizeCode.XL, heightMinCm: 166, heightMaxCm: 176, weightMinKg: 65, weightMaxKg: 74, bustCm: 98, waistCm: 80, hipCm: 104, shoulderCm: 42 },
];

export const DEFAULT_TIER0_CATALOG_SNAPSHOT: readonly Tier0CatalogItemSnapshot[] = [
  {
    productId: 'prod_blazer_linen_01',
    slug: 'ao-blazer-linen-dang-suong',
    name: 'Áo Blazer Linen Dáng Suông',
    categorySlug: 'ao-blazer',
    fabricComposition: '100% Linen hữu cơ Bỉ 240gsm',
    stretchLevel: 'NONE',
    fitType: 'RELAXED',
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
    name: 'Áo Sơ Mi Lụa Tơ Tằm TryVibe',
    categorySlug: 'ao-so-mi',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 19 momme',
    stretchLevel: 'NONE',
    fitType: 'REGULAR',
    minPriceVnd: 1_850_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co', 'atelier-di-san'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/ao-so-mi-lua-to-tam-tam-xuan-lookbook.webp',
    fitStats: {
      productId: 'prod_ao_so_mi_lua_02',
      runsSmallPct: 20,
      trueToSizePct: 80,
      runsLargePct: 0,
      totalReviews: 5,
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
    fitType: 'SLIM',
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
    fitType: 'REGULAR',
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
  {
    productId: 'prod_cashmere_05',
    slug: 'ao-len-cashmere-co-lo',
    name: 'Áo Len Cashmere Cổ Lọ',
    categorySlug: 'ao-so-mi',
    fabricComposition: '100% Len Cashmere Mông Cổ 12GG',
    stretchLevel: 'HIGH',
    fitType: 'REGULAR',
    minPriceVnd: 2_690_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L, SizeCode.XL],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'cuoi-tuan-thu-thai'],
    seasonSlugs: ['dong-cashmere', 'thu-hoang-hon'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/ao-len-cashmere-co-lo-lookbook.webp',
    fitStats: {
      productId: 'prod_cashmere_05',
      runsSmallPct: 0,
      trueToSizePct: 80,
      runsLargePct: 20,
      totalReviews: 5,
      averageRating: 5.0,
      dominantFeedback: FitFeedback.TRUE_TO_SIZE,
    },
  },
  {
    productId: 'prod_ao_so_mi_bao_loc_06',
    slug: 'ao-so-mi-lua-to-tam-bao-loc',
    name: 'Áo Sơ Mi Lụa Tơ Tằm Bảo Lộc',
    categorySlug: 'ao-so-mi',
    fabricComposition: '100% Lụa tơ tằm Bảo Lộc 19 momme',
    stretchLevel: 'NONE',
    fitType: 'REGULAR',
    minPriceVnd: 1_950_000,
    inStockSizes: [SizeCode.XS, SizeCode.S, SizeCode.M, SizeCode.L, SizeCode.XL],
    isTryonEnabled: true,
    occasionSlugs: ['cong-so-hien-dai', 'le-cuoi-thanh-lich'],
    seasonSlugs: ['xuan-tam-xuan', 'ha-pho-co'],
    lookbookMainUrl:
      'http://127.0.0.1:9000/atelier-public/seed/ao-so-mi-lua-to-tam-bao-loc-lookbook.webp',
    fitStats: {
      productId: 'prod_ao_so_mi_bao_loc_06',
      runsSmallPct: 80,
      trueToSizePct: 20,
      runsLargePct: 0,
      totalReviews: 5,
      averageRating: 4.6,
      dominantFeedback: FitFeedback.RUNS_SMALL,
    },
  },
];

export interface Phase3CustomerToolsOptions {
  catalogSnapshot?: readonly Tier0CatalogItemSnapshot[];
  resolveCatalog?: () =>
    | Promise<readonly Tier0CatalogItemSnapshot[]>
    | readonly Tier0CatalogItemSnapshot[];
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

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function formatHeightVi(heightCm: number): string {
  const rounded = Math.round(heightCm);
  return `${Math.floor(rounded / 100)}m${String(rounded % 100).padStart(2, '0')}`;
}

function normalizeFitPreference(
  raw: Tier0CalculateVerifiedSizeInput['fitPreference'],
): FitPreference {
  if (raw === 'SNUG' || raw === FitPreference.SLIM) return FitPreference.SLIM;
  if (raw === FitPreference.RELAXED) return FitPreference.RELAXED;
  return FitPreference.REGULAR;
}

function interpolateBodyMeasurements(input: {
  heightCm: number;
  weightKg: number;
  bustCm?: number | null;
  waistCm?: number | null;
  hipCm?: number | null;
  shoulderCm?: number | null;
}): Tier0EstimatedMeasurements {
  const estBust = round1(
    clamp(51.0 + 0.67 * input.weightKg + 0.06 * (input.heightCm - 162), 70, 130),
  );
  const estWaist = round1(
    clamp(33.5 + 0.67 * input.weightKg - 0.05 * (input.heightCm - 162), 54, 118),
  );
  const estHip = round1(
    clamp(57.0 + 0.68 * input.weightKg + 0.04 * (input.heightCm - 162), 76, 138),
  );
  const estShoulder = round1(
    clamp(19.5 + 0.15 * input.weightKg + 0.068 * input.heightCm, 32, 52),
  );

  const hasBust = typeof input.bustCm === 'number' && Number.isFinite(input.bustCm);
  const hasWaist = typeof input.waistCm === 'number' && Number.isFinite(input.waistCm);
  const hasHip = typeof input.hipCm === 'number' && Number.isFinite(input.hipCm);
  const hasShoulder =
    typeof input.shoulderCm === 'number' && Number.isFinite(input.shoulderCm);

  return {
    bustCm: hasBust ? round1(input.bustCm!) : estBust,
    waistCm: hasWaist ? round1(input.waistCm!) : estWaist,
    hipCm: hasHip ? round1(input.hipCm!) : estHip,
    shoulderCm: hasShoulder ? round1(input.shoulderCm!) : estShoulder,
    interpolated: !(hasBust && hasWaist && hasHip && hasShoulder),
  };
}

function computeTier0FitZonesForRow(params: {
  row: Tier0SizeChartRow;
  body: Tier0EstimatedMeasurements;
  stretchLevel: Tier0StretchLevel;
  fitType: 'SLIM' | 'REGULAR' | 'RELAXED' | 'OVERSIZE';
  fitStats?: ProductFitStatsDto | null;
}): Tier0AnatomicalFitZone[] {
  const { row, body, stretchLevel, fitType, fitStats } = params;
  const hasCrowd = Boolean(fitStats && fitStats.totalReviews >= 3);
  const runsSmallFactor =
    hasCrowd && fitStats && fitStats.runsSmallPct >= 50
      ? clamp(fitStats.runsSmallPct / 65, 0.75, 1.35)
      : 0;
  const runsLargeFactor =
    hasCrowd && fitStats && fitStats.runsLargePct >= 55
      ? clamp(fitStats.runsLargePct / 65, 0.75, 1.35)
      : 0;

  const stretchBonus = (zone: Tier0FitZoneName): number => {
    const sh = zone === 'shoulder';
    if (stretchLevel === 'HIGH') return sh ? 0.8 : 2.5;
    if (stretchLevel === 'MEDIUM') return sh ? 0.5 : 1.5;
    if (stretchLevel === 'LIGHT' || stretchLevel === 'LOW') return sh ? 0.3 : 0.8;
    return 0;
  };

  const designEase = (zone: Tier0FitZoneName): number => {
    if (zone === 'shoulder') {
      if (fitType === 'SLIM') return 0.5;
      if (fitType === 'RELAXED') return 1.8;
      if (fitType === 'OVERSIZE') return 2.8;
      return 1.1;
    }
    if (zone === 'waist') {
      if (fitType === 'SLIM') return 1.8;
      if (fitType === 'RELAXED') return 5.8;
      if (fitType === 'OVERSIZE') return 8.2;
      return 3.6;
    }
    if (fitType === 'SLIM') return 2.2;
    if (fitType === 'RELAXED') return 6.2;
    if (fitType === 'OVERSIZE') return 8.6;
    return 4.2;
  };

  const defaultShoulderByCode: Record<string, number> = {
    XS: 36,
    S: 37.5,
    M: 39,
    L: 40.5,
    XL: 42,
  };

  const zones: Array<{
    zone: Tier0FitZoneName;
    labelVi: 'Vai' | 'Ngực' | 'Eo' | 'Hông';
    bodyCm: number;
    baseCm: number;
  }> = [
    {
      zone: 'shoulder',
      labelVi: 'Vai',
      bodyCm: body.shoulderCm,
      baseCm: row.shoulderCm ?? defaultShoulderByCode[row.sizeCode] ?? 39,
    },
    { zone: 'chest', labelVi: 'Ngực', bodyCm: body.bustCm, baseCm: row.bustCm },
    { zone: 'waist', labelVi: 'Eo', bodyCm: body.waistCm, baseCm: row.waistCm },
    { zone: 'hip', labelVi: 'Hông', bodyCm: body.hipCm, baseCm: row.hipCm },
  ];

  return zones.map((z) => {
    const crowdShift =
      runsSmallFactor > 0
        ? -(z.zone === 'shoulder' ? 1.2 : 2.6) * runsSmallFactor
        : runsLargeFactor > 0
          ? (z.zone === 'shoulder' ? 1.0 : 2.3) * runsLargeFactor
          : 0;
    const garmentCm = round1(z.baseCm + designEase(z.zone) + crowdShift);
    const easeCm = round1(garmentCm - z.bodyCm);
    const eff = easeCm + stretchBonus(z.zone);

    let status: Tier0FitZoneStatus = 'IDEAL';
    let statusVi: Tier0FitZoneStatusVi = 'CHUẨN PHOM';
    if (z.zone === 'shoulder') {
      if (eff < 0.0) {
        status = 'TIGHT';
        statusVi = 'CHẬT';
      } else if (eff < 0.9) {
        status = 'SNUG';
        statusVi = 'ÔM VỪA';
      } else if (eff > 2.4) {
        status = 'RELAXED';
        statusVi = 'RỘNG THOẢI MÁI';
      }
    } else if (eff < 0.5) {
      status = 'TIGHT';
      statusVi = 'CHẬT';
    } else if (eff < 2.8) {
      status = 'SNUG';
      statusVi = 'ÔM VỪA';
    } else if (eff > 6.8) {
      status = 'RELAXED';
      statusVi = 'RỘNG THOẢI MÁI';
    }

    return {
      zone: z.zone,
      labelVi: z.labelVi,
      status,
      statusVi,
      easeCm,
      bodyCm: z.bodyCm,
      garmentCm,
    };
  });
}

export function executeTier0VerifiedSize(
  input: Tier0CalculateVerifiedSizeInput,
  options: {
    productId?: string;
    productSlug?: string;
    fitStats?: ProductFitStatsDto | null;
    stretchLevel?: Tier0StretchLevel;
    fitType?: 'SLIM' | 'REGULAR' | 'RELAXED' | 'OVERSIZE';
    sizeChart?: readonly Tier0SizeChartRow[];
  } = {},
): Tier0CalculateVerifiedSizeOutput {
  const rows = options.sizeChart ?? DEFAULT_TIER0_SIZE_CHART;
  const stretchLevel: Tier0StretchLevel =
    input.stretchLevel ?? options.stretchLevel ?? 'NONE';
  const fitType = options.fitType ?? 'REGULAR';
  const normalizedFitPref = normalizeFitPreference(input.fitPreference);
  const productSlug =
    input.productSlug ??
    input.slug ??
    options.productSlug ??
    'ao-blazer-linen-dang-suong';
  const productId = input.productId ?? options.productId ?? productSlug;
  const fitStats = options.fitStats ?? null;

  const estimatedMeasurements = interpolateBodyMeasurements(input);

  const allSizesFitZones = {} as Tier0AllSizesFitZones;
  for (const row of rows) {
    const code = row.sizeCode as Tier0CanonicalSize;
    allSizesFitZones[code] = computeTier0FitZonesForRow({
      row,
      body: estimatedMeasurements,
      stretchLevel,
      fitType,
      fitStats,
    });
  }

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
    } else {
      penalty += (Math.abs(estimatedMeasurements.bustCm - row.bustCm) / 3.0) * 0.25;
    }
    if (input.waistCm !== undefined && input.waistCm !== null) {
      penalty += Math.abs(input.waistCm - row.waistCm) / 2.6;
    } else {
      penalty += (Math.abs(estimatedMeasurements.waistCm - row.waistCm) / 2.6) * 0.25;
    }
    if (input.hipCm !== undefined && input.hipCm !== null) {
      penalty += Math.abs(input.hipCm - row.hipCm) / 3.0;
    } else {
      penalty += (Math.abs(estimatedMeasurements.hipCm - row.hipCm) / 3.0) * 0.2;
    }

    if (penalty < bestPenalty) {
      bestPenalty = penalty;
      bestIndex = idx;
    }
  });

  const baseRow = rows[bestIndex];
  const bodySummaryVi = `${formatHeightVi(input.heightCm)} · ${Math.round(input.weightKg)}kg`;
  const fitNotes: string[] = [
    `Tính toán định lượng Tier-0 (0 token) theo vóc dáng ${bodySummaryVi} (độ co giãn vải ${stretchLevel}).`,
  ];

  let chosenIndex = bestIndex;
  let crowdAdjusted = false;
  let crowdAdjustmentReason: string | null = null;
  let rationaleVi = '';

  const weightSpan = Math.max(1, baseRow.weightMaxKg - baseRow.weightMinKg);
  const weightPosition = (input.weightKg - baseRow.weightMinKg) / weightSpan;
  const baseZones = allSizesFitZones[baseRow.sizeCode as Tier0CanonicalSize] ?? [];
  const tightZones = baseZones.filter((z) => z.status === 'TIGHT');
  const inUpperHalfOrBoundary =
    weightPosition >= 0.45 ||
    tightZones.length > 0 ||
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
    (normalizedFitPref !== FitPreference.SLIM || inUpperHalfOrBoundary) &&
    chosenIndex + 1 < rows.length
  ) {
    chosenIndex += 1;
    const bumpedSize = rows[chosenIndex].sizeCode;
    crowdAdjusted = true;
    crowdAdjustmentReason = `${fitStats.runsSmallPct}% khách có vóc dáng ${bodySummaryVi} đánh giá mẫu này hơi ôm vai và thân trên, xưởng khuyên chọn Size ${bumpedSize} để cử động thoải mái.`;
    rationaleVi = crowdAdjustmentReason;
    fitNotes.unshift(crowdAdjustmentReason);
  } else if (
    fitStats &&
    fitStats.totalReviews >= 3 &&
    fitStats.runsLargePct >= 55 &&
    normalizedFitPref !== FitPreference.RELAXED &&
    chosenIndex - 1 >= 0
  ) {
    chosenIndex -= 1;
    const downSize = rows[chosenIndex].sizeCode;
    crowdAdjusted = true;
    crowdAdjustmentReason = `${fitStats.runsLargePct}% khách có vóc dáng ${bodySummaryVi} đánh giá mẫu này hơi rộng, xưởng khuyên chọn Size ${downSize} để ôm dáng gọn gàng hơn.`;
    rationaleVi = crowdAdjustmentReason;
    fitNotes.unshift(crowdAdjustmentReason);
  } else if (
    stretchLevel === 'NONE' &&
    tightZones.length > 0 &&
    normalizedFitPref !== FitPreference.SLIM &&
    chosenIndex + 1 < rows.length
  ) {
    chosenIndex += 1;
    const bumpedSize = rows[chosenIndex].sizeCode;
    rationaleVi = `Chất liệu không co giãn và vùng ${tightZones.map((z) => z.labelVi.toLowerCase()).join(', ')} hơi sát phom, xưởng khuyên chọn Size ${bumpedSize} để cử động thoải mái.`;
    fitNotes.unshift(rationaleVi);
  } else if (
    normalizedFitPref === FitPreference.RELAXED &&
    stretchLevel === 'NONE' &&
    inUpperHalfOrBoundary &&
    chosenIndex + 1 < rows.length
  ) {
    chosenIndex += 1;
    rationaleVi = `Đã điều chỉnh lên Size ${rows[chosenIndex].sizeCode} theo gu mặc thoải mái với chất liệu không co giãn.`;
    fitNotes.push(rationaleVi);
  }

  const chosen = rows[chosenIndex];
  if (!rationaleVi) {
    rationaleVi = `Size ${chosen.sizeCode} phù hợp chuẩn phom với vóc dáng ${bodySummaryVi} (độ co giãn ${stretchLevel}).`;
  }

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

  const chosenFitZones =
    allSizesFitZones[chosen.sizeCode as Tier0CanonicalSize] ??
    allSizesFitZones.M;

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
    fitZones: chosenFitZones,
    allSizesFitZones,
    estimatedMeasurements,
    rationaleVi,
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
      title: 'Tồn kho thực tế theo size tại TryVibe Atelier (Tier-0)',
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
  const fallbackCatalog = options.catalogSnapshot ?? DEFAULT_TIER0_CATALOG_SNAPSHOT;
  const resolveEffectiveCatalog = async (): Promise<
    readonly Tier0CatalogItemSnapshot[]
  > => {
    if (options.resolveCatalog) {
      try {
        const live = await options.resolveCatalog();
        if (Array.isArray(live) && live.length > 0) {
          return live;
        }
      } catch {
        // Fall back safely to snapshot when live catalog resolver is unreachable
      }
    }
    return fallbackCatalog;
  };
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
      inputSchema: Tier0CalculateVerifiedSizeInputSchema,
      outputSchema: Tier0CalculateVerifiedSizeOutputSchema,
      handler: async (input) => {
        const catalog = await resolveEffectiveCatalog();
        const lookupKey = input.productSlug ?? input.slug ?? input.productId ?? '';
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
          productSlug: catalogMatch?.slug ?? input.productSlug ?? input.slug ?? lookupKey,
          stretchLevel: input.stretchLevel ?? catalogMatch?.stretchLevel ?? 'NONE',
          fitType: catalogMatch?.fitType ?? 'REGULAR',
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
      handler: async (input) => {
        const catalog = await resolveEffectiveCatalog();
        return executeTier0SearchInStockOutfits(input, catalog);
      },
    },
    { override: true },
  );

  return registry;
}
