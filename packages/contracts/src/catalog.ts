import { z } from 'zod';
import { FitPreference, FitPreferenceSchema } from './auth';
import { ProductFitStatsDtoSchema, VerifiedReviewDtoSchema } from './reviews';

export const FitType = {
  SLIM: 'SLIM',
  REGULAR: 'REGULAR',
  RELAXED: 'RELAXED',
  OVERSIZE: 'OVERSIZE',
} as const;
export type FitType = (typeof FitType)[keyof typeof FitType];
export const FitTypeSchema = z.enum([
  FitType.SLIM,
  FitType.REGULAR,
  FitType.RELAXED,
  FitType.OVERSIZE,
]);

export const StretchLevel = {
  NONE: 'NONE',
  LIGHT: 'LIGHT',
  HIGH: 'HIGH',
} as const;
export type StretchLevel = (typeof StretchLevel)[keyof typeof StretchLevel];
export const StretchLevelSchema = z.enum([
  StretchLevel.NONE,
  StretchLevel.LIGHT,
  StretchLevel.HIGH,
]);

export const Gender = {
  MEN: 'MEN',
  WOMEN: 'WOMEN',
  UNISEX: 'UNISEX',
} as const;
export type Gender = (typeof Gender)[keyof typeof Gender];
export const GenderSchema = z.enum([Gender.MEN, Gender.WOMEN, Gender.UNISEX]);

export const TryOnGarmentCategory = {
  UPPER: 'UPPER',
  LOWER: 'LOWER',
  OVERALL: 'OVERALL',
  NONE: 'NONE',
} as const;
export type TryOnGarmentCategory =
  (typeof TryOnGarmentCategory)[keyof typeof TryOnGarmentCategory];
export const TryOnGarmentCategorySchema = z.enum([
  TryOnGarmentCategory.UPPER,
  TryOnGarmentCategory.LOWER,
  TryOnGarmentCategory.OVERALL,
  TryOnGarmentCategory.NONE,
]);

export const StockStatusSummary = {
  IN_STOCK: 'IN_STOCK',
  LOW_STOCK: 'LOW_STOCK',
  OUT_OF_STOCK: 'OUT_OF_STOCK',
} as const;
export type StockStatusSummary = (typeof StockStatusSummary)[keyof typeof StockStatusSummary];
export const StockStatusSummarySchema = z.enum([
  StockStatusSummary.IN_STOCK,
  StockStatusSummary.LOW_STOCK,
  StockStatusSummary.OUT_OF_STOCK,
]);

export const ProductStatus = {
  DRAFT: 'DRAFT',
  PUBLISHED: 'PUBLISHED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type ProductStatus = (typeof ProductStatus)[keyof typeof ProductStatus];
export const ProductStatusSchema = z.enum([
  ProductStatus.DRAFT,
  ProductStatus.PUBLISHED,
  ProductStatus.ARCHIVED,
]);

export const SizeCode = {
  XS: 'XS',
  S: 'S',
  M: 'M',
  L: 'L',
  XL: 'XL',
  XXL: 'XXL',
  FREESIZE: 'FREESIZE',
} as const;
export type SizeCode = (typeof SizeCode)[keyof typeof SizeCode];
export const SizeCodeSchema = z.enum([
  SizeCode.XS,
  SizeCode.S,
  SizeCode.M,
  SizeCode.L,
  SizeCode.XL,
  SizeCode.XXL,
  SizeCode.FREESIZE,
]);

export const SubmissionStatus = {
  PENDING_REVIEW: 'PENDING_REVIEW',
  APPROVED: 'APPROVED',
  REJECTED: 'REJECTED',
} as const;
export type SubmissionStatus = (typeof SubmissionStatus)[keyof typeof SubmissionStatus];
export const SubmissionStatusSchema = z.enum([
  SubmissionStatus.PENDING_REVIEW,
  SubmissionStatus.APPROVED,
  SubmissionStatus.REJECTED,
]);

export const CategoryDtoSchema = z.object({
  id: z.string().min(1),
  parentId: z.string().nullable(),
  slug: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable().optional(),
  sortOrder: z.number().int(),
  isActive: z.boolean(),
});
export type CategoryDto = z.infer<typeof CategoryDtoSchema>;

export const SizeMeasurementRowSchema = z.object({
  sizeCode: SizeCodeSchema,
  heightMinCm: z.number().min(120).max(230),
  heightMaxCm: z.number().min(120).max(230),
  weightMinKg: z.number().min(25).max(200),
  weightMaxKg: z.number().min(25).max(200),
  bustCm: z.number().nullable().optional(),
  waistCm: z.number().nullable().optional(),
  hipCm: z.number().nullable().optional(),
  shoulderCm: z.number().nullable().optional(),
  lengthCm: z.number().nullable().optional(),
});
export type SizeMeasurementRow = z.infer<typeof SizeMeasurementRowSchema>;

export const SizeChartDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  gender: GenderSchema,
  garmentCategory: z.string().min(1),
  fitNote: z.string().nullable().optional(),
  rows: z.array(SizeMeasurementRowSchema),
});
export type SizeChartDto = z.infer<typeof SizeChartDtoSchema>;

export const SkuDtoSchema = z.object({
  id: z.string().min(1),
  variantId: z.string().min(1),
  skuCode: z.string().min(1),
  sizeCode: SizeCodeSchema,
  basePriceVnd: z.number().int().nonnegative(),
  salePriceVnd: z.number().int().nonnegative(),
  /**
   * Sensitive procurement cost field. MUST be stripped by Storefront BFF
   * and Layer 5 `redactRestrictedFields` when caller lacks cost_price permission.
   */
  costPriceVnd: z.number().int().nonnegative().optional(),
  supplierId: z.string().nullable().optional(),
  weightGrams: z.number().int().nonnegative(),
  inStock: z.boolean(),
  isReturnable: z.boolean(),
});
export type SkuDto = z.infer<typeof SkuDtoSchema>;

export const ProductVariantDtoSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  colorName: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  lookbookMainUrl: z.string().nullable(),
  rackFrontAssetId: z.string().nullable(),
  rackBackAssetId: z.string().nullable(),
  studioLayerAssetId: z.string().nullable(),
  tryonFlatPreviewUrl: z.string().nullable(),
  rackFrontUrl: z.string().nullable().optional(),
  rackBackUrl: z.string().nullable().optional(),
  studioLayerUrl: z.string().nullable().optional(),
  layerSpecJsonb: z.record(z.unknown()).nullable(),
  skus: z.array(SkuDtoSchema),
});
export type ProductVariantDto = z.infer<typeof ProductVariantDtoSchema>;

export const ProductSpuDtoSchema = z.object({
  id: z.string().min(1),
  categoryId: z.string().min(1),
  categorySlug: z.string().min(1),
  categoryName: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  subtitle: z.string().nullable().optional(),
  brandName: z.string().min(1),
  description: z.string(),
  fabricComposition: z.string(),
  fitType: FitTypeSchema,
  stretchLevel: StretchLevelSchema,
  fabricWeight: z.string(),
  gender: GenderSchema,
  isTryonEnabled: z.boolean(),
  tryonGarmentCategory: TryOnGarmentCategorySchema,
  tryonFlatAssetUrl: z.string().nullable(),
  fitCalibrationNote: z.string().nullable(),
  minPriceVnd: z.number().int().nonnegative(),
  stockStatusSummary: StockStatusSummarySchema,
  status: ProductStatusSchema,
  sizeChartId: z.string().nullable(),
  sizeChart: SizeChartDtoSchema.nullable().optional(),
  occasionSlugs: z.array(z.string()),
  seasonSlugs: z.array(z.string()),
  variants: z.array(ProductVariantDtoSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type ProductSpuDto = z.infer<typeof ProductSpuDtoSchema>;

export const OccasionLookbookItemDtoSchema = z.object({
  productId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  minPriceVnd: z.number().int().nonnegative(),
  lookbookMainUrl: z.string().nullable(),
  heroCutoutUrl: z.string().nullable().optional(),
  tryonFlatPreviewUrl: z.string().nullable(),
  macroImageUrl: z.string().nullable().optional(),
  isTryonEnabled: z.boolean(),
  slotLabel: z.string().min(1),
});
export type OccasionLookbookItemDto = z.infer<typeof OccasionLookbookItemDtoSchema>;

export const OccasionLookbookDtoSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  key: z.string().min(1),
  name: z.string().min(1),
  tagline: z.string(),
  description: z.string().nullable().optional(),
  themeBg: z.string().min(1),
  themeInk: z.string().min(1),
  themeAccent: z.string().min(1),
  isDark: z.boolean(),
  badgeTag: z.string().nullable().optional(),
  heroCutoutUrl: z.string().nullable().optional(),
  macroImageUrl: z.string().nullable().optional(),
  sortOrder: z.number().int(),
  productSlugs: z.array(z.string()),
  featuredProducts: z.array(ProductSpuDtoSchema).optional(),
  items: z.array(OccasionLookbookItemDtoSchema).optional(),
});
export type OccasionLookbookDto = z.infer<typeof OccasionLookbookDtoSchema>;

export const SeasonWearableSlotKeySchema = z.enum([
  'TOP',
  'BOTTOM',
  'ONE_PIECE',
  'OUTERWEAR',
  'ACCESSORY',
]);
export type SeasonWearableSlotKey = z.infer<typeof SeasonWearableSlotKeySchema>;

export const SeasonOutfitFormulaSchema = z.enum([
  'TOP_BOTTOM_ACCESSORY',
  'ONE_PIECE_OUTERWEAR_ACCESSORY',
]);
export type SeasonOutfitFormula = z.infer<typeof SeasonOutfitFormulaSchema>;

export const MaterialOpticalProfileSchema = z.object({
  sheen: z.enum(['silk', 'linen', 'tweed', 'leather']),
  specularIntensity: z.number(),
  shadowDepth: z.number(),
});
export type MaterialOpticalProfile = z.infer<typeof MaterialOpticalProfileSchema>;

export const SeasonWearableVariantSchema = z.object({
  variantId: z.string().min(1),
  skuDefaultId: z.string().min(1),
  sizeSkuMap: z.record(z.string()).optional(),
  colorKey: z.string().min(1),
  colorName: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  inStockSizes: z.array(z.string()),
  studioCutoutUrl: z.string().min(1),
  macroSwatchUrl: z.string().min(1),
  fabricSpecText: z.string().min(1),
  prebakedSceneUrl: z.string().nullable().optional(),
});
export type SeasonWearableVariant = z.infer<typeof SeasonWearableVariantSchema>;

export const SeasonWearableSlotSchema = z.object({
  slotKey: SeasonWearableSlotKeySchema,
  productId: z.string().min(1),
  productSlug: z.string().min(1),
  productName: z.string().min(1),
  shortPinLabel: z.string().min(1).optional(),
  defaultColorKey: z.string().min(1).optional(),
  basePriceVnd: z.number().int().nonnegative(),
  pinPosition: z.object({
    xPercent: z.number(),
    yPercent: z.number(),
  }),
  garmentRegionMask: z.string().min(1),
  maskBbox: z
    .object({
      x: z.number(),
      y: z.number(),
      w: z.number(),
      h: z.number(),
    })
    .optional(),
  materialOpticalProfile: MaterialOpticalProfileSchema,
  variants: z.array(SeasonWearableVariantSchema),
});
export type SeasonWearableSlot = z.infer<typeof SeasonWearableSlotSchema>;

export const SeasonInteractiveLookbookSchema = z.object({
  baseEditorialImageUrl: z.string().min(1),
  materialHeadline: z.string().min(1),
  shortName: z.string().min(1),
  outfitFormula: SeasonOutfitFormulaSchema.optional(),
  defaultMacroSlotKey: SeasonWearableSlotKeySchema.optional(),
  totalDesigns: z.number().int().nonnegative(),
  wearableSlots: z.array(SeasonWearableSlotSchema),
  restyleCacheMap: z.record(z.string()),
});
export type SeasonInteractiveLookbook = z.infer<typeof SeasonInteractiveLookbookSchema>;

export const SeasonAiRestyleSelectionSchema = z.object({
  slotKey: SeasonWearableSlotKeySchema,
  productId: z.string().min(1),
  variantId: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  colorKey: z.string().min(1).optional(),
});
export type SeasonAiRestyleSelection = z.infer<typeof SeasonAiRestyleSelectionSchema>;

export const SeasonAiRestyleRequestSchema = z.object({
  selections: z.array(SeasonAiRestyleSelectionSchema).min(1),
});
export type SeasonAiRestyleRequest = z.infer<typeof SeasonAiRestyleRequestSchema>;

export const SeasonAiRestyleResponseSchema = z.object({
  status: z.enum(['COMPLETED', 'FAILED']),
  seasonSlug: z.string().min(1),
  comboKey: z.string().min(1),
  cacheHit: z.boolean(),
  sceneImageUrl: z.string(),
  latencyMs: z.number().int().nonnegative(),
});
export type SeasonAiRestyleResponse = z.infer<typeof SeasonAiRestyleResponseSchema>;

export const SeasonalCollectionDtoSchema = z.object({
  id: z.string().min(1),
  slug: z.string().min(1),
  months: z.string().min(1),
  name: z.string().min(1),
  shortName: z.string().optional(),
  materialHeadline: z.string().optional(),
  note: z.string(),
  coverAssetUrl: z.string().nullable().optional(),
  launchAt: z.string().nullable().optional(),
  endAt: z.string().nullable().optional(),
  isCurrent: z.boolean(),
  isCurrentSeason: z.boolean().optional(),
  isNow: z.boolean().optional(),
  sortOrder: z.number().int(),
  productSlugs: z.array(z.string()),
  productCount: z.number().int().nonnegative().optional(),
  featuredProductSlugs: z.array(z.string()).optional(),
  interactiveLookbook: SeasonInteractiveLookbookSchema.nullable().optional(),
  heroProducts: z.array(ProductSpuDtoSchema).optional(),
});
export type SeasonalCollectionDto = z.infer<typeof SeasonalCollectionDtoSchema>;

export const PackagingOptionDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string(),
  swatchHex: z.string().min(4).max(16),
  priceVnd: z.number().int().nonnegative(),
  backAssetUrl: z.string().nullable().optional(),
  frontAssetUrl: z.string().nullable().optional(),
  isDefault: z.boolean(),
  sortOrder: z.number().int(),
});
export type PackagingOptionDto = z.infer<typeof PackagingOptionDtoSchema>;

export const CampaignIntroSchema = z.object({
  monogramLeft: z.string().min(1),
  monogramAmp: z.string().min(1),
  monogramRight: z.string().min(1),
  tagline: z.string().min(1),
  brandName: z.string().min(1),
  brandSub: z.string().min(1),
});
export type CampaignIntro = z.infer<typeof CampaignIntroSchema>;

export const CampaignHeroSchema = z.object({
  eyebrow: z.string().min(1),
  title: z.string().min(1),
  lead: z.string().min(1),
  primaryCtaLabel: z.string().min(1),
  serviceNote: z.string().min(1),
  posterUrl: z.string().min(1),
  videoWebmUrl: z.string().nullable(),
  videoMp4Url: z.string().nullable(),
});
export type CampaignHero = z.infer<typeof CampaignHeroSchema>;

export const AtelierStepSchema = z.object({
  stepOrder: z.number().int().positive(),
  timeTarget: z.string().min(1),
  title: z.string().min(1),
  description: z.string().min(1),
  imageUrl: z.string().min(1),
  imageAlt: z.string().min(1),
});
export type AtelierStep = z.infer<typeof AtelierStepSchema>;

export const FeaturedVoiceSchema = z.object({
  quote: z.string().min(1),
  author: z.string().min(1),
  fitMeta: z.string().min(1),
});
export type FeaturedVoice = z.infer<typeof FeaturedVoiceSchema>;

export const CampaignFinaleSchema = z.object({
  eyebrow: z.string().min(1),
  leadMain: z.string().min(1),
  leadEmphasis: z.string().min(1),
  ctaLabel: z.string().min(1),
  showroomInfo: z.string().min(1),
  wordmark: z.string().min(1),
  featuredVoices: z.array(FeaturedVoiceSchema),
});
export type CampaignFinale = z.infer<typeof CampaignFinaleSchema>;

export const HomepageCampaignDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  slug: z.string().min(1).optional(),
  eyebrow: z.string(),
  title: z.string(),
  subtitle: z.string(),
  heroTitle: z.string().optional(),
  heroSubtitle: z.string().optional(),
  atelierManifesto: z.string().optional(),
  privacyGuaranteeMinutes: z.number().int().positive().optional(),
  heroImageUrl: z.string().nullable().optional(),
  heroVideoUrl: z.string().nullable().optional(),
  heroPosterUrl: z.string().nullable().optional(),
  ctaLabel: z.string(),
  serviceNote: z.string(),
  isActive: z.boolean(),
  updatedAt: z.string(),

  // Phase 2 structured editorial campaign sections
  intro: CampaignIntroSchema.optional(),
  hero: CampaignHeroSchema.optional(),
  atelierSteps: z.array(AtelierStepSchema).optional(),
  finale: CampaignFinaleSchema.optional(),
});
export type HomepageCampaignDto = z.infer<typeof HomepageCampaignDtoSchema>;

export const UpdateHomepageCampaignSchema = z.object({
  slug: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  eyebrow: z.string().min(1).optional(),
  title: z.string().min(1).optional(),
  subtitle: z.string().min(1).optional(),
  heroTitle: z.string().min(1).optional(),
  heroSubtitle: z.string().min(1).optional(),
  atelierManifesto: z.string().min(1).optional(),
  privacyGuaranteeMinutes: z.number().int().positive().max(1440).optional(),
  heroImageUrl: z.string().nullable().optional(),
  heroVideoUrl: z.string().nullable().optional(),
  heroPosterUrl: z.string().nullable().optional(),
  ctaLabel: z.string().min(1).optional(),
  serviceNote: z.string().min(1).optional(),
  tagline: z.string().min(1).optional(),
  isActive: z.boolean().optional(),
  intro: CampaignIntroSchema.partial().optional(),
  hero: CampaignHeroSchema.partial().optional(),
  atelierSteps: z.array(AtelierStepSchema).min(1).max(8).optional(),
  finale: CampaignFinaleSchema.partial().optional(),
});
export type UpdateHomepageCampaignRequest = z.infer<typeof UpdateHomepageCampaignSchema>;

export const SupplierProductSubmissionDtoSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  proposedName: z.string().min(1),
  proposedCategorySlug: z.string().min(1),
  fabricComposition: z.string().min(1),
  wholesaleCostVnd: z.number().int().nonnegative(),
  suggestedRetailVnd: z.number().int().nonnegative(),
  availableSizes: z.array(SizeCodeSchema).min(1),
  colorName: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  assetIds: z.array(z.string()),
  notes: z.string().nullable().optional(),
  status: SubmissionStatusSchema,
  reviewComment: z.string().nullable(),
  reviewedBy: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  createdProductId: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type SupplierProductSubmissionDto = z.infer<typeof SupplierProductSubmissionDtoSchema>;

export const CreateSupplierSubmissionSchema = z.object({
  proposedName: z.string().trim().min(2).max(180),
  proposedCategorySlug: z.string().trim().min(1).max(64),
  fabricComposition: z.string().trim().min(2).max(240),
  wholesaleCostVnd: z.number().int().nonnegative(),
  suggestedRetailVnd: z.number().int().nonnegative(),
  availableSizes: z.array(SizeCodeSchema).min(1),
  colorName: z.string().trim().min(1).max(64),
  colorHex: z.string().trim().min(4).max(16),
  assetIds: z.array(z.string().min(1)).default([]),
  notes: z.string().max(500).optional(),
});
export type CreateSupplierSubmissionRequest = z.infer<typeof CreateSupplierSubmissionSchema>;

export const ReviewSupplierSubmissionSchema = z.object({
  decision: z.enum([SubmissionStatus.APPROVED, SubmissionStatus.REJECTED]),
  reviewComment: z.string().max(500).optional(),
});
export type ReviewSupplierSubmissionRequest = z.infer<typeof ReviewSupplierSubmissionSchema>;

export const SizeRecommendRequestSchema = z
  .object({
    productId: z.string().min(1).optional(),
    productSlug: z.string().min(1).optional(),
    heightCm: z.number().min(120).max(230),
    weightKg: z.number().min(25).max(200),
    bustCm: z.number().min(50).max(180).nullable().optional(),
    waistCm: z.number().min(40).max(170).nullable().optional(),
    hipCm: z.number().min(50).max(190).nullable().optional(),
    shoulderCm: z.number().min(28).max(70).nullable().optional(),
    fitPreference: FitPreferenceSchema.default(FitPreference.REGULAR),
  })
  .refine((value) => Boolean(value.productId || value.productSlug), {
    message: 'Either productId or productSlug is required',
  });
export type SizeRecommendRequest = z.infer<typeof SizeRecommendRequestSchema>;

export const SizeMeasurementBreakdownItemSchema = z.object({
  metric: z.string(),
  userValue: z.number().nullable(),
  chartMin: z.number().nullable().optional(),
  chartMax: z.number().nullable().optional(),
  chartTarget: z.number().nullable().optional(),
  delta: z.number().nullable(),
  verdict: z.enum(['TIGHT', 'IDEAL', 'RELAXED', 'UNKNOWN']),
});
export type SizeMeasurementBreakdownItem = z.infer<typeof SizeMeasurementBreakdownItemSchema>;

export const SizeRecommendResponseSchema = z.object({
  recommendedSize: SizeCodeSchema,
  confidence: z.number().min(0).max(1),
  fitNotes: z.array(z.string()),
  measurementBreakdown: z.array(SizeMeasurementBreakdownItemSchema),
  alternatives: z.array(
    z.object({
      sizeCode: SizeCodeSchema,
      reason: z.string(),
    }),
  ),
  fitCalibrationNote: z.string().nullable(),
  fitStats: ProductFitStatsDtoSchema.nullable().optional(),
  crowdAdjusted: z.boolean().optional(),
  crowdAdjustmentReason: z.string().nullable().optional(),
});
export type SizeRecommendResponse = z.infer<typeof SizeRecommendResponseSchema>;

export const SizeRecommendationRequestSchema = SizeRecommendRequestSchema;
export type SizeRecommendationRequestDTO = SizeRecommendRequest;

export const SizeRecommendationResponseSchema = SizeRecommendResponseSchema;
export type SizeRecommendationResponseDTO = SizeRecommendResponse;

// ----------------------------------------------------------------------------
// Phase 3: Rack 3D Collection & PDP Composite DTOs
// ----------------------------------------------------------------------------

export const RackGarmentVariantDtoSchema = z.object({
  id: z.string().min(1),
  colorName: z.string().min(1),
  colorHex: z.string().min(4).max(16),
  frontCutoutUrl: z.string().nullable(),
  backCutoutUrl: z.string().nullable(),
  lookbookMainUrl: z.string().nullable(),
  tryonFlatPreviewUrl: z.string().nullable(),
  rackFrontAssetId: z.string().nullable(),
  hangerAnchorX: z.number().min(0).max(1),
  hangerAnchorY: z.number().min(0).max(1),
  inStockSizes: z.array(SizeCodeSchema),
  skus: z.array(SkuDtoSchema),
});
export type RackGarmentVariantDto = z.infer<typeof RackGarmentVariantDtoSchema>;

export const RackGarmentItemDtoSchema = z.object({
  productId: z.string().min(1),
  slug: z.string().min(1),
  name: z.string().min(1),
  subtitle: z.string().nullable().optional(),
  fabricComposition: z.string(),
  fabricWeight: z.union([z.number(), z.string()]),
  minPriceVnd: z.number().int().nonnegative(),
  isTryonEnabled: z.boolean(),
  tryonGarmentCategory: TryOnGarmentCategorySchema,
  fitStats: ProductFitStatsDtoSchema.nullable().optional(),
  variants: z.array(RackGarmentVariantDtoSchema),
});
export type RackGarmentItemDto = z.infer<typeof RackGarmentItemDtoSchema>;

export const RackCollectionDtoSchema = z.object({
  items: z.array(RackGarmentItemDtoSchema),
  total: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type RackCollectionDto = z.infer<typeof RackCollectionDtoSchema>;

export const PdpCompositeDtoSchema = z.object({
  product: ProductSpuDtoSchema,
  fitStats: ProductFitStatsDtoSchema.nullable(),
  reviews: z.array(VerifiedReviewDtoSchema),
  reviewsDegraded: z.boolean(),
});
export type PdpCompositeDto = z.infer<typeof PdpCompositeDtoSchema>;

// ----------------------------------------------------------------------------
// Stage P2.1: Occasions, Seasons, Categories, Size Charts & Variants CRUD DTOs
// ----------------------------------------------------------------------------

export const CreateOccasionDtoSchema = z.object({
  slug: z.string().trim().min(2).max(120),
  key: z.string().trim().min(2).max(80).optional(),
  name: z.string().trim().min(2).max(180),
  tagline: z.string().trim().max(240).optional(),
  description: z.string().max(1000).nullable().optional(),
  themeBg: z.string().trim().min(1).max(32).optional(),
  themeInk: z.string().trim().min(1).max(32).optional(),
  themeAccent: z.string().trim().min(1).max(32).optional(),
  isDark: z.boolean().optional(),
  badgeTag: z.string().max(80).nullable().optional(),
  coverImageUrl: z.string().nullable().optional(),
  heroCutoutUrl: z.string().nullable().optional(),
  macroImageUrl: z.string().nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
  spuIds: z.array(z.string().min(1)).optional(),
  productSlugs: z.array(z.string().min(1)).optional(),
});
export type CreateOccasionDto = z.infer<typeof CreateOccasionDtoSchema>;

export const UpdateOccasionDtoSchema = CreateOccasionDtoSchema.partial();
export type UpdateOccasionDto = z.infer<typeof UpdateOccasionDtoSchema>;

export const SeasonColorSwatchSchema = z.object({
  name: z.string().trim().min(1).max(100),
  hex: z.string().trim().min(4).max(16),
  fabricNote: z.string().max(240).optional(),
});
export type SeasonColorSwatch = z.infer<typeof SeasonColorSwatchSchema>;

export const CreateSeasonDtoSchema = z.object({
  slug: z.string().trim().min(2).max(120),
  code: z.string().trim().min(2).max(80).optional(),
  name: z.string().trim().min(2).max(180),
  shortName: z.string().trim().max(80).optional(),
  subtitle: z.string().trim().max(240).optional(),
  months: z.string().trim().max(64).optional(),
  materialHeadline: z.string().trim().max(240).optional(),
  note: z.string().max(1000).optional(),
  seasonOrder: z.coerce.number().int().optional(),
  sortOrder: z.coerce.number().int().optional(),
  heroImageUrl: z.string().nullable().optional(),
  coverAssetUrl: z.string().nullable().optional(),
  swatches: z.array(SeasonColorSwatchSchema).optional(),
  paletteJsonb: z.union([z.array(SeasonColorSwatchSchema), z.record(z.unknown())]).optional(),
  lookbookMeta: z.record(z.unknown()).nullable().optional(),
  isCurrent: z.boolean().optional(),
  isActive: z.boolean().optional(),
  spuIds: z.array(z.string().min(1)).optional(),
  productSlugs: z.array(z.string().min(1)).optional(),
});
export type CreateSeasonDto = z.infer<typeof CreateSeasonDtoSchema>;

export const UpdateSeasonDtoSchema = CreateSeasonDtoSchema.partial();
export type UpdateSeasonDto = z.infer<typeof UpdateSeasonDtoSchema>;

export const CreateCategoryDtoSchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  slug: z.string().trim().min(2).max(120),
  name: z.string().trim().min(2).max(180),
  description: z.string().max(1000).nullable().optional(),
  sortOrder: z.coerce.number().int().default(0),
  isActive: z.boolean().default(true),
});
export type CreateCategoryDto = z.infer<typeof CreateCategoryDtoSchema>;

export const UpdateCategoryDtoSchema = CreateCategoryDtoSchema.partial();
export type UpdateCategoryDto = z.infer<typeof UpdateCategoryDtoSchema>;

export const SizeChartStretchLevelInputSchema = z.enum([
  'NONE',
  'LOW',
  'LIGHT',
  'MEDIUM',
  'HIGH',
]);
export type SizeChartStretchLevelInput = z.infer<typeof SizeChartStretchLevelInputSchema>;

export const SizeChartRowInputSchema = z.object({
  sizeCode: SizeCodeSchema,
  heightMinCm: z.coerce.number().min(100).max(240).optional(),
  heightMaxCm: z.coerce.number().min(100).max(240).optional(),
  weightMinKg: z.coerce.number().min(20).max(220).optional(),
  weightMaxKg: z.coerce.number().min(20).max(220).optional(),
  chestMinCm: z.coerce.number().nullable().optional(),
  chestMaxCm: z.coerce.number().nullable().optional(),
  bustCm: z.coerce.number().nullable().optional(),
  waistMinCm: z.coerce.number().nullable().optional(),
  waistMaxCm: z.coerce.number().nullable().optional(),
  waistCm: z.coerce.number().nullable().optional(),
  hipMinCm: z.coerce.number().nullable().optional(),
  hipMaxCm: z.coerce.number().nullable().optional(),
  hipCm: z.coerce.number().nullable().optional(),
  shoulderCm: z.coerce.number().nullable().optional(),
  lengthCm: z.coerce.number().nullable().optional(),
});
export type SizeChartRowInput = z.infer<typeof SizeChartRowInputSchema>;

export const CreateSizeChartDtoSchema = z.object({
  code: z.string().trim().min(2).max(80).optional(),
  name: z.string().trim().min(2).max(180),
  categoryId: z.string().min(1).nullable().optional(),
  garmentCategory: z.string().trim().min(1).max(80).optional(),
  garmentType: z.string().trim().min(1).max(80).optional(),
  gender: GenderSchema.default(Gender.UNISEX),
  stretchLevel: SizeChartStretchLevelInputSchema.optional(),
  fitNote: z.string().max(1000).nullable().optional(),
  fitNotes: z.string().max(1000).nullable().optional(),
  sizeCode: SizeCodeSchema.optional(),
  chestMin: z.coerce.number().nullable().optional(),
  chestMax: z.coerce.number().nullable().optional(),
  waistMin: z.coerce.number().nullable().optional(),
  waistMax: z.coerce.number().nullable().optional(),
  hipMin: z.coerce.number().nullable().optional(),
  hipMax: z.coerce.number().nullable().optional(),
  shoulderCm: z.coerce.number().nullable().optional(),
  weightMinKg: z.coerce.number().nullable().optional(),
  weightMaxKg: z.coerce.number().nullable().optional(),
  heightMinCm: z.coerce.number().nullable().optional(),
  heightMaxCm: z.coerce.number().nullable().optional(),
  rows: z.array(SizeChartRowInputSchema).optional(),
});
export type CreateSizeChartDto = z.infer<typeof CreateSizeChartDtoSchema>;

export const UpdateSizeChartDtoSchema = CreateSizeChartDtoSchema.partial();
export type UpdateSizeChartDto = z.infer<typeof UpdateSizeChartDtoSchema>;

export const CreateProductVariantDtoSchema = z.object({
  sku: z.string().trim().min(2).max(80).optional(),
  skuCode: z.string().trim().min(2).max(80).optional(),
  size: SizeCodeSchema.optional(),
  sizeCode: SizeCodeSchema.optional(),
  colorName: z.string().trim().min(1).max(100),
  colorHex: z.string().trim().min(4).max(16).default('#1C1410'),
  priceVnd: z.coerce.number().int().nonnegative().optional(),
  basePriceVnd: z.coerce.number().int().nonnegative().optional(),
  salePriceVnd: z.coerce.number().int().nonnegative().optional(),
  costPriceVnd: z.coerce.number().int().nonnegative().optional(),
  barcode: z.string().trim().max(80).nullable().optional(),
  weightGrams: z.coerce.number().int().nonnegative().default(350),
  isActive: z.boolean().default(true),
  isReturnable: z.boolean().default(true),
  lookbookMainUrl: z.string().nullable().optional(),
});
export type CreateProductVariantDto = z.infer<typeof CreateProductVariantDtoSchema>;

export const AttachMediaToProductDtoSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().optional(),
  assetId: z.string().min(1).optional(),
  url: z.string().min(1).optional(),
  slot: z
    .enum([
      'LOOKBOOK_MAIN',
      'RACK_FRONT',
      'RACK_BACK',
      'STUDIO_LAYER',
      'TRYON_FLAT',
    ])
    .default('LOOKBOOK_MAIN'),
});
export type AttachMediaToProductDto = z.infer<typeof AttachMediaToProductDtoSchema>;
