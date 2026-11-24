import {
  BadRequestException,
  Body,
  Controller,
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
  FitTypeSchema,
  GenderSchema,
  ProductFitStatsDtoSchema,
  ProductStatusSchema,
  SizeCodeSchema,
  SizeRecommendRequestSchema,
  StretchLevelSchema,
  TryOnGarmentCategorySchema,
  UpdateHomepageCampaignSchema,
  VirtualModelCodeSchema,
  type ApiResponse,
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
  description: z.string().trim().min(2).max(4000).default('Thiết kế thủ công tại Tầm Xuân Atelier.'),
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
  occasionSlugs: z.array(z.string()).optional(),
  seasonSlugs: z.array(z.string()).optional(),
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
    if (!provided || provided !== this.config.infra.internalServiceSecret) {
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
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listOccasions']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.listOccasions();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
  }

  @Get('seasons')
  async listSeasons(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listSeasons']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const data = await this.catalog.listSeasons();
    return createApiResponse(data, { correlationId, service: SERVICE_NAME });
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

    const result = await this.catalog.listProducts({
      q: typeof query.q === 'string' ? query.q.trim() : undefined,
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
      page: parseOptionalInt(query.page) ?? 1,
      pageSize: parseOptionalInt(query.pageSize ?? query.limit) ?? 20,
      includeCostFields: false,
    });

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
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listCategories']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const categories = await this.catalog.listCategories();
    return createApiResponse(categories, { correlationId, service: SERVICE_NAME });
  }

  @Get('size-charts')
  async listSizeCharts(
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['listSizeCharts']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const charts = await this.catalog.listSizeCharts();
    return createApiResponse(charts, { correlationId, service: SERVICE_NAME });
  }

  @Post('size-recommend')
  @HttpCode(HttpStatus.OK)
  async recommendSize(
    @Body() body: unknown,
    @Headers() headers: HeaderBag,
  ): Promise<ApiResponse<Awaited<ReturnType<CatalogService['recommendSize']>>>> {
    const correlationId = getOrCreateCorrelationId(headers);
    const parsed = SizeRecommendRequestSchema.safeParse(body);
    if (!parsed.success) {
      throw new BadRequestException({
        code: ErrorCode.VALIDATION_ERROR,
        message: 'Invalid size recommendation request payload',
        details: { issues: parsed.error.issues },
      });
    }
    const recommendation = await this.catalog.recommendSize(parsed.data);
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
      categorySlug:
        typeof query.categorySlug === 'string'
          ? query.categorySlug.trim()
          : typeof query.category === 'string'
            ? query.category.trim()
            : undefined,
      status: statusParsed.success ? statusParsed.data : undefined,
      page: parseOptionalInt(query.page) ?? 1,
      pageSize: parseOptionalInt(query.pageSize ?? query.limit) ?? 50,
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
