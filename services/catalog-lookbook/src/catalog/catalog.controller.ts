import * as crypto from 'node:crypto';
import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  createApiResponse,
  ErrorCode,
  FitPreference,
  FitTypeSchema,
  GenderSchema,
  ProductFitStatsDtoSchema,
  ProductStatusSchema,
  SizeCodeSchema,
  StretchLevelSchema,
  TryOnGarmentCategorySchema,
  UpdateHomepageCampaignSchema,
  VirtualModelCodeSchema,
  type ApiResponse,
  type SizeRecommendRequest,
} from '@atelier/contracts';
import {
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  type HeaderBag,
} from '@atelier/observability';
import { z } from 'zod';
import {
  CATALOG_CONFIG_TOKEN,
  SERVICE_NAME,
  type CatalogLookbookConfig,
} from '../config/env';
import { CatalogRagService } from '../rag/catalog-rag.service';
import { CatalogService } from './catalog.service';

const RagQueryBodySchema = z.object({
  query: z.string().trim().min(1).max(1000).optional(),
  question: z.string().trim().min(1).max(1000).optional(),
  q: z.string().trim().min(1).max(1000).optional(),
  topK: z.coerce.number().int().min(1).max(12).default(5),
});

const CreateAdminProductSchema = z.object({
  categoryId: z.string().min(1).optional(),
  categorySlug: z.string().min(1).optional(),
  slug: z.string().min(1).optional(),
  name: z.string().trim().min(2).max(200),
  subtitle: z.string().max(300).nullable().optional(),
  brandName: z.string().max(120).optional(),
  description: z.string().trim().min(2).max(4000).default('Thiết kế thủ công tại TryVibe Atelier.'),
  fabricComposition: z.string().trim().min(2).max(300).default('100% Lụa tơ tằm Bảo Lộc'),
  fitType: FitTypeSchema.optional(),
  stretchLevel: StretchLevelSchema.optional(),
  fabricWeight: z.union([z.number(), z.string()]).optional(),
  gender: GenderSchema.optional(),
  isTryonEnabled: z.boolean().optional(),
  tryonGarmentCategory: TryOnGarmentCategorySchema.optional(),
  tryonFlatAssetUrl: z.string().nullable().optional(),
  fitCalibrationNote: z.string().max(500).nullable().optional(),
  status: ProductStatusSchema.optional(),
  sizeChartId: z.string().nullable().optional(),
  occasionSlugs: z.array(z.string()).optional(),
  seasonSlugs: z.array(z.string()).optional(),
  variants: z
    .array(
      z.object({
        colorName: z.string().min(1),
        colorHex: z.string().min(4).max(16),
        lookbookMainUrl: z.string().nullable().optional(),
        tryonFlatPreviewUrl: z.string().nullable().optional(),
        rackFrontUrl: z.string().nullable().optional(),
        skus: z
          .array(
            z.object({
              skuCode: z.string().min(1).optional(),
              sizeCode: SizeCodeSchema,
              basePriceVnd: z.number().int().nonnegative(),
              salePriceVnd: z.number().int().nonnegative().nullable().optional(),
              costPriceVnd: z.number().int().nonnegative().optional(),
              supplierId: z.string().nullable().optional(),
              weightGrams: z.number().int().nonnegative().optional(),
              inStock: z.boolean().optional(),
              isReturnable: z.boolean().optional(),
            }),
          )
          .optional(),
      }),
    )
    .optional(),
});

const AttachMediaBodySchema = z.object({
  assetId: z.string().min(1).nullable().optional(),
  variantId: z.string().min(1).nullable().optional(),
  url: z.string().min(1).nullable().optional(),
  mediaUrl: z.string().min(1).nullable().optional(),
  publicUrl: z.string().min(1).nullable().optional(),
  slot: z.string().trim().min(1).max(64).optional(),
  role: z.string().trim().min(1).max(64).optional(),
  mediaType: z.string().trim().min(1).max(64).optional(),
  assetType: z.string().trim().min(1).max(64).optional(),
  objectKey: z.string().nullable().optional(),
  spatialMetadata: z.record(z.unknown()).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  setAsPrimary: z.boolean().optional(),
});

const UpdateAdminProductSchema = z.object({
  categoryId: z.string().min(1).optional(),
  categorySlug: z.string().min(1).optional(),
  name: z.string().trim().min(2).max(200).optional(),
  subtitle: z.string().max(300).nullable().optional(),
  description: z.string().max(4000).optional(),
  fabricComposition: z.string().max(300).optional(),
  fitType: FitTypeSchema.optional(),
  stretchLevel: StretchLevelSchema.optional(),
  fabricWeight: z.union([z.number(), z.string()]).optional(),
  gender: GenderSchema.optional(),
  isTryonEnabled: z.boolean().optional(),
  tryonGarmentCategory: TryOnGarmentCategorySchema.optional(),
  tryonFlatAssetUrl: z.string().nullable().optional(),
  fitCalibrationNote: z.string().max(500).nullable().optional(),
  status: ProductStatusSchema.optional(),
  isActive: z.boolean().optional(),
  sizeChartId: z.string().nullable().optional(),
  occasionSlugs: z.array(z.string()).optional(),
  seasonSlugs: z.array(z.string()).optional(),
  variantId: z.string().nullable().optional(),
  lookbookMainUrl: z.string().nullable().optional(),
  rackFrontAssetId: z.string().nullable().optional(),
  rackFrontUrl: z.string().nullable().optional(),
  mediaAttach: AttachMediaBodySchema.nullable().optional(),
});

const CreateOccasionBodySchema = z.object({
  slug: z.string().trim().min(2).max(120).optional(),
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
  heroImageUrl: z.string().nullable().optional(),
  heroCutoutUrl: z.string().nullable().optional(),
  macroImageUrl: z.string().nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
  spuIds: z.array(z.string().min(1)).optional(),
  productSlugs: z.array(z.string().min(1)).optional(),
});

const UpdateOccasionBodySchema = CreateOccasionBodySchema.partial();

const SeasonSwatchBodySchema = z.object({
  name: z.string().trim().min(1).max(100),
  hex: z.string().trim().min(4).max(16),
  fabricNote: z.string().max(240).nullable().optional(),
  colorKey: z.string().max(64).nullable().optional(),
  sheen: z.string().max(32).nullable().optional(),
});

const CreateSeasonBodySchema = z.object({
  slug: z.string().trim().min(2).max(120).optional(),
  code: z.string().trim().min(2).max(80).optional(),
  name: z.string().trim().min(2).max(180),
  shortName: z.string().trim().max(80).optional(),
  subtitle: z.string().trim().max(240).optional(),
  months: z.string().trim().max(64).optional(),
  seasonTag: z.string().trim().max(80).optional(),
  materialHeadline: z.string().trim().max(240).optional(),
  note: z.string().max(1000).optional(),
  paletteHex: z.string().trim().max(32).optional(),
  seasonOrder: z.coerce.number().int().optional(),
  sortOrder: z.coerce.number().int().optional(),
  heroImageUrl: z.string().nullable().optional(),
  coverAssetUrl: z.string().nullable().optional(),
  swatches: z.array(SeasonSwatchBodySchema).optional(),
  paletteJsonb: z
    .union([z.array(SeasonSwatchBodySchema), z.record(z.unknown())])
    .optional(),
  lookbookMeta: z.record(z.unknown()).nullable().optional(),
  isCurrent: z.boolean().optional(),
  isActive: z.boolean().optional(),
  spuIds: z.array(z.string().min(1)).optional(),
  productSlugs: z.array(z.string().min(1)).optional(),
});

const UpdateSeasonBodySchema = CreateSeasonBodySchema.partial();

const CreateCategoryBodySchema = z.object({
  parentId: z.string().min(1).nullable().optional(),
  slug: z.string().trim().min(2).max(120).optional(),
  name: z.string().trim().min(2).max(180),
  description: z.string().max(1000).nullable().optional(),
  sortOrder: z.coerce.number().int().optional(),
  isActive: z.boolean().optional(),
});

const UpdateCategoryBodySchema = CreateCategoryBodySchema.partial();

const SizeChartStretchSchema = z.enum(['NONE', 'LOW', 'LIGHT', 'MEDIUM', 'HIGH']);

const SizeChartRowBodySchema = z.object({
  sizeCode: SizeCodeSchema,
  heightMinCm: z.coerce.number().min(100).max(240).nullable().optional(),
  heightMaxCm: z.coerce.number().min(100).max(240).nullable().optional(),
  weightMinKg: z.coerce.number().min(20).max(220).nullable().optional(),
  weightMaxKg: z.coerce.number().min(20).max(220).nullable().optional(),
  chestMin: z.coerce.number().nullable().optional(),
  chestMax: z.coerce.number().nullable().optional(),
  chestMinCm: z.coerce.number().nullable().optional(),
  chestMaxCm: z.coerce.number().nullable().optional(),
  bustCm: z.coerce.number().nullable().optional(),
  waistMin: z.coerce.number().nullable().optional(),
  waistMax: z.coerce.number().nullable().optional(),
  waistMinCm: z.coerce.number().nullable().optional(),
  waistMaxCm: z.coerce.number().nullable().optional(),
  waistCm: z.coerce.number().nullable().optional(),
  hipMin: z.coerce.number().nullable().optional(),
  hipMax: z.coerce.number().nullable().optional(),
  hipMinCm: z.coerce.number().nullable().optional(),
  hipMaxCm: z.coerce.number().nullable().optional(),
  hipCm: z.coerce.number().nullable().optional(),
  shoulderCm: z.coerce.number().nullable().optional(),
  lengthCm: z.coerce.number().nullable().optional(),
  stretchLevel: SizeChartStretchSchema.nullable().optional(),
  fitNotes: z.string().max(500).nullable().optional(),
});

const CreateSizeChartBodySchema = z.object({
  code: z.string().trim().min(2).max(80).optional(),
  name: z.string().trim().min(2).max(180).optional(),
  categoryId: z.string().min(1).nullable().optional(),
  garmentCategory: z.string().trim().min(1).max(80).optional(),
  garmentType: z.string().trim().min(1).max(80).optional(),
  gender: GenderSchema.optional(),
  stretchLevel: SizeChartStretchSchema.optional(),
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
  rows: z.array(SizeChartRowBodySchema).optional(),
});

const UpdateSizeChartBodySchema = CreateSizeChartBodySchema.partial();

const AddProductVariantBodySchema = z.object({
  variantId: z.string().min(1).nullable().optional(),
  sku: z.string().trim().min(2).max(80).optional(),
  skuCode: z.string().trim().min(2).max(80).optional(),
  size: SizeCodeSchema.optional(),
  sizeCode: SizeCodeSchema.optional(),
  colorName: z.string().trim().min(1).max(100),
  colorHex: z.string().trim().min(4).max(16).optional(),
  priceVnd: z.coerce.number().int().nonnegative().optional(),
  basePriceVnd: z.coerce.number().int().nonnegative().optional(),
  salePriceVnd: z.coerce.number().int().nonnegative().nullable().optional(),
  costPriceVnd: z.coerce.number().int().nonnegative().optional(),
  barcode: z.string().trim().max(80).nullable().optional(),
  weightGrams: z.coerce.number().int().nonnegative().optional(),
  isActive: z.boolean().optional(),
  inStock: z.boolean().optional(),
  isReturnable: z.boolean().optional(),
  supplierId: z.string().nullable().optional(),
  lookbookMainUrl: z.string().nullable().optional(),
  tryonFlatPreviewUrl: z.string().nullable().optional(),
  rackFrontUrl: z.string().nullable().optional(),
  skus: z
    .array(
      z.object({
        sku: z.string().trim().min(2).max(80).optional(),
        skuCode: z.string().trim().min(2).max(80).optional(),
        size: SizeCodeSchema.optional(),
        sizeCode: SizeCodeSchema.optional(),
        priceVnd: z.coerce.number().int().nonnegative().optional(),
        basePriceVnd: z.coerce.number().int().nonnegative().optional(),
        salePriceVnd: z.coerce.number().int().nonnegative().nullable().optional(),
        costPriceVnd: z.coerce.number().int().nonnegative().optional(),
        barcode: z.string().trim().max(80).nullable().optional(),
        weightGrams: z.coerce.number().int().nonnegative().optional(),
        isActive: z.boolean().optional(),
        inStock: z.boolean().optional(),
        isReturnable: z.boolean().optional(),
        supplierId: z.string().nullable().optional(),
      }),
    )
    .optional(),
});

const UpdateAdminSkuSchema = z.object({
  basePriceVnd: z.number().int().nonnegative().optional(),
  salePriceVnd: z.number().int().nonnegative().nullable().optional(),
  costPriceVnd: z.number().int().nonnegative().optional(),
  inStock: z.boolean().optional(),
  weightGrams: z.number().int().nonnegative().optional(),
  isReturnable: z.boolean().optional(),
});

const PartnerSubmissionBodySchema = z.object({
  proposedName: z.string().trim().min(2).max(200),
  proposedCategorySlug: z.string().trim().min(1).max(64).optional(),
  categorySlug: z.string().trim().min(1).max(64).optional(),
  fabricComposition: z.string().trim().min(2).max(240),
  wholesaleCostVnd: z.number().int().nonnegative().optional(),
  wholesalePriceVnd: z.number().int().nonnegative().optional(),
  suggestedRetailVnd: z.number().int().nonnegative(),
  availableSizes: z.array(SizeCodeSchema).min(1).optional(),
  colorName: z.string().trim().min(1).max(64).optional(),
  colorHex: z.string().trim().min(4).max(16).optional(),
  assetIds: z.array(z.string().min(1)).optional(),
  rawSizeSpec: z.record(z.unknown()).optional(),
  flatAssetUrl: z.string().nullable().optional(),
  rackAssetUrl: z.string().nullable().optional(),
  notes: z.string().max(1000).nullable().optional(),
});

const ReviewSubmissionBodySchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED']).optional(),
  status: z.enum(['APPROVED', 'REJECTED']).optional(),
  reviewComment: z.string().max(500).optional(),
  reviewNote: z.string().max(500).optional(),
});

const SkuSnapshotBodySchema = z.object({
  skuIds: z.array(z.string().min(1)).optional(),
  skuCodes: z.array(z.string().min(1)).optional(),
});

const MediaProcessedBodySchema = z.object({
  assetId: z.string().min(1),
  productId: z.string().optional(),
  variantId: z.string().optional(),
  assetType: z
    .enum(['RACK_CUTOUT_2_3', 'TRYON_FLAT_3_4', 'LOOKBOOK', 'STUDIO_LAYER'])
    .optional(),
  publicUrl: z.string().optional(),
  flatAssetUrl: z.string().optional(),
  rackFrontUrl: z.string().optional(),
  rackBackUrl: z.string().optional(),
  studioLayerUrl: z.string().optional(),
  spatialMetadata: z.record(z.unknown()).optional(),
});

const FitStatsUpdatedBodySchema = z.object({
  productId: z.string().min(1),
  fitStats: ProductFitStatsDtoSchema,
});

const GenerateLookbookBodySchema = z.object({
  variantId: z.string().min(1).nullable().optional(),
  virtualModelCode: VirtualModelCodeSchema,
  scenePrompt: z.string().trim().min(3).max(600),
});

const StockReplenishedBodySchema = z.object({
  skuIds: z.array(z.string().min(1)).optional(),
  productIds: z.array(z.string().min(1)).optional(),
  items: z
    .array(
      z.object({
        skuId: z.string().min(1).optional(),
        skuCode: z.string().min(1).optional(),
        productId: z.string().min(1).optional(),
        availableQty: z.number().int().nonnegative().optional(),
      }),
    )
    .optional(),
});

function parseOptionalBoolean(val: unknown): boolean | undefined {
  if (val === undefined || val === null || val === '') {
    return undefined;
  }
  const s = String(val).trim().toLowerCase();
  if (s === 'true' || s === '1') return true;
  if (s === 'false' || s === '0') return false;
  return undefined;
}

function parseOptionalInt(val: unknown): number | undefined {
  if (val === undefined || val === null || val === '') {
    return undefined;
  }
  const n = Number.parseInt(String(val), 10);
  return Number.isFinite(n) ? n : undefined;
}

function extractHeader(headers: HeaderBag, name: string): string | undefined {
  const raw = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(raw)) {
    return raw[0]?.trim() || undefined;
  }
  return typeof raw === 'string' && raw.trim() ? raw.trim() : undefined;
}

const Stage3SizeRecommendBodySchema = z
  .object({
    productId: z.string().trim().min(1).optional(),
    productSlug: z.string().trim().min(1).optional(),
    slug: z.string().trim().min(1).optional(),
    heightCm: z.coerce.number().min(120).max(230),
    weightKg: z.coerce.number().min(25).max(200),
    bustCm: z.coerce.number().min(50).max(180).nullable().optional(),
    waistCm: z.coerce.number().min(40).max(170).nullable().optional(),
    hipCm: z.coerce.number().min(50).max(190).nullable().optional(),
    shoulderCm: z.coerce.number().min(28).max(70).nullable().optional(),
    fitPreference: z
      .enum(['SLIM', 'REGULAR', 'RELAXED', 'SNUG', 'TRUE_TO_SIZE'])
      .optional(),
    stretchLevel: z
      .enum(['NONE', 'LOW', 'LIGHT', 'MEDIUM', 'HIGH'])
      .optional(),
  })
  .refine((v) => Boolean(v.productId || v.productSlug || v.slug), {
    message: 'Either productId, productSlug, or slug is required',
  });

function mapFitPreferenceInput(
  raw: 'SLIM' | 'REGULAR' | 'RELAXED' | 'SNUG' | 'TRUE_TO_SIZE' | undefined,
): FitPreference {
  if (raw === 'SNUG' || raw === 'SLIM') return FitPreference.SLIM;
  if (raw === 'RELAXED') return FitPreference.RELAXED;
  return FitPreference.REGULAR;
}

function timingSafeSecretEquals(provided: string, expected: string): boolean {
  const bufA = Buffer.from(provided, 'utf8');
  const bufB = Buffer.from(expected, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Controller('v1/catalog')
export class CatalogController {
  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    private readonly config: CatalogLookbookConfig,
    @Inject(CatalogService) private readonly catalog: CatalogService,
    @Inject(CatalogRagService) private readonly rag: CatalogRagService,
  ) {}

  private requireInternalSecret(headers: HeaderBag): void {
    const provided = extractHeader(headers, 'x-internal-secret');
    const expected = this.config.infra.internalServiceSecret;
    if (!provided || !expected || !timingSafeSecretEquals(provided, expected)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Invalid or missing x-internal-secret header',
      });
    }
  }

  // ==========================================================================
  // Storefront Endpoints
  // ==========================================================================

  @Get('bootstrap')
  async getBootstrap(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getStorefrontBootstrap']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.getStorefrontBootstrap();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('rack-showcase')
  async getRackShowcase(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getRackShowcase']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.getRackShowcase();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('occasions')
  async listOccasions(
    @Query('activeOnly') activeOnlyRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listOccasions']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.listOccasions({
      activeOnly: parseOptionalBoolean(activeOnlyRaw),
    });
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('occasions/:id')
  async getOccasion(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getOccasionByIdOrSlug']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.getOccasionByIdOrSlug(id);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('occasions')
  @HttpCode(HttpStatus.CREATED)
  async createOccasion(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['createOccasion']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = CreateOccasionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid create occasion payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createOccasion(parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Patch('occasions/:id')
  async updateOccasion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateOccasion']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateOccasionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update occasion payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateOccasion(id, parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Delete('occasions/:id')
  async deleteOccasion(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['deleteOccasion']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const deleted = await this.catalog.deleteOccasion(id);
    return createApiResponse(deleted, { correlationId, service: SERVICE_NAME });
  }

  @Get('seasons')
  async listSeasons(
    @Query('activeOnly') activeOnlyRaw: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listSeasons']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.listSeasons({
      activeOnly: parseOptionalBoolean(activeOnlyRaw),
    });
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('seasons/:id')
  async getSeason(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getSeasonByIdOrSlug']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.getSeasonByIdOrSlug(id);
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Post('seasons')
  @HttpCode(HttpStatus.CREATED)
  async createSeason(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['createSeason']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = CreateSeasonBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid create season payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createSeason(parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Patch('seasons/:id')
  async updateSeason(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateSeason']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateSeasonBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update season payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateSeason(id, parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Delete('seasons/:id')
  async deleteSeason(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['deleteSeason']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const deleted = await this.catalog.deleteSeason(id);
    return createApiResponse(deleted, { correlationId, service: SERVICE_NAME });
  }

  @Get('homepage-campaign')
  async getHomepageCampaign(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getHomepageCampaign']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const campaign = await this.catalog.getHomepageCampaign();
    return createApiResponse(campaign, { correlationId, service: SERVICE_NAME });
  }

  @Put('homepage-campaign')
  async updateHomepageCampaign(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateHomepageCampaign']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateHomepageCampaignSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid homepage campaign update payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateHomepageCampaign(parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Get('products')
  async listStorefrontProducts(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listProducts']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const categorySlug =
      typeof query.categorySlug === 'string' && query.categorySlug.trim()
        ? query.categorySlug.trim()
        : typeof query.category === 'string' && query.category.trim()
          ? query.category.trim()
          : undefined;

    const inStockOnly = parseOptionalBoolean(query.inStockOnly);
    const rawSize =
      typeof query.size === 'string' && query.size.trim()
        ? query.size.trim().toUpperCase()
        : undefined;
    const rawInStockSize =
      typeof query.inStockSize === 'string' && query.inStockSize.trim()
        ? query.inStockSize.trim().toUpperCase()
        : inStockOnly && rawSize
          ? rawSize
          : undefined;

    const statusParsed = ProductStatusSchema.safeParse(
      typeof query.status === 'string' ? query.status.trim().toUpperCase() : undefined,
    );

    const result = await this.catalog.listProducts({
      q: typeof query.q === 'string' ? query.q.trim() : undefined,
      categoryId:
        typeof query.categoryId === 'string' && query.categoryId.trim()
          ? query.categoryId.trim()
          : undefined,
      categorySlug,
      size: rawSize,
      inStockSize: rawInStockSize,
      color: typeof query.color === 'string' ? query.color.trim() : undefined,
      occasion:
        typeof query.occasion === 'string' ? query.occasion.trim() : undefined,
      season:
        typeof query.season === 'string' ? query.season.trim() : undefined,
      gender:
        typeof query.gender === 'string' ? query.gender.trim() : undefined,
      isTryonEnabled: parseOptionalBoolean(
        query.isTryonEnabled ?? query.tryonEnabled,
      ),
      minPriceVnd: parseOptionalInt(query.minPriceVnd ?? query.minPrice),
      maxPriceVnd: parseOptionalInt(query.maxPriceVnd ?? query.maxPrice),
      sort: typeof query.sort === 'string' ? query.sort.trim() : undefined,
      status: statusParsed.success ? statusParsed.data : undefined,
      includeArchived: parseOptionalBoolean(query.includeArchived),
      page: parseOptionalInt(query.page) ?? 1,
      pageSize: parseOptionalInt(query.limit ?? query.pageSize) ?? 20,
      includeCostFields: false,
    });

    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Post('products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  async addProductVariant(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['addProductVariant']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = AddProductVariantBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid add variant/SKU payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.addProductVariant(id, parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Post('products/:id/media')
  @HttpCode(HttpStatus.OK)
  async attachProductMedia(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['attachProductMedia']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const parsed = AttachMediaBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid attach media payload',
        details: { issues: parsed.error.issues },
      });
    }
    const result = await this.catalog.attachProductMedia(
      id,
      parsed.data,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Post('products/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveProductPost(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['archiveProduct']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const result = await this.catalog.archiveProduct(id, correlationId, traceparent);
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Patch('products/:id')
  async updateProductAlias(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateAdminProduct']>>>> {
    return this.updateAdminProduct(id, body, headers);
  }

  @Delete('products/:id')
  async deleteProductSoftArchive(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['archiveProduct']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const result = await this.catalog.archiveProduct(id, correlationId, traceparent);
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Get('products/:id/lookbooks')
  async listProductLookbooks(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['listLookbookSessions']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const sessions = await this.catalog.listLookbookSessions(id);
    return createApiResponse(sessions, { correlationId, service: SERVICE_NAME });
  }

  @Post('products/:id/lookbooks')
  @HttpCode(HttpStatus.CREATED)
  async generateProductLookbook(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['generateLookbookSession']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = GenerateLookbookBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid lookbook generation request payload',
        details: { issues: parsed.error.issues },
      });
    }
    const createdBy = extractHeader(headers, 'x-user-id');
    const traceparent = getOrCreateTraceparent(headers);
    const session = await this.catalog.generateLookbookSession(
      id,
      parsed.data,
      createdBy,
      correlationId,
      traceparent,
    );
    return createApiResponse(session, { correlationId, service: SERVICE_NAME });
  }

  @Post('products/:id/lookbooks/:sessionId/attach')
  @HttpCode(HttpStatus.OK)
  async attachProductLookbook(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['attachLookbookSession']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const traceparent = getOrCreateTraceparent(headers);
    const result = await this.catalog.attachLookbookSession(
      id,
      sessionId,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Get('products/:slug')
  async getStorefrontProduct(
    @Param('slug') slug: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getProductBySlug']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const product = await this.catalog.getProductBySlug(slug, false);
    return createApiResponse(product, { correlationId, service: SERVICE_NAME });
  }

  @Get('categories')
  async listCategories(
    @Query('includeInactive') includeInactiveRaw: string | undefined,
    @Query('parentId') parentId: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listCategories']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const categories = await this.catalog.listCategories({
      includeInactive: parseOptionalBoolean(includeInactiveRaw),
      parentId: parentId?.trim() || undefined,
    });
    return createApiResponse(categories, { correlationId, service: SERVICE_NAME });
  }

  @Post('categories')
  @HttpCode(HttpStatus.CREATED)
  async createCategory(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['createCategory']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = CreateCategoryBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid create category payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createCategory(parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Patch('categories/:id')
  async updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateCategory']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateCategoryBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update category payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateCategory(id, parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Delete('categories/:id')
  async deleteCategory(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['deleteCategory']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const deleted = await this.catalog.deleteCategory(id);
    return createApiResponse(deleted, { correlationId, service: SERVICE_NAME });
  }

  @Get('size-charts')
  async listSizeCharts(
    @Query('categoryId') categoryId: string | undefined,
    @Query('garmentType') garmentType: string | undefined,
    @Query('gender') gender: string | undefined,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listSizeCharts']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const charts = await this.catalog.listSizeCharts({
      categoryId: categoryId?.trim() || undefined,
      garmentType: garmentType?.trim() || undefined,
      gender: gender?.trim() || undefined,
    });
    return createApiResponse(charts, { correlationId, service: SERVICE_NAME });
  }

  @Post('size-charts')
  @HttpCode(HttpStatus.CREATED)
  async createSizeChart(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['createSizeChart']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = CreateSizeChartBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid create size chart payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createSizeChart(parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Patch('size-charts/:id')
  async updateSizeChart(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['updateSizeChart']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateSizeChartBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update size chart payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateSizeChart(id, parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Delete('size-charts/:id')
  async deleteSizeChart(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['deleteSizeChart']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const deleted = await this.catalog.deleteSizeChart(id);
    return createApiResponse(deleted, { correlationId, service: SERVICE_NAME });
  }

  @Post('size-recommend')
  @HttpCode(HttpStatus.OK)
  async recommendSize(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['recommendSize']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = Stage3SizeRecommendBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid size recommendation request payload',
        details: { issues: parsed.error.issues },
      });
    }
    const normalizedRequest: SizeRecommendRequest & {
      stretchLevel?: 'NONE' | 'LOW' | 'LIGHT' | 'MEDIUM' | 'HIGH';
    } = {
      productId: parsed.data.productId,
      productSlug: parsed.data.productSlug ?? parsed.data.slug,
      heightCm: parsed.data.heightCm,
      weightKg: parsed.data.weightKg,
      bustCm: parsed.data.bustCm,
      waistCm: parsed.data.waistCm,
      hipCm: parsed.data.hipCm,
      shoulderCm: parsed.data.shoulderCm,
      fitPreference: mapFitPreferenceInput(parsed.data.fitPreference),
      ...(parsed.data.stretchLevel
        ? { stretchLevel: parsed.data.stretchLevel }
        : {}),
    };
    const recommendation = await this.catalog.recommendSize(normalizedRequest);
    return createApiResponse(recommendation, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('rag/query')
  @HttpCode(HttpStatus.OK)
  async queryRag(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogRagService['query']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = RagQueryBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid RAG query payload',
        details: { issues: parsed.error.issues },
      });
    }
    const queryText = parsed.data.query ?? parsed.data.question ?? parsed.data.q;
    if (!queryText) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Field "query" (or "question") is required',
      });
    }
    const result = await this.rag.query(queryText, parsed.data.topK);
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  // ==========================================================================
  // Admin Endpoints
  // ==========================================================================

  @Get('admin/products')
  async listAdminProducts(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listProducts']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const statusParsed = ProductStatusSchema.safeParse(
      typeof query.status === 'string' ? query.status.toUpperCase() : undefined,
    );
    const result = await this.catalog.listProducts({
      q: typeof query.q === 'string' ? query.q.trim() : undefined,
      categoryId:
        typeof query.categoryId === 'string' && query.categoryId.trim()
          ? query.categoryId.trim()
          : undefined,
      categorySlug:
        typeof query.categorySlug === 'string'
          ? query.categorySlug.trim()
          : typeof query.category === 'string'
            ? query.category.trim()
            : undefined,
      status: statusParsed.success ? statusParsed.data : undefined,
      includeArchived: parseOptionalBoolean(query.includeArchived),
      page: parseOptionalInt(query.page) ?? 1,
      pageSize: parseOptionalInt(query.limit ?? query.pageSize) ?? 50,
      includeCostFields: true,
    });
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Get('admin/products/:id')
  async getAdminProduct(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['getAdminProductByIdOrSlug']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const product = await this.catalog.getAdminProductByIdOrSlug(id);
    return createApiResponse(product, { correlationId, service: SERVICE_NAME });
  }

  @Post('admin/products')
  @HttpCode(HttpStatus.CREATED)
  async createAdminProduct(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['createAdminProduct']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = CreateAdminProductSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid create product payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createAdminProduct(parsed.data);
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  @Patch('admin/products/:id')
  async updateAdminProduct(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['updateAdminProduct']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateAdminProductSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update product payload',
        details: { issues: parsed.error.issues },
      });
    }
    const updated = await this.catalog.updateAdminProduct(id, parsed.data);
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  @Post('admin/products/:id/variants')
  @HttpCode(HttpStatus.CREATED)
  async addAdminProductVariant(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['addProductVariant']>>>> {
    return this.addProductVariant(id, body, headers);
  }

  @Post('admin/products/:id/media')
  @HttpCode(HttpStatus.OK)
  async attachAdminProductMedia(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['attachProductMedia']>>>> {
    return this.attachProductMedia(id, body, headers);
  }

  @Post('admin/products/:id/archive')
  @HttpCode(HttpStatus.OK)
  async archiveAdminProductPost(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['archiveProduct']>>>> {
    return this.archiveProductPost(id, headers);
  }

  @Delete('admin/products/:id')
  async deleteAdminProductSoftArchive(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['archiveProduct']>>>> {
    return this.deleteProductSoftArchive(id, headers);
  }

  @Patch('admin/skus/:id')
  async updateAdminSku(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = UpdateAdminSkuSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid update SKU payload',
        details: { issues: parsed.error.issues },
      });
    }
    const { sku, product } = await this.catalog.updateAdminSku(id, parsed.data);
    return createApiResponse(
      {
        ...sku,
        productId: product.id,
        productSlug: product.slug,
        productMinPriceVnd: product.minPriceVnd,
        sku,
        product,
      },
      { correlationId, service: SERVICE_NAME },
    );
  }

  @Get('admin/submissions')
  async listAdminSubmissions(
    @Query() query: Record<string, unknown>,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['listAdminSubmissions']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const submissions = await this.catalog.listAdminSubmissions({
      status: typeof query.status === 'string' ? query.status : undefined,
      supplierId:
        typeof query.supplierId === 'string' ? query.supplierId : undefined,
    });
    return createApiResponse(submissions, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Patch('admin/submissions/:id/review')
  async reviewAdminSubmission(
    @Param('id') id: string,
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['reviewAdminSubmission']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = ReviewSubmissionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid submission review payload',
        details: { issues: parsed.error.issues },
      });
    }
    const reviewerId = extractHeader(headers, 'x-user-id');
    const updated = await this.catalog.reviewAdminSubmission(
      id,
      parsed.data,
      reviewerId,
    );
    return createApiResponse(updated, { correlationId, service: SERVICE_NAME });
  }

  // ==========================================================================
  // Partner Endpoints (Strict x-supplier-id Tenant Isolation)
  // ==========================================================================

  private requireSupplierId(headers: HeaderBag): string {
    const supplierId = extractHeader(headers, 'x-supplier-id');
    if (!supplierId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Missing required x-supplier-id tenant isolation header',
      });
    }
    return supplierId;
  }

  @Get('partner/submissions')
  async listPartnerSubmissions(
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['listPartnerSubmissions']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const supplierId = this.requireSupplierId(headers);
    const submissions = await this.catalog.listPartnerSubmissions(supplierId);
    return createApiResponse(submissions, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('partner/submissions/:id')
  async getPartnerSubmission(
    @Param('id') id: string,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['getPartnerSubmissionById']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const supplierId = this.requireSupplierId(headers);
    const submission = await this.catalog.getPartnerSubmissionById(
      supplierId,
      id,
    );
    return createApiResponse(submission, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('partner/submissions')
  @HttpCode(HttpStatus.CREATED)
  async createPartnerSubmission(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['createPartnerSubmission']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    const supplierId = this.requireSupplierId(headers);
    const parsed = PartnerSubmissionBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid partner product submission payload',
        details: { issues: parsed.error.issues },
      });
    }
    const created = await this.catalog.createPartnerSubmission(
      supplierId,
      parsed.data,
    );
    return createApiResponse(created, { correlationId, service: SERVICE_NAME });
  }

  // ==========================================================================
  // Internal Endpoints
  // ==========================================================================

  @Post('internal/reseed')
  @HttpCode(HttpStatus.OK)
  async reseed(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['seedAndSync']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    this.requireInternalSecret(headers);
    const summary = await this.catalog.seedAndSync(true);
    return createApiResponse(summary, { correlationId, service: SERVICE_NAME });
  }

  @Post('internal/skus/snapshot')
  @HttpCode(HttpStatus.OK)
  async skusSnapshot(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['getSkusSnapshot']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    this.requireInternalSecret(headers);
    const parsed = SkuSnapshotBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid SKU snapshot request payload',
        details: { issues: parsed.error.issues },
      });
    }
    const items = await this.catalog.getSkusSnapshot(parsed.data);
    return createApiResponse(items, { correlationId, service: SERVICE_NAME });
  }

  @Post('internal/media-processed')
  @HttpCode(HttpStatus.OK)
  async mediaProcessed(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['handleMediaProcessed']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    this.requireInternalSecret(headers);
    const parsed = MediaProcessedBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid media-processed hook payload',
        details: { issues: parsed.error.issues },
      });
    }
    const result = await this.catalog.handleMediaProcessed(parsed.data);
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Post('internal/fit-stats-updated')
  @HttpCode(HttpStatus.OK)
  async fitStatsUpdated(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['handleFitStatsUpdated']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    this.requireInternalSecret(headers);
    const parsed = FitStatsUpdatedBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid fit-stats-updated hook payload',
        details: { issues: parsed.error.issues },
      });
    }
    const result = await this.catalog.handleFitStatsUpdated(
      parsed.data.productId,
      parsed.data.fitStats,
    );
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }

  @Post('internal/stock-replenished')
  @HttpCode(HttpStatus.OK)
  async stockReplenished(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<
    ApiResponse<Awaited<ReturnType<CatalogService['handleStockReplenished']>>>
  > {
    const correlationId = getOrCreateCorrelationId(headers);
    this.requireInternalSecret(headers);
    const parsed = StockReplenishedBodySchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid stock-replenished payload',
        details: { issues: parsed.error.issues },
      });
    }
    const traceparent = getOrCreateTraceparent(headers);
    const result = await this.catalog.handleStockReplenished(
      parsed.data,
      correlationId,
      traceparent,
    );
    return createApiResponse(result, { correlationId, service: SERVICE_NAME });
  }
}
