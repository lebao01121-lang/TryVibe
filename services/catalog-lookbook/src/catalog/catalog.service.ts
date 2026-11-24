import { randomUUID } from 'node:crypto';
import {
  BadGatewayException,
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  ErrorCode,
  FitType,
  Gender,
  ProductStatus,
  SizeCode,
  StockStatusSummary,
  StretchLevel,
  SubmissionStatus,
  TryOnGarmentCategory,
  type AtelierStep,
  type CampaignFinale,
  type CampaignHero,
  type CampaignIntro,
  type CategoryDto,
  type HomepageCampaignDto,
  type OccasionLookbookDto,
  type OccasionLookbookItemDto,
  type PackagingOptionDto,
  type ProductFitStatsDto,
  type ProductSpuDto,
  type ProductVariantDto,
  type RackCollectionDto,
  type RackGarmentItemDto,
  type SeasonalCollectionDto,
  type SizeChartDto,
  type SizeMeasurementRow,
  type SizeRecommendRequest,
  type SizeRecommendResponse,
  type SkuDto,
  type StorefrontBootstrapDto,
  type SupplierProductSubmissionDto,
  type UpdateHomepageCampaignRequest,
  type VirtualModelCode,
} from '@atelier/contracts';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import {
  CATALOG_CONFIG_TOKEN,
  type CatalogLookbookConfig,
  SERVICE_NAME,
} from '../config/env';
import { CatalogDbService } from '../db/catalog-db.service';
import { MeilisearchService } from '../search/meilisearch.service';
import { resolveOccasionCutoutUrl } from '../occasions/occasion-cutout';
import { resolveOccasionMacroImageUrl } from '../occasions/occasion-macro';
import {
  hydrateSeasonCollectionDto,
  loadSeasonsManifestBySlug,
  type SeasonDbRow,
} from '../seasons/season-lookbook-data';
import { SeedAssetGenerator } from '../seed/asset-generator';
import {
  buildDefaultCampaignSections,
  buildSeedMediaRegistrationAssets,
  ensureCampaignSeeded,
  runCatalogSeed,
  type SeedSummary,
} from '../seed/catalog-seed';
import { computeHonestSizeRecommendation } from './size-recommender';

interface CategoryRow {
  id: string;
  parent_id: string | null;
  slug: string;
  name: string;
  description: string | null;
  sort_order: number;
  is_active: boolean;
}

interface SizeChartRow {
  id: string;
  code: string;
  name: string;
  gender: Gender;
  garment_group: string;
  fit_note: string | null;
  measurements_jsonb: SizeMeasurementRow[] | string;
}

interface ProductRow {
  id: string;
  category_id: string;
  category_slug: string;
  category_name: string;
  slug: string;
  name: string;
  subtitle: string | null;
  brand_name: string;
  description: string;
  fabric_composition: string;
  fit_type: FitType;
  stretch_level: StretchLevel;
  fabric_weight: number;
  gender: Gender;
  is_tryon_enabled: boolean;
  tryon_garment_category: TryOnGarmentCategory;
  tryon_flat_asset_url: string | null;
  fit_calibration_note: string | null;
  min_price_vnd: number;
  stock_status_summary: StockStatusSummary;
  status: ProductStatus;
  size_chart_id: string | null;
  occasion_slugs: string[] | string;
  season_slugs: string[] | string;
  fit_stats_jsonb?: ProductFitStatsDto | string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface VariantRow {
  id: string;
  product_id: string;
  color_name: string;
  color_hex: string;
  lookbook_main_url: string | null;
  rack_front_asset_id: string | null;
  rack_back_asset_id: string | null;
  studio_layer_asset_id: string | null;
  tryon_flat_preview_url: string | null;
  rack_front_url: string | null;
  rack_back_url: string | null;
  studio_layer_url: string | null;
  layer_spec_jsonb: Record<string, unknown> | string | null;
}

interface SkuRow {
  id: string;
  variant_id: string;
  sku_code: string;
  size_code: SizeCode;
  base_price_vnd: number;
  sale_price_vnd: number | null;
  cost_price_vnd: number;
  supplier_id: string | null;
  weight_grams: number;
  in_stock: boolean;
  is_returnable: boolean;
}

interface SubmissionRow {
  id: string;
  supplier_id: string;
  proposed_name: string;
  category_slug: string;
  wholesale_price_vnd: number;
  suggested_retail_vnd: number;
  fabric_composition: string;
  available_sizes_jsonb: SizeCode[] | string;
  color_name: string;
  color_hex: string;
  asset_ids_jsonb: string[] | string;
  raw_size_spec_jsonb: Record<string, unknown> | string;
  flat_asset_url: string | null;
  rack_asset_url: string | null;
  notes: string | null;
  status: SubmissionStatus;
  reviewer_id: string | null;
  review_note: string | null;
  reviewed_at: Date | string | null;
  created_product_id: string | null;
  created_at: Date | string;
  updated_at: Date | string;
}

interface HomepageCampaignRow {
  id: string;
  slug: string;
  eyebrow: string;
  hero_title: string;
  hero_subtitle: string;
  atelier_manifesto: string;
  cta_label: string;
  service_note: string;
  privacy_guarantee_minutes: number;
  hero_image_url: string | null;
  intro_jsonb: CampaignIntro | string | null;
  hero_jsonb: CampaignHero | string | null;
  atelier_steps_jsonb: AtelierStep[] | string | null;
  finale_jsonb: CampaignFinale | string | null;
  is_active: boolean;
  updated_at: Date | string;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function parseJsonField<T>(raw: T | string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw;
}

function toIsoString(val: Date | string | null | undefined): string {
  if (!val) {
    return new Date().toISOString();
  }
  return val instanceof Date ? val.toISOString() : String(val);
}

function foldVietnamese(input: string): string {
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'd')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyVietnamese(input: string): string {
  return foldVietnamese(input)
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 72);
}

function stripSensitiveProductFields(product: ProductSpuDto): ProductSpuDto {
  return {
    ...product,
    variants: product.variants.map((variant) => ({
      ...variant,
      skus: variant.skus.map((sku) => {
        const cleanSku: SkuDto = {
          id: sku.id,
          variantId: sku.variantId,
          skuCode: sku.skuCode,
          sizeCode: sku.sizeCode,
          basePriceVnd: sku.basePriceVnd,
          salePriceVnd: sku.salePriceVnd,
          weightGrams: sku.weightGrams,
          inStock: sku.inStock,
          isReturnable: sku.isReturnable,
        };
        return cleanSku;
      }),
    })),
  };
}

export interface ProductListFilters {
  q?: string;
  categorySlug?: string;
  size?: string;
  inStockSize?: string;
  color?: string;
  occasion?: string;
  season?: string;
  gender?: string;
  isTryonEnabled?: boolean;
  minPriceVnd?: number;
  maxPriceVnd?: number;
  sort?: string;
  status?: ProductStatus;
  page?: number;
  pageSize?: number;
  includeCostFields?: boolean;
}

export interface ProductListResult {
  items: ProductSpuDto[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  usedMeilisearch: boolean;
  processingTimeMs: number;
}

export interface CreateAdminProductInput {
  categoryId?: string;
  categorySlug?: string;
  slug?: string;
  name: string;
  subtitle?: string | null;
  brandName?: string;
  description: string;
  fabricComposition: string;
  fitType?: FitType;
  stretchLevel?: StretchLevel;
  fabricWeight?: number | string;
  gender?: Gender;
  isTryonEnabled?: boolean;
  tryonGarmentCategory?: TryOnGarmentCategory;
  tryonFlatAssetUrl?: string | null;
  fitCalibrationNote?: string | null;
  status?: ProductStatus;
  sizeChartId?: string | null;
  occasionSlugs?: string[];
  seasonSlugs?: string[];
  variants?: Array<{
    colorName: string;
    colorHex: string;
    lookbookMainUrl?: string | null;
    tryonFlatPreviewUrl?: string | null;
    rackFrontUrl?: string | null;
    skus?: Array<{
      skuCode?: string;
      sizeCode: SizeCode;
      basePriceVnd: number;
      salePriceVnd?: number | null;
      costPriceVnd?: number;
      supplierId?: string | null;
      weightGrams?: number;
      inStock?: boolean;
      isReturnable?: boolean;
    }>;
  }>;
}

export interface UpdateAdminProductInput {
  categoryId?: string;
  categorySlug?: string;
  name?: string;
  subtitle?: string | null;
  description?: string;
  fabricComposition?: string;
  fitType?: FitType;
  stretchLevel?: StretchLevel;
  fabricWeight?: number | string;
  gender?: Gender;
  isTryonEnabled?: boolean;
  tryonGarmentCategory?: TryOnGarmentCategory;
  tryonFlatAssetUrl?: string | null;
  fitCalibrationNote?: string | null;
  status?: ProductStatus;
  occasionSlugs?: string[];
  seasonSlugs?: string[];
}

export interface UpdateAdminSkuInput {
  basePriceVnd?: number;
  salePriceVnd?: number | null;
  costPriceVnd?: number;
  inStock?: boolean;
  weightGrams?: number;
  isReturnable?: boolean;
}

export interface CreatePartnerSubmissionInput {
  proposedName: string;
  proposedCategorySlug?: string;
  categorySlug?: string;
  fabricComposition: string;
  wholesaleCostVnd?: number;
  wholesalePriceVnd?: number;
  suggestedRetailVnd: number;
  availableSizes?: SizeCode[];
  colorName?: string;
  colorHex?: string;
  assetIds?: string[];
  rawSizeSpec?: Record<string, unknown>;
  flatAssetUrl?: string | null;
  rackAssetUrl?: string | null;
  notes?: string | null;
}

export interface ReviewSubmissionInput {
  decision?: 'APPROVED' | 'REJECTED';
  status?: 'APPROVED' | 'REJECTED';
  reviewComment?: string;
  reviewNote?: string;
}

export interface MediaProcessedHookInput {
  assetId: string;
  productId?: string;
  variantId?: string;
  assetType?: 'RACK_CUTOUT_2_3' | 'TRYON_FLAT_3_4' | 'LOOKBOOK' | 'STUDIO_LAYER';
  publicUrl?: string;
  flatAssetUrl?: string;
  rackFrontUrl?: string;
  rackBackUrl?: string;
  studioLayerUrl?: string;
  spatialMetadata?: Record<string, unknown>;
}

export interface LookbookStudioSessionView {
  id: string;
  productId: string;
  variantId: string | null;
  virtualModelCode: VirtualModelCode;
  scenePrompt: string;
  sourceGarmentUrl: string | null;
  resultUrl: string;
  bucket: string;
  objectKey: string;
  providerUsed: string;
  width: number;
  height: number;
  status: 'GENERATED' | 'ATTACHED';
  approvedForGallery: boolean;
  attachedAt: string | null;
  createdByUserId: string | null;
  createdAt: string;
  completedAt: string | null;
}

export interface StockReplenishedItemInput {
  skuId?: string;
  skuCode?: string;
  productId?: string;
  availableQty?: number;
}

export interface StockReplenishedInput {
  skuIds?: string[];
  productIds?: string[];
  items?: StockReplenishedItemInput[];
}

interface LookbookSessionRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  virtual_model_code: VirtualModelCode;
  scene_prompt: string;
  source_garment_url: string | null;
  result_url: string;
  object_key: string;
  provider_used: string;
  status: string;
  attached_at: Date | string | null;
  created_by: string | null;
  created_at: Date | string;
}

interface ProductMediaRow {
  id: string;
  product_id: string;
  variant_id: string | null;
  media_type: string;
  url: string;
  object_key: string | null;
  source_session_id: string | null;
  sort_order: number;
  created_at: Date | string;
}

@Injectable()
export class CatalogService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:catalog`);
  private readonly redisClient: AtelierRedisClient;
  private lastSeedSummary: SeedSummary | null = null;
  private seedAssetsRegistered = false;

  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    private readonly config: CatalogLookbookConfig,
    private readonly dbService: CatalogDbService,
    private readonly meili: MeilisearchService,
  ) {
    this.redisClient = createRedisClient({ url: this.config.infra.redisUrl });
  }

  async onModuleInit(): Promise<void> {
    await this.seedAndSync(false);
    // Non-blocking seed asset registration with media-pipeline (retried lazily on rack-showcase if media boots later)
    void this.registerSeedAssetsWithMediaPipeline();
  }

  async onModuleDestroy(): Promise<void> {
    await this.redisClient.quit();
  }

  public getLastSeedSummary(): SeedSummary | null {
    return this.lastSeedSummary;
  }

  private async fetchJsonWithTimeout<T>(
    url: string,
    options: { method?: string; body?: unknown; timeoutMs?: number } = {},
  ): Promise<T | null> {
    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      options.timeoutMs ?? 1500,
    );
    try {
      const res = await fetch(url, {
        method: options.method ?? 'GET',
        headers:
          options.body !== undefined
            ? { 'Content-Type': 'application/json', Accept: 'application/json' }
            : { Accept: 'application/json' },
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
        signal: controller.signal,
      });
      if (!res.ok) {
        return null;
      }
      return (await res.json()) as T;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  public async registerSeedAssetsWithMediaPipeline(): Promise<boolean> {
    if (this.seedAssetsRegistered) {
      return true;
    }
    const assets = buildSeedMediaRegistrationAssets(this.config);
    const res = await this.fetchJsonWithTimeout<{ success?: boolean }>(
      `${this.config.infra.mediaServiceUrl}/v1/media/internal/register-seed-assets`,
      {
        method: 'POST',
        body: { assets },
        timeoutMs: 2000,
      },
    );
    if (res && res.success !== false) {
      this.seedAssetsRegistered = true;
      this.logger.info(
        { count: assets.length },
        'Registered seeded 2:3 rack cutout assets with media-pipeline',
      );
      return true;
    }
    return false;
  }

  private async fetchMediaSpatialMap(): Promise<
    Record<string, { hangerAnchorX: number; hangerAnchorY: number }>
  > {
    if (!this.seedAssetsRegistered) {
      await this.registerSeedAssetsWithMediaPipeline();
    }
    const res = await this.fetchJsonWithTimeout<{
      data?: Record<string, { hangerAnchorX?: number; hangerAnchorY?: number }>;
    }>(`${this.config.infra.mediaServiceUrl}/v1/media/internal/spatial-map`, {
      timeoutMs: 1200,
    });
    const raw = res?.data;
    if (!raw || typeof raw !== 'object') {
      return {};
    }
    const out: Record<string, { hangerAnchorX: number; hangerAnchorY: number }> =
      {};
    for (const [assetId, meta] of Object.entries(raw)) {
      if (meta && typeof meta === 'object') {
        const x = Number(meta.hangerAnchorX);
        const y = Number(meta.hangerAnchorY);
        if (Number.isFinite(x) && Number.isFinite(y)) {
          out[assetId] = { hangerAnchorX: x, hangerAnchorY: y };
        }
      }
    }
    return out;
  }

  private async fetchLiveFitStatsForProduct(
    productId: string,
  ): Promise<ProductFitStatsDto | null> {
    const res = await this.fetchJsonWithTimeout<{
      data?: { fitStats?: ProductFitStatsDto };
    }>(
      `${this.config.infra.notifyReviewServiceUrl}/v1/reviews/products/${encodeURIComponent(productId)}`,
      { timeoutMs: 1500 },
    );
    const stats = res?.data?.fitStats;
    if (stats && typeof stats.totalReviews === 'number') {
      const db = await this.dbService.getClient();
      await db
        .query('UPDATE products SET fit_stats_jsonb = $2::jsonb WHERE id = $1', [
          productId,
          JSON.stringify(stats),
        ])
        .catch(() => undefined);
      return stats;
    }
    return null;
  }

  private async fetchLiveFitStatsBatch(
    productIds: readonly string[],
  ): Promise<Record<string, ProductFitStatsDto>> {
    if (productIds.length === 0) {
      return {};
    }
    const qs = encodeURIComponent(productIds.join(','));
    const res = await this.fetchJsonWithTimeout<{
      data?: Record<string, ProductFitStatsDto>;
    }>(
      `${this.config.infra.notifyReviewServiceUrl}/v1/reviews/stats/batch?productIds=${qs}`,
      { timeoutMs: 1500 },
    );
    if (res?.data && typeof res.data === 'object') {
      return res.data;
    }
    return {};
  }

  private async loadStoredFitStatsMap(
    productIds: readonly string[],
  ): Promise<Map<string, ProductFitStatsDto>> {
    const map = new Map<string, ProductFitStatsDto>();
    if (productIds.length === 0) {
      return map;
    }
    const db = await this.dbService.getClient();
    const res = await db.query<{
      id: string;
      fit_stats_jsonb: ProductFitStatsDto | string | null;
    }>('SELECT id, fit_stats_jsonb FROM products WHERE id = ANY($1::uuid[])', [
      productIds,
    ]);
    for (const row of res.rows) {
      const parsed = parseJsonField<ProductFitStatsDto | null>(
        row.fit_stats_jsonb,
        null,
      );
      if (parsed) {
        map.set(row.id, parsed);
      }
    }
    return map;
  }

  public async seedAndSync(force = false): Promise<SeedSummary> {
    const db = await this.dbService.getClient();
    const summary = await runCatalogSeed(db, this.config, { force });
    this.lastSeedSummary = summary;

    const published = await this.loadProductsByWhere(
      'p.status = $1',
      [ProductStatus.PUBLISHED],
      false,
    );
    const synced = await this.meili.syncProducts(published);

    this.logger.info(
      {
        ...summary,
        meilisearchSynced: synced,
        syncedProducts: published.length,
      },
      'Catalog seed and Meilisearch sync completed',
    );
    return summary;
  }

  public async listCategories(): Promise<CategoryDto[]> {
    const db = await this.dbService.getClient();
    const res = await db.query<CategoryRow>(
      `SELECT id, parent_id, slug, name, description, sort_order, is_active
       FROM categories
       ORDER BY sort_order ASC, name ASC`,
    );
    return res.rows.map((row) => ({
      id: row.id,
      parentId: row.parent_id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      sortOrder: Number(row.sort_order),
      isActive: Boolean(row.is_active),
    }));
  }

  public async listSizeCharts(): Promise<SizeChartDto[]> {
    const db = await this.dbService.getClient();
    const res = await db.query<SizeChartRow>(
      `SELECT id, code, name, gender, garment_group, fit_note, measurements_jsonb
       FROM size_charts
       ORDER BY code ASC`,
    );
    return res.rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      gender: row.gender,
      garmentCategory: row.garment_group,
      fitNote: row.fit_note,
      rows: parseJsonField<SizeMeasurementRow[]>(row.measurements_jsonb, []),
    }));
  }

  private async loadSizeChartMap(): Promise<Map<string, SizeChartDto>> {
    const charts = await this.listSizeCharts();
    const map = new Map<string, SizeChartDto>();
    for (const c of charts) {
      map.set(c.id, c);
    }
    return map;
  }

  private async hydrateProducts(
    productRows: ProductRow[],
    includeCostFields: boolean,
  ): Promise<ProductSpuDto[]> {
    if (productRows.length === 0) {
      return [];
    }

    const db = await this.dbService.getClient();
    const productIds = productRows.map((p) => p.id);
    const sizeChartMap = await this.loadSizeChartMap();

    const variantRes = await db.query<VariantRow>(
      `SELECT id, product_id, color_name, color_hex, lookbook_main_url,
              rack_front_asset_id, rack_back_asset_id, studio_layer_asset_id,
              tryon_flat_preview_url, rack_front_url, rack_back_url, studio_layer_url,
              layer_spec_jsonb
       FROM product_variants
       WHERE product_id = ANY($1::uuid[])
       ORDER BY
         CASE
           WHEN COALESCE(lookbook_main_url, '') ~ '-v[0-9]+-lookbook' THEN 1
           ELSE 0
         END ASC,
         COALESCE(lookbook_main_url, '') ASC,
         id ASC`,
      [productIds],
    );

    const variantIds = variantRes.rows.map((v) => v.id);
    const skuRes =
      variantIds.length > 0
        ? await db.query<SkuRow>(
            `SELECT id, variant_id, sku_code, size_code, base_price_vnd, sale_price_vnd,
                    cost_price_vnd, supplier_id, weight_grams, in_stock, is_returnable
             FROM skus
             WHERE variant_id = ANY($1::uuid[])
             ORDER BY sku_code ASC`,
            [variantIds],
          )
        : { rows: [] as SkuRow[] };

    const skusByVariant = new Map<string, SkuDto[]>();
    for (const skuRow of skuRes.rows) {
      const effectiveSale =
        skuRow.sale_price_vnd !== null && skuRow.sale_price_vnd !== undefined
          ? Number(skuRow.sale_price_vnd)
          : Number(skuRow.base_price_vnd);
      const dto: SkuDto = {
        id: skuRow.id,
        variantId: skuRow.variant_id,
        skuCode: skuRow.sku_code,
        sizeCode: skuRow.size_code,
        basePriceVnd: Number(skuRow.base_price_vnd),
        salePriceVnd: effectiveSale,
        weightGrams: Number(skuRow.weight_grams),
        inStock: Boolean(skuRow.in_stock),
        isReturnable: Boolean(skuRow.is_returnable),
      };
      if (includeCostFields) {
        dto.costPriceVnd = Number(skuRow.cost_price_vnd);
        dto.supplierId = skuRow.supplier_id;
      }
      const list = skusByVariant.get(skuRow.variant_id) ?? [];
      list.push(dto);
      skusByVariant.set(skuRow.variant_id, list);
    }

    const variantsByProduct = new Map<string, ProductVariantDto[]>();
    for (const vRow of variantRes.rows) {
      const dto: ProductVariantDto = {
        id: vRow.id,
        productId: vRow.product_id,
        colorName: vRow.color_name,
        colorHex: vRow.color_hex,
        lookbookMainUrl: vRow.lookbook_main_url,
        rackFrontAssetId: vRow.rack_front_asset_id,
        rackBackAssetId: vRow.rack_back_asset_id,
        studioLayerAssetId: vRow.studio_layer_asset_id,
        tryonFlatPreviewUrl: vRow.tryon_flat_preview_url,
        rackFrontUrl: vRow.rack_front_url,
        rackBackUrl: vRow.rack_back_url,
        studioLayerUrl: vRow.studio_layer_url,
        layerSpecJsonb: parseJsonField<Record<string, unknown> | null>(
          vRow.layer_spec_jsonb,
          null,
        ),
        skus: skusByVariant.get(vRow.id) ?? [],
      };
      const list = variantsByProduct.get(vRow.product_id) ?? [];
      list.push(dto);
      variantsByProduct.set(vRow.product_id, list);
    }

    const mediaRes = await db.query<ProductMediaRow>(
      `SELECT id, product_id, variant_id, media_type, url, object_key,
              source_session_id, sort_order, created_at
       FROM product_media
       WHERE product_id = ANY($1::uuid[])
       ORDER BY sort_order ASC, created_at DESC`,
      [productIds],
    );
    const mediaByProduct = new Map<
      string,
      Array<{
        id: string;
        variantId: string | null;
        mediaType: string;
        url: string;
        objectKey: string | null;
        sourceSessionId: string | null;
        sortOrder: number;
        createdAt: string;
      }>
    >();
    for (const mRow of mediaRes.rows) {
      const list = mediaByProduct.get(mRow.product_id) ?? [];
      list.push({
        id: mRow.id,
        variantId: mRow.variant_id,
        mediaType: mRow.media_type,
        url: mRow.url,
        objectKey: mRow.object_key,
        sourceSessionId: mRow.source_session_id,
        sortOrder: Number(mRow.sort_order),
        createdAt: toIsoString(mRow.created_at),
      });
      mediaByProduct.set(mRow.product_id, list);
    }

    return productRows.map((pRow) => ({
      id: pRow.id,
      categoryId: pRow.category_id,
      categorySlug: pRow.category_slug,
      categoryName: pRow.category_name,
      slug: pRow.slug,
      name: pRow.name,
      subtitle: pRow.subtitle,
      brandName: pRow.brand_name,
      description: pRow.description,
      fabricComposition: pRow.fabric_composition,
      fitType: pRow.fit_type,
      stretchLevel: pRow.stretch_level,
      fabricWeight: `${Number(pRow.fabric_weight)}gsm`,
      gender: pRow.gender,
      isTryonEnabled: Boolean(pRow.is_tryon_enabled),
      tryonGarmentCategory: pRow.tryon_garment_category,
      tryonFlatAssetUrl: pRow.tryon_flat_asset_url,
      fitCalibrationNote: pRow.fit_calibration_note,
      minPriceVnd: Number(pRow.min_price_vnd),
      stockStatusSummary: pRow.stock_status_summary,
      status: pRow.status,
      sizeChartId: pRow.size_chart_id,
      sizeChart: pRow.size_chart_id
        ? (sizeChartMap.get(pRow.size_chart_id) ?? null)
        : null,
      occasionSlugs: parseJsonField<string[]>(pRow.occasion_slugs, []),
      seasonSlugs: parseJsonField<string[]>(pRow.season_slugs, []),
      variants: variantsByProduct.get(pRow.id) ?? [],
      galleryImages: mediaByProduct.get(pRow.id) ?? [],
      createdAt: toIsoString(pRow.created_at),
      updatedAt: toIsoString(pRow.updated_at),
    }));
  }

  private async loadProductsByWhere(
    whereClause: string,
    params: unknown[],
    includeCostFields: boolean,
  ): Promise<ProductSpuDto[]> {
    const db = await this.dbService.getClient();
    const sql = `
      SELECT p.id, p.category_id, c.slug AS category_slug, c.name AS category_name,
             p.slug, p.name, p.subtitle, p.brand_name, p.description,
             p.fabric_composition, p.fit_type, p.stretch_level, p.fabric_weight,
             p.gender, p.is_tryon_enabled, p.tryon_garment_category, p.tryon_flat_asset_url,
             p.fit_calibration_note, p.min_price_vnd, p.stock_status_summary, p.status,
             p.size_chart_id, p.occasion_slugs, p.season_slugs, p.created_at, p.updated_at
      FROM products p
      JOIN categories c ON c.id = p.category_id
      ${whereClause ? `WHERE ${whereClause}` : ''}
      ORDER BY p.created_at DESC, p.name ASC
    `;
    const res = await db.query<ProductRow>(sql, params);
    return this.hydrateProducts(res.rows, includeCostFields);
  }

  public async listProducts(
    filters: ProductListFilters,
  ): Promise<ProductListResult> {
    const startedAt = Date.now();
    const page = Math.max(1, filters.page ?? 1);
    const pageSize = Math.min(50, Math.max(1, filters.pageSize ?? 20));
    const offset = (page - 1) * pageSize;
    const includeCostFields = Boolean(filters.includeCostFields);
    const statusFilter = filters.status ?? (includeCostFields ? undefined : ProductStatus.PUBLISHED);

    // Try Meilisearch first whenever search query or storefront faceted filtering is used
    const shouldUseMeili = Boolean(
      filters.q?.trim() ||
        (!includeCostFields &&
          (filters.categorySlug ||
            filters.size ||
            filters.inStockSize ||
            filters.color ||
            filters.occasion ||
            filters.season ||
            filters.isTryonEnabled !== undefined)),
    );

    if (shouldUseMeili) {
      const meiliResult = await this.meili.searchProducts({
        q: filters.q,
        categorySlug: filters.categorySlug,
        size: filters.size,
        inStockSize: filters.inStockSize,
        color: filters.color,
        occasion: filters.occasion,
        season: filters.season,
        gender: filters.gender,
        isTryonEnabled: filters.isTryonEnabled,
        minPriceVnd: filters.minPriceVnd,
        maxPriceVnd: filters.maxPriceVnd,
        status: statusFilter,
        sort: filters.sort,
        limit: pageSize,
        offset,
      });

      if (meiliResult.usedMeilisearch) {
        if (meiliResult.hitIds.length === 0) {
          return {
            items: [],
            total: 0,
            page,
            pageSize,
            totalPages: 1,
            usedMeilisearch: true,
            processingTimeMs: meiliResult.processingTimeMs,
          };
        }

        const hydrated = await this.loadProductsByWhere(
          'p.id = ANY($1::uuid[])',
          [meiliResult.hitIds],
          includeCostFields,
        );
        const byId = new Map(hydrated.map((p) => [p.id, p]));
        const ordered = meiliResult.hitIds
          .map((id) => byId.get(id))
          .filter((p): p is ProductSpuDto => p !== undefined)
          .map((p) => (includeCostFields ? p : stripSensitiveProductFields(p)));

        return {
          items: ordered,
          total: meiliResult.totalHits,
          page,
          pageSize,
          totalPages: Math.max(1, Math.ceil(meiliResult.totalHits / pageSize)),
          usedMeilisearch: true,
          processingTimeMs: meiliResult.processingTimeMs,
        };
      }
    }

    // Direct PostgreSQL fallback (full Vietnamese accent-insensitive filtering)
    const all = await this.loadProductsByWhere(
      statusFilter ? 'p.status = $1' : '',
      statusFilter ? [statusFilter] : [],
      includeCostFields,
    );

    const foldedQ = filters.q ? foldVietnamese(filters.q) : '';
    const filtered = all.filter((prod) => {
      if (filters.categorySlug && prod.categorySlug !== filters.categorySlug) {
        return false;
      }
      if (filters.gender && prod.gender !== filters.gender.toUpperCase()) {
        return false;
      }
      if (
        filters.isTryonEnabled !== undefined &&
        prod.isTryonEnabled !== filters.isTryonEnabled
      ) {
        return false;
      }
      if (
        filters.minPriceVnd !== undefined &&
        prod.minPriceVnd < filters.minPriceVnd
      ) {
        return false;
      }
      if (
        filters.maxPriceVnd !== undefined &&
        prod.minPriceVnd > filters.maxPriceVnd
      ) {
        return false;
      }
      if (filters.occasion && !prod.occasionSlugs.includes(filters.occasion)) {
        return false;
      }
      if (filters.season && !prod.seasonSlugs.includes(filters.season)) {
        return false;
      }
      if (filters.size) {
        const want = filters.size.toUpperCase();
        const hasSize = prod.variants.some((v) =>
          v.skus.some((s) => s.sizeCode === want),
        );
        if (!hasSize) return false;
      }
      if (filters.inStockSize) {
        const want = filters.inStockSize.toUpperCase();
        const hasStock = prod.variants.some((v) =>
          v.skus.some((s) => s.sizeCode === want && s.inStock),
        );
        if (!hasStock) return false;
      }
      if (filters.color) {
        const wantColor = foldVietnamese(filters.color);
        const hasColor = prod.variants.some((v) =>
          foldVietnamese(v.colorName).includes(wantColor),
        );
        if (!hasColor) return false;
      }
      if (foldedQ) {
        const haystack = foldVietnamese(
          `${prod.name} ${prod.subtitle ?? ''} ${prod.categoryName} ${prod.fabricComposition} ${prod.description}`,
        );
        const tokens = foldedQ.split(' ').filter(Boolean);
        const synonymsFallback =
          foldedQ.includes('vay di tiec') && haystack.includes('dam du tiec');
        if (
          !synonymsFallback &&
          !tokens.every((tok) => haystack.includes(tok))
        ) {
          return false;
        }
      }
      return true;
    });

    if (filters.sort === 'price_asc' || filters.sort === 'minPriceVnd:asc') {
      filtered.sort((a, b) => a.minPriceVnd - b.minPriceVnd);
    } else if (
      filters.sort === 'price_desc' ||
      filters.sort === 'minPriceVnd:desc'
    ) {
      filtered.sort((a, b) => b.minPriceVnd - a.minPriceVnd);
    }

    const total = filtered.length;
    const pageItems = filtered
      .slice(offset, offset + pageSize)
      .map((p) => (includeCostFields ? p : stripSensitiveProductFields(p)));

    return {
      items: pageItems,
      total,
      page,
      pageSize,
      totalPages: Math.max(1, Math.ceil(total / pageSize)),
      usedMeilisearch: false,
      processingTimeMs: Date.now() - startedAt,
    };
  }

  public async getProductBySlug(
    slug: string,
    includeCostFields = false,
  ): Promise<ProductSpuDto> {
    const where = includeCostFields
      ? 'p.slug = $1'
      : 'p.slug = $1 AND p.status = $2';
    const params = includeCostFields ? [slug] : [slug, ProductStatus.PUBLISHED];
    const products = await this.loadProductsByWhere(
      where,
      params,
      includeCostFields,
    );
    if (products.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Product "${slug}" not found`,
      });
    }
    return includeCostFields
      ? products[0]
      : stripSensitiveProductFields(products[0]);
  }

  public async getAdminProductByIdOrSlug(
    idOrSlug: string,
  ): Promise<ProductSpuDto> {
    const isUuid = UUID_REGEX.test(idOrSlug);
    const products = await this.loadProductsByWhere(
      isUuid ? 'p.id = $1' : 'p.slug = $1',
      [idOrSlug],
      true,
    );
    if (products.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Product "${idOrSlug}" not found`,
      });
    }
    return products[0];
  }

  private mapHomepageCampaignRow(row: HomepageCampaignRow): HomepageCampaignDto {
    const assetGen = new SeedAssetGenerator(this.config);
    const defaults = buildDefaultCampaignSections(
      assetGen.getCampaignEditorialUrls(),
    );

    const parsedIntro = parseJsonField<Partial<CampaignIntro> | null>(
      row.intro_jsonb,
      null,
    );
    const parsedHero = parseJsonField<Partial<CampaignHero> | null>(
      row.hero_jsonb,
      null,
    );
    const parsedSteps = parseJsonField<AtelierStep[] | null>(
      row.atelier_steps_jsonb,
      null,
    );
    const parsedFinale = parseJsonField<Partial<CampaignFinale> | null>(
      row.finale_jsonb,
      null,
    );

    const intro: CampaignIntro = {
      ...defaults.intro,
      ...(parsedIntro ?? {}),
    };

    const sanitizeMediaUrl = (url: string | null | undefined): string | null => {
      if (!url) {
        return null;
      }
      const trimmed = url.trim();
      if (
        trimmed.startsWith('http://') ||
        trimmed.startsWith('https://') ||
        trimmed.startsWith('/media/atelier-')
      ) {
        return trimmed;
      }
      return null;
    };

    const mergedHeroRaw: CampaignHero = {
      ...defaults.hero,
      eyebrow: row.eyebrow || defaults.hero.eyebrow,
      title: row.hero_title || defaults.hero.title,
      lead: row.hero_subtitle || defaults.hero.lead,
      primaryCtaLabel: row.cta_label || defaults.hero.primaryCtaLabel,
      serviceNote: row.service_note || defaults.hero.serviceNote,
      posterUrl: row.hero_image_url || defaults.hero.posterUrl,
      ...(parsedHero ?? {}),
    };

    const hero: CampaignHero = {
      ...mergedHeroRaw,
      videoWebmUrl: sanitizeMediaUrl(mergedHeroRaw.videoWebmUrl),
      videoMp4Url: sanitizeMediaUrl(mergedHeroRaw.videoMp4Url),
    };

    const atelierSteps: AtelierStep[] =
      Array.isArray(parsedSteps) && parsedSteps.length > 0
        ? [...parsedSteps].sort((a, b) => a.stepOrder - b.stepOrder)
        : defaults.atelierSteps;

    const finale: CampaignFinale = {
      ...defaults.finale,
      ...(parsedFinale ?? {}),
      featuredVoices:
        parsedFinale?.featuredVoices && parsedFinale.featuredVoices.length > 0
          ? parsedFinale.featuredVoices
          : defaults.finale.featuredVoices,
    };

    return {
      id: row.id,
      code: row.slug,
      slug: row.slug,
      eyebrow: hero.eyebrow,
      title: hero.title,
      subtitle: hero.lead,
      heroTitle: hero.title,
      heroSubtitle: hero.lead,
      atelierManifesto: row.atelier_manifesto || defaults.atelierManifesto,
      privacyGuaranteeMinutes: Number(row.privacy_guarantee_minutes ?? 15),
      heroImageUrl: hero.posterUrl,
      heroVideoUrl: hero.videoWebmUrl ?? null,
      heroPosterUrl: hero.posterUrl,
      ctaLabel: hero.primaryCtaLabel,
      serviceNote: hero.serviceNote,
      isActive: Boolean(row.is_active),
      updatedAt: toIsoString(row.updated_at),
      intro,
      hero,
      atelierSteps,
      finale,
    };
  }

  public async getHomepageCampaign(): Promise<HomepageCampaignDto> {
    const db = await this.dbService.getClient();
    let res = await db.query<HomepageCampaignRow>(
      'SELECT * FROM homepage_campaigns WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
    );
    if (res.rows.length === 0) {
      await ensureCampaignSeeded(db, this.config, false);
      res = await db.query<HomepageCampaignRow>(
        'SELECT * FROM homepage_campaigns WHERE is_active = TRUE ORDER BY updated_at DESC LIMIT 1',
      );
    }
    if (res.rows.length === 0) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: 'Active homepage campaign not found',
      });
    }
    return this.mapHomepageCampaignRow(res.rows[0]);
  }

  public async updateHomepageCampaign(
    input: UpdateHomepageCampaignRequest,
  ): Promise<HomepageCampaignDto> {
    const current = await this.getHomepageCampaign();
    const db = await this.dbService.getClient();

    const assetGen = new SeedAssetGenerator(this.config);
    const defaults = buildDefaultCampaignSections(
      assetGen.getCampaignEditorialUrls(),
    );

    const baseIntro = current.intro ?? defaults.intro;
    const nextIntro: CampaignIntro = {
      ...baseIntro,
      ...(input.intro ?? {}),
      ...(input.tagline ? { tagline: input.tagline } : {}),
    };

    const baseHero = current.hero ?? defaults.hero;
    const nextEyebrow = input.hero?.eyebrow ?? input.eyebrow ?? baseHero.eyebrow;
    const nextTitle =
      input.hero?.title ?? input.heroTitle ?? input.title ?? baseHero.title;
    const nextLead =
      input.hero?.lead ?? input.heroSubtitle ?? input.subtitle ?? baseHero.lead;
    const nextCtaLabel =
      input.hero?.primaryCtaLabel ?? input.ctaLabel ?? baseHero.primaryCtaLabel;
    const nextServiceNote =
      input.hero?.serviceNote ?? input.serviceNote ?? baseHero.serviceNote;
    const nextPosterUrl =
      input.hero?.posterUrl ??
      input.heroPosterUrl ??
      input.heroImageUrl ??
      baseHero.posterUrl;
    const nextVideoWebm =
      input.hero?.videoWebmUrl !== undefined
        ? input.hero.videoWebmUrl
        : input.heroVideoUrl !== undefined
          ? input.heroVideoUrl
          : baseHero.videoWebmUrl;

    const nextHero: CampaignHero = {
      ...baseHero,
      ...(input.hero ?? {}),
      eyebrow: nextEyebrow,
      title: nextTitle,
      lead: nextLead,
      primaryCtaLabel: nextCtaLabel,
      serviceNote: nextServiceNote,
      posterUrl: nextPosterUrl,
      videoWebmUrl: nextVideoWebm,
    };

    const baseSteps = current.atelierSteps ?? defaults.atelierSteps;
    let nextSteps: AtelierStep[] = baseSteps;
    if (input.atelierSteps && input.atelierSteps.length > 0) {
      if (input.atelierSteps.length === 1 && baseSteps.length > 1) {
        const incoming = input.atelierSteps[0];
        const exists = baseSteps.some((s) => s.stepOrder === incoming.stepOrder);
        nextSteps = exists
          ? baseSteps.map((s) =>
              s.stepOrder === incoming.stepOrder ? incoming : s,
            )
          : [...baseSteps, incoming];
      } else {
        nextSteps = [...input.atelierSteps];
      }
      nextSteps = nextSteps.sort((a, b) => a.stepOrder - b.stepOrder);
    }

    const baseFinale = current.finale ?? defaults.finale;
    const nextFinale: CampaignFinale = {
      ...baseFinale,
      ...(input.finale ?? {}),
      featuredVoices:
        input.finale?.featuredVoices ?? baseFinale.featuredVoices,
    };

    const nextManifesto =
      input.atelierManifesto ??
      current.atelierManifesto ??
      defaults.atelierManifesto;
    const nextPrivacyMin =
      input.privacyGuaranteeMinutes ?? current.privacyGuaranteeMinutes ?? 15;
    const nextIsActive = input.isActive ?? current.isActive;

    const updatedRes = await db.query<HomepageCampaignRow>(
      `UPDATE homepage_campaigns SET
         eyebrow = $2,
         hero_title = $3,
         hero_subtitle = $4,
         atelier_manifesto = $5,
         cta_label = $6,
         service_note = $7,
         privacy_guarantee_minutes = $8,
         hero_image_url = $9,
         intro_jsonb = $10::jsonb,
         hero_jsonb = $11::jsonb,
         atelier_steps_jsonb = $12::jsonb,
         finale_jsonb = $13::jsonb,
         is_active = $14,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [
        current.id,
        nextHero.eyebrow,
        nextHero.title,
        nextHero.lead,
        nextManifesto,
        nextHero.primaryCtaLabel,
        nextHero.serviceNote,
        nextPrivacyMin,
        nextHero.posterUrl,
        JSON.stringify(nextIntro),
        JSON.stringify(nextHero),
        JSON.stringify(nextSteps),
        JSON.stringify(nextFinale),
        nextIsActive,
      ],
    );

    return this.mapHomepageCampaignRow(updatedRes.rows[0]);
  }

  public async getStorefrontBootstrap(): Promise<
    StorefrontBootstrapDto & {
      categories: CategoryDto[];
      occasionLookbooks: OccasionLookbookDto[];
    }
  > {
    const db = await this.dbService.getClient();
    const [
      categories,
      publishedProducts,
      occasionsRes,
      occItemsRes,
      seasonsRes,
      packagingRes,
      homepageCampaign,
    ] = await Promise.all([
      this.listCategories(),
      this.loadProductsByWhere('p.status = $1', [ProductStatus.PUBLISHED], false),
      db.query<{
        id: string;
        slug: string;
        title: string;
        subtitle: string;
        palette_bg: string;
        palette_ink: string;
        palette_accent: string;
        is_dark: boolean;
        badge_tag: string | null;
        sort_order: number;
      }>('SELECT * FROM occasion_lookbooks ORDER BY sort_order ASC'),
      db.query<{ occasion_id: string; product_id: string; slot_label: string }>(
        'SELECT occasion_id, product_id, slot_label FROM occasion_lookbook_items ORDER BY sort_order ASC',
      ),
      db.query<{
        id: string;
        slug: string;
        months: string;
        title: string;
        subtitle: string;
        hero_image_url: string | null;
        is_current: boolean;
        sort_order: number;
      }>('SELECT * FROM seasonal_collections ORDER BY sort_order ASC'),
      db.query<{
        id: string;
        code: string;
        name: string;
        description: string;
        swatch_hex: string;
        price_vnd: number;
        image_url: string | null;
        back_image_url: string | null;
        is_default: boolean;
        sort_order: number;
      }>('SELECT * FROM packaging_options ORDER BY sort_order ASC'),
      this.getHomepageCampaign(),
    ]);

    const cleanProducts = publishedProducts.map(stripSensitiveProductFields);
    const productById = new Map(cleanProducts.map((p) => [p.id, p]));

    const occasionLookbooks: OccasionLookbookDto[] = occasionsRes.rows.map(
      (occ) => {
        const linkedRows = occItemsRes.rows.filter(
          (item) => item.occasion_id === occ.id && productById.has(item.product_id),
        );
        const linkedProducts = linkedRows
          .map((item) => productById.get(item.product_id)!)
          .slice(0, 4);

        const items: OccasionLookbookItemDto[] = linkedRows
          .slice(0, 4)
          .map((row) => {
            const p = productById.get(row.product_id)!;
            const v0 =
              p.variants.find(
                (v) => !/-v\d+-lookbook/i.test(v.lookbookMainUrl ?? ''),
              ) ?? p.variants[0];
            return {
              productId: p.id,
              slug: p.slug,
              name: p.name,
              minPriceVnd: p.minPriceVnd,
              lookbookMainUrl: v0?.lookbookMainUrl ?? null,
              heroCutoutUrl: resolveOccasionCutoutUrl(p.slug),
              tryonFlatPreviewUrl:
                v0?.tryonFlatPreviewUrl ?? p.tryonFlatAssetUrl ?? null,
              macroImageUrl: resolveOccasionMacroImageUrl(
                p.slug,
                p.fabricComposition,
              ),
              isTryonEnabled: p.isTryonEnabled,
              slotLabel: row.slot_label || 'FEATURED',
            };
          });

        return {
          id: occ.id,
          slug: occ.slug,
          key: occ.slug,
          name: occ.title,
          tagline: occ.subtitle,
          description: occ.subtitle,
          themeBg: occ.palette_bg,
          themeInk: occ.palette_ink,
          themeAccent: occ.palette_accent,
          isDark: Boolean(occ.is_dark),
          badgeTag: occ.badge_tag,
          heroCutoutUrl: items[0]?.heroCutoutUrl ?? null,
          macroImageUrl: items[0]?.macroImageUrl ?? null,
          sortOrder: Number(occ.sort_order),
          productSlugs: linkedProducts.map((p) => p.slug),
          featuredProducts: linkedProducts,
          items,
        };
      },
    );

    const seasons: SeasonalCollectionDto[] = this.buildHydratedSeasons(
      seasonsRes.rows,
      cleanProducts,
    );

    const packagingOptions: PackagingOptionDto[] = packagingRes.rows.map(
      (pkg) => ({
        id: pkg.id,
        code: pkg.code,
        name: pkg.name,
        description: pkg.description,
        swatchHex: pkg.swatch_hex,
        priceVnd: Number(pkg.price_vnd),
        backAssetUrl: pkg.back_image_url ?? pkg.image_url,
        frontAssetUrl: pkg.image_url,
        isDefault: Boolean(pkg.is_default),
        sortOrder: Number(pkg.sort_order),
      }),
    );

    return {
      brand: 'Tầm Xuân · Fashion Atelier',
      platformVersion: '3.0.0',
      campaign: {
        code: homepageCampaign.code,
        eyebrow: homepageCampaign.eyebrow,
        title: homepageCampaign.title,
        subtitle: homepageCampaign.subtitle,
        heroVideoUrl: homepageCampaign.heroVideoUrl ?? undefined,
        heroPosterUrl: homepageCampaign.heroPosterUrl ?? undefined,
        ctaLabel: homepageCampaign.ctaLabel,
        serviceNote: homepageCampaign.serviceNote,
      },
      rackPreviewCount: cleanProducts.length,
      occasions: occasionLookbooks.map((occ) => ({
        key: occ.key,
        slug: occ.slug,
        name: occ.name,
        tagline: occ.tagline,
        themeBg: occ.themeBg,
        themeInk: occ.themeInk,
        themeAccent: occ.themeAccent,
        isDark: occ.isDark,
        itemCount: occ.productSlugs.length,
      })),
      seasonalCollections: seasons.map((s) => ({
        slug: s.slug,
        months: s.months,
        name: s.name,
        shortName: s.shortName,
        materialHeadline: s.materialHeadline,
        note: s.note,
        isCurrent: s.isCurrent,
        isCurrentSeason: s.isCurrentSeason ?? s.isCurrent,
        coverAssetUrl: s.coverAssetUrl,
        productCount: s.productCount ?? s.productSlugs.length,
        interactiveLookbook: s.interactiveLookbook ?? null,
        heroProducts: s.heroProducts ?? [],
      })),
      serviceStatus: {
        bff: 'ok',
        aiTryOnMode:
          (process.env.VTON_PROVIDER ?? 'mock').toLowerCase() === 'fal'
            ? 'fal'
            : 'mock',
        phase: 'phase-2',
      },
      generatedAt: new Date().toISOString(),
      featuredProducts: cleanProducts,
      seasons,
      packagingOptions,
      homepageCampaign,
      servicesStatus: {
        catalog: 'ok',
        meilisearch: this.meili.isHealthy() ? 'ok' : 'degraded',
      },
      categories,
      occasionLookbooks,
    };
  }

  public async recommendSize(
    request: SizeRecommendRequest,
  ): Promise<SizeRecommendResponse> {
    let product: ProductSpuDto;
    if (request.productId && UUID_REGEX.test(request.productId)) {
      product = await this.getAdminProductByIdOrSlug(request.productId);
    } else if (request.productSlug) {
      product = await this.getAdminProductByIdOrSlug(request.productSlug);
    } else if (request.productId) {
      product = await this.getAdminProductByIdOrSlug(request.productId);
    } else {
      throw new BadRequestException('Either productId or productSlug is required');
    }

    let chart = product.sizeChart ?? null;
    if (!chart) {
      const charts = await this.listSizeCharts();
      chart = charts[0] ?? null;
    }
    if (!chart) {
      throw new NotFoundException('No size chart available for this product');
    }

    const availableSizes = Array.from(
      new Set(
        product.variants.flatMap((v) =>
          v.skus.filter((s) => s.inStock).map((s) => s.sizeCode),
        ),
      ),
    );

    const liveFitStats = await this.fetchLiveFitStatsForProduct(product.id);
    let fitStats: ProductFitStatsDto | null = liveFitStats;
    if (!fitStats) {
      const storedMap = await this.loadStoredFitStatsMap([product.id]);
      fitStats = storedMap.get(product.id) ?? null;
    }

    return computeHonestSizeRecommendation({
      request,
      sizeChart: chart,
      fitType: product.fitType,
      stretchLevel: product.stretchLevel,
      fitCalibrationNote: product.fitCalibrationNote,
      fitStats,
      availableSizes,
    });
  }

  public async getRackShowcase(): Promise<RackCollectionDto> {
    const published = await this.loadProductsByWhere(
      'p.status = $1',
      [ProductStatus.PUBLISHED],
      false,
    );
    const cleanProducts = published.map(stripSensitiveProductFields);
    const productIds = cleanProducts.map((p) => p.id);

    const [spatialMap, liveStatsMap, storedStatsMap] = await Promise.all([
      this.fetchMediaSpatialMap(),
      this.fetchLiveFitStatsBatch(productIds),
      this.loadStoredFitStatsMap(productIds),
    ]);

    const items: RackGarmentItemDto[] = cleanProducts.map((product) => {
      const fitStats =
        liveStatsMap[product.id] ?? storedStatsMap.get(product.id) ?? null;
      const numericWeight = Number.parseFloat(product.fabricWeight);

      return {
        productId: product.id,
        slug: product.slug,
        name: product.name,
        subtitle: product.subtitle ?? null,
        fabricComposition: product.fabricComposition,
        fabricWeight: Number.isFinite(numericWeight)
          ? numericWeight
          : product.fabricWeight,
        minPriceVnd: product.minPriceVnd,
        isTryonEnabled: product.isTryonEnabled,
        tryonGarmentCategory: product.tryonGarmentCategory,
        fitStats,
        variants: product.variants.map((variant) => {
          const liveSpatial = variant.rackFrontAssetId
            ? spatialMap[variant.rackFrontAssetId]
            : undefined;
          const spec = variant.layerSpecJsonb ?? {};
          const fallbackX =
            typeof spec.hangerAnchorX === 'number' ? spec.hangerAnchorX : 0.5;
          const fallbackY =
            typeof spec.hangerAnchorY === 'number' ? spec.hangerAnchorY : 0.14;

          const inStockSizes = Array.from(
            new Set(
              variant.skus.filter((s) => s.inStock).map((s) => s.sizeCode),
            ),
          );

          return {
            id: variant.id,
            colorName: variant.colorName,
            colorHex: variant.colorHex,
            frontCutoutUrl: variant.rackFrontUrl ?? variant.lookbookMainUrl,
            backCutoutUrl:
              variant.rackBackUrl ??
              variant.rackFrontUrl ??
              variant.lookbookMainUrl,
            lookbookMainUrl: variant.lookbookMainUrl,
            tryonFlatPreviewUrl: variant.tryonFlatPreviewUrl,
            rackFrontAssetId: variant.rackFrontAssetId,
            hangerAnchorX: liveSpatial?.hangerAnchorX ?? fallbackX,
            hangerAnchorY: liveSpatial?.hangerAnchorY ?? fallbackY,
            inStockSizes,
            skus: variant.skus,
          };
        }),
      };
    });

    return {
      items,
      total: items.length,
      updatedAt: new Date().toISOString(),
    };
  }

  public async listOccasions(): Promise<OccasionLookbookDto[]> {
    const db = await this.dbService.getClient();
    const [published, occasionsRes, occItemsRes] = await Promise.all([
      this.loadProductsByWhere('p.status = $1', [ProductStatus.PUBLISHED], false),
      db.query<{
        id: string;
        slug: string;
        title: string;
        subtitle: string;
        palette_bg: string;
        palette_ink: string;
        palette_accent: string;
        is_dark: boolean;
        badge_tag: string | null;
        sort_order: number;
      }>('SELECT * FROM occasion_lookbooks ORDER BY sort_order ASC'),
      db.query<{ occasion_id: string; product_id: string; slot_label: string }>(
        'SELECT occasion_id, product_id, slot_label FROM occasion_lookbook_items ORDER BY sort_order ASC',
      ),
    ]);

    const cleanProducts = published.map(stripSensitiveProductFields);
    const productById = new Map(cleanProducts.map((p) => [p.id, p]));

    return occasionsRes.rows.map((occ) => {
      const linkedRows = occItemsRes.rows.filter(
        (row) => row.occasion_id === occ.id && productById.has(row.product_id),
      );
      const linkedProducts = linkedRows
        .map((row) => productById.get(row.product_id)!)
        .slice(0, 4);

      const items: OccasionLookbookItemDto[] = linkedRows
        .slice(0, 4)
        .map((row) => {
          const p = productById.get(row.product_id)!;
          const v0 =
            p.variants.find(
              (v) => !/-v\d+-lookbook/i.test(v.lookbookMainUrl ?? ''),
            ) ?? p.variants[0];
          return {
            productId: p.id,
            slug: p.slug,
            name: p.name,
            minPriceVnd: p.minPriceVnd,
            lookbookMainUrl: v0?.lookbookMainUrl ?? null,
            heroCutoutUrl: resolveOccasionCutoutUrl(p.slug),
            tryonFlatPreviewUrl:
              v0?.tryonFlatPreviewUrl ?? p.tryonFlatAssetUrl ?? null,
            macroImageUrl: resolveOccasionMacroImageUrl(
              p.slug,
              p.fabricComposition,
            ),
            isTryonEnabled: p.isTryonEnabled,
            slotLabel: row.slot_label || 'FEATURED',
          };
        });

      return {
        id: occ.id,
        slug: occ.slug,
        key: occ.slug,
        name: occ.title,
        tagline: occ.subtitle,
        description: occ.subtitle,
        themeBg: occ.palette_bg,
        themeInk: occ.palette_ink,
        themeAccent: occ.palette_accent,
        isDark: Boolean(occ.is_dark),
        badgeTag: occ.badge_tag,
        heroCutoutUrl: items[0]?.heroCutoutUrl ?? null,
        macroImageUrl: items[0]?.macroImageUrl ?? null,
        sortOrder: Number(occ.sort_order),
        productSlugs: linkedProducts.map((p) => p.slug),
        featuredProducts: linkedProducts,
        items,
      };
    });
  }

  private buildHydratedSeasons(
    rows: readonly SeasonDbRow[],
    cleanProducts: readonly ProductSpuDto[],
  ): SeasonalCollectionDto[] {
    const manifestBySlug = loadSeasonsManifestBySlug();
    return rows.map((row) =>
      hydrateSeasonCollectionDto(row, cleanProducts, manifestBySlug),
    );
  }

  public async listSeasons(): Promise<SeasonalCollectionDto[]> {
    const db = await this.dbService.getClient();
    const [published, seasonsRes] = await Promise.all([
      this.loadProductsByWhere('p.status = $1', [ProductStatus.PUBLISHED], false),
      db.query<SeasonDbRow>(
        'SELECT id, slug, months, title, subtitle, hero_image_url, is_current, sort_order FROM seasonal_collections ORDER BY sort_order ASC',
      ),
    ]);

    const cleanProducts = published.map(stripSensitiveProductFields);
    return this.buildHydratedSeasons(seasonsRes.rows, cleanProducts);
  }

  public async handleFitStatsUpdated(
    productId: string,
    fitStats: ProductFitStatsDto,
  ): Promise<{ updated: boolean; productId: string }> {
    if (!UUID_REGEX.test(productId)) {
      throw new BadRequestException('Invalid productId UUID');
    }
    const db = await this.dbService.getClient();
    const res = await db.query<{ id: string }>(
      `UPDATE products SET
         fit_stats_jsonb = $2::jsonb,
         updated_at = NOW()
       WHERE id = $1
       RETURNING id`,
      [productId, JSON.stringify(fitStats)],
    );
    if (res.rows.length === 0) {
      throw new NotFoundException(`Product "${productId}" not found`);
    }
    const updatedProduct = await this.getAdminProductByIdOrSlug(productId);
    await this.meili.syncProducts([updatedProduct]);
    return { updated: true, productId };
  }

  public async createAdminProduct(
    input: CreateAdminProductInput,
  ): Promise<ProductSpuDto> {
    const db = await this.dbService.getClient();

    let categoryId = input.categoryId;
    if (!categoryId && input.categorySlug) {
      const catRes = await db.query<{ id: string }>(
        'SELECT id FROM categories WHERE slug = $1',
        [input.categorySlug],
      );
      categoryId = catRes.rows[0]?.id;
    }
    if (!categoryId) {
      const firstCat = await db.query<{ id: string }>(
        'SELECT id FROM categories ORDER BY sort_order ASC LIMIT 1',
      );
      categoryId = firstCat.rows[0]?.id;
    }
    if (!categoryId) {
      throw new BadRequestException('Valid categoryId or categorySlug is required');
    }

    let sizeChartId = input.sizeChartId ?? null;
    if (!sizeChartId) {
      const firstChart = await db.query<{ id: string }>(
        'SELECT id FROM size_charts ORDER BY code ASC LIMIT 1',
      );
      sizeChartId = firstChart.rows[0]?.id ?? null;
    }

    const productId = randomUUID();
    const baseSlug = input.slug?.trim() || slugifyVietnamese(input.name);
    const slug = `${baseSlug}-${productId.slice(0, 6)}`;
    const parsedWeight =
      typeof input.fabricWeight === 'number'
        ? input.fabricWeight
        : Number.parseFloat(String(input.fabricWeight ?? '200')) || 200;

    const variantsInput =
      input.variants && input.variants.length > 0
        ? input.variants
        : [
            {
              colorName: 'Trắng Ngà',
              colorHex: '#EFE7DA',
              skus: [
                {
                  sizeCode: SizeCode.S,
                  basePriceVnd: 1_950_000,
                  costPriceVnd: 650_000,
                },
                {
                  sizeCode: SizeCode.M,
                  basePriceVnd: 1_950_000,
                  costPriceVnd: 650_000,
                },
                {
                  sizeCode: SizeCode.L,
                  basePriceVnd: 1_950_000,
                  costPriceVnd: 650_000,
                },
              ],
            },
          ];

    const allPrices: number[] = [];
    for (const v of variantsInput) {
      for (const s of v.skus ?? []) {
        allPrices.push(s.salePriceVnd ?? s.basePriceVnd);
      }
    }
    const minPriceVnd = allPrices.length > 0 ? Math.min(...allPrices) : 1_950_000;

    await db.query(
      `INSERT INTO products (
         id, category_id, slug, name, subtitle, brand_name, description,
         fabric_composition, fit_type, stretch_level, fabric_weight, gender,
         is_tryon_enabled, tryon_garment_category, tryon_flat_asset_url,
         fit_calibration_note, min_price_vnd, stock_status_summary, status,
         size_chart_id, occasion_slugs, season_slugs
       ) VALUES (
         $1, $2, $3, $4, $5, $6, $7,
         $8, $9, $10, $11, $12,
         $13, $14, $15,
         $16, $17, $18, $19,
         $20, $21::jsonb, $22::jsonb
       )`,
      [
        productId,
        categoryId,
        slug,
        input.name,
        input.subtitle ?? null,
        input.brandName ?? 'Tầm Xuân Atelier',
        input.description,
        input.fabricComposition,
        input.fitType ?? FitType.REGULAR,
        input.stretchLevel ?? StretchLevel.NONE,
        parsedWeight,
        input.gender ?? Gender.WOMEN,
        Boolean(input.isTryonEnabled),
        input.tryonGarmentCategory ?? TryOnGarmentCategory.NONE,
        input.tryonFlatAssetUrl ?? null,
        input.fitCalibrationNote ?? null,
        minPriceVnd,
        StockStatusSummary.IN_STOCK,
        input.status ?? ProductStatus.PUBLISHED,
        sizeChartId,
        JSON.stringify(input.occasionSlugs ?? []),
        JSON.stringify(input.seasonSlugs ?? []),
      ],
    );

    for (let vIdx = 0; vIdx < variantsInput.length; vIdx += 1) {
      const v = variantsInput[vIdx];
      const variantId = randomUUID();
      await db.query(
        `INSERT INTO product_variants (
           id, product_id, color_name, color_hex, lookbook_main_url,
           tryon_flat_preview_url, rack_front_url
         ) VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          variantId,
          productId,
          v.colorName,
          v.colorHex,
          v.lookbookMainUrl ?? null,
          v.tryonFlatPreviewUrl ?? null,
          v.rackFrontUrl ?? null,
        ],
      );

      for (const s of v.skus ?? []) {
        const skuId = randomUUID();
        const skuCode =
          s.skuCode?.trim() ||
          `AT-${productId.slice(0, 6).toUpperCase()}-C${vIdx + 1}-${s.sizeCode}`;
        await db.query(
          `INSERT INTO skus (
             id, variant_id, sku_code, size_code, base_price_vnd, sale_price_vnd,
             cost_price_vnd, supplier_id, weight_grams, in_stock, is_returnable
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            skuId,
            variantId,
            skuCode,
            s.sizeCode,
            s.basePriceVnd,
            s.salePriceVnd ?? null,
            s.costPriceVnd ?? 0,
            s.supplierId ?? null,
            s.weightGrams ?? 320,
            s.inStock ?? true,
            s.isReturnable ?? true,
          ],
        );
      }
    }

    const created = await this.getAdminProductByIdOrSlug(productId);
    if (created.status === ProductStatus.PUBLISHED) {
      await this.meili.syncProducts([created]);
    }
    return created;
  }

  public async updateAdminProduct(
    idOrSlug: string,
    input: UpdateAdminProductInput,
  ): Promise<ProductSpuDto> {
    const existing = await this.getAdminProductByIdOrSlug(idOrSlug);
    const db = await this.dbService.getClient();

    let categoryId = input.categoryId ?? existing.categoryId;
    if (!input.categoryId && input.categorySlug) {
      const catRes = await db.query<{ id: string }>(
        'SELECT id FROM categories WHERE slug = $1',
        [input.categorySlug],
      );
      if (catRes.rows[0]?.id) {
        categoryId = catRes.rows[0].id;
      }
    }

    const fabricWeightNum =
      input.fabricWeight !== undefined
        ? Number.parseFloat(String(input.fabricWeight)) || 200
        : Number.parseFloat(existing.fabricWeight) || 200;

    await db.query(
      `UPDATE products SET
         category_id = $2,
         name = $3,
         subtitle = $4,
         description = $5,
         fabric_composition = $6,
         fit_type = $7,
         stretch_level = $8,
         fabric_weight = $9,
         gender = $10,
         is_tryon_enabled = $11,
         tryon_garment_category = $12,
         tryon_flat_asset_url = $13,
         fit_calibration_note = $14,
         status = $15,
         occasion_slugs = $16::jsonb,
         season_slugs = $17::jsonb,
         updated_at = NOW()
       WHERE id = $1`,
      [
        existing.id,
        categoryId,
        input.name ?? existing.name,
        input.subtitle !== undefined ? input.subtitle : (existing.subtitle ?? null),
        input.description ?? existing.description,
        input.fabricComposition ?? existing.fabricComposition,
        input.fitType ?? existing.fitType,
        input.stretchLevel ?? existing.stretchLevel,
        fabricWeightNum,
        input.gender ?? existing.gender,
        input.isTryonEnabled !== undefined
          ? input.isTryonEnabled
          : existing.isTryonEnabled,
        input.tryonGarmentCategory ?? existing.tryonGarmentCategory,
        input.tryonFlatAssetUrl !== undefined
          ? input.tryonFlatAssetUrl
          : existing.tryonFlatAssetUrl,
        input.fitCalibrationNote !== undefined
          ? input.fitCalibrationNote
          : existing.fitCalibrationNote,
        input.status ?? existing.status,
        JSON.stringify(input.occasionSlugs ?? existing.occasionSlugs),
        JSON.stringify(input.seasonSlugs ?? existing.seasonSlugs),
      ],
    );

    const updated = await this.getAdminProductByIdOrSlug(existing.id);
    await this.meili.syncProducts([updated]);
    return updated;
  }

  public async updateAdminSku(
    idOrCode: string,
    input: UpdateAdminSkuInput,
  ): Promise<{ sku: SkuDto; product: ProductSpuDto }> {
    const db = await this.dbService.getClient();
    const isUuid = UUID_REGEX.test(idOrCode);

    const found = await db.query<SkuRow & { product_id: string }>(
      `SELECT s.*, v.product_id
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       WHERE ${isUuid ? 's.id = $1' : 's.sku_code = $1'}`,
      [idOrCode],
    );
    const current = found.rows[0];
    if (!current) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `SKU "${idOrCode}" not found`,
      });
    }

    const nextBase = input.basePriceVnd ?? Number(current.base_price_vnd);
    const nextSale =
      input.salePriceVnd !== undefined
        ? input.salePriceVnd
        : current.sale_price_vnd;
    const nextCost = input.costPriceVnd ?? Number(current.cost_price_vnd);
    const nextInStock = input.inStock ?? Boolean(current.in_stock);
    const nextWeight = input.weightGrams ?? Number(current.weight_grams);
    const nextReturnable = input.isReturnable ?? Boolean(current.is_returnable);

    await db.query(
      `UPDATE skus SET
         base_price_vnd = $2,
         sale_price_vnd = $3,
         cost_price_vnd = $4,
         in_stock = $5,
         weight_grams = $6,
         is_returnable = $7
       WHERE id = $1`,
      [
        current.id,
        nextBase,
        nextSale,
        nextCost,
        nextInStock,
        nextWeight,
        nextReturnable,
      ],
    );

    // Recompute parent product min_price_vnd & stock_status_summary
    const siblingSkus = await db.query<{
      base_price_vnd: number;
      sale_price_vnd: number | null;
      in_stock: boolean;
    }>(
      `SELECT s.base_price_vnd, s.sale_price_vnd, s.in_stock
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       WHERE v.product_id = $1`,
      [current.product_id],
    );

    const minPrice = siblingSkus.rows.reduce((min, s) => {
      const eff =
        s.sale_price_vnd !== null && s.sale_price_vnd !== undefined
          ? Number(s.sale_price_vnd)
          : Number(s.base_price_vnd);
      return Math.min(min, eff);
    }, Number.MAX_SAFE_INTEGER);

    const inStockCount = siblingSkus.rows.filter((s) => s.in_stock).length;
    const stockSummary =
      inStockCount === 0
        ? StockStatusSummary.OUT_OF_STOCK
        : inStockCount <= 2
          ? StockStatusSummary.LOW_STOCK
          : StockStatusSummary.IN_STOCK;

    await db.query(
      `UPDATE products SET
         min_price_vnd = $2,
         stock_status_summary = $3,
         updated_at = NOW()
       WHERE id = $1`,
      [
        current.product_id,
        minPrice === Number.MAX_SAFE_INTEGER ? nextBase : minPrice,
        stockSummary,
      ],
    );

    const updatedProduct = await this.getAdminProductByIdOrSlug(
      current.product_id,
    );
    await this.meili.syncProducts([updatedProduct]);

    const updatedSku = updatedProduct.variants
      .flatMap((v) => v.skus)
      .find((s) => s.id === current.id)!;

    return { sku: updatedSku, product: updatedProduct };
  }

  private mapSubmissionRow(
    row: SubmissionRow,
  ): SupplierProductSubmissionDto & {
    categorySlug: string;
    wholesalePriceVnd: number;
    flatAssetUrl: string | null;
    rackAssetUrl: string | null;
    rawSizeSpec: Record<string, unknown>;
    reviewNote: string | null;
  } {
    return {
      id: row.id,
      supplierId: row.supplier_id,
      proposedName: row.proposed_name,
      proposedCategorySlug: row.category_slug,
      categorySlug: row.category_slug,
      fabricComposition: row.fabric_composition,
      wholesaleCostVnd: Number(row.wholesale_price_vnd),
      wholesalePriceVnd: Number(row.wholesale_price_vnd),
      suggestedRetailVnd: Number(row.suggested_retail_vnd),
      availableSizes: parseJsonField<SizeCode[]>(row.available_sizes_jsonb, [
        SizeCode.S,
        SizeCode.M,
        SizeCode.L,
      ]),
      colorName: row.color_name,
      colorHex: row.color_hex,
      assetIds: parseJsonField<string[]>(row.asset_ids_jsonb, []),
      rawSizeSpec: parseJsonField<Record<string, unknown>>(
        row.raw_size_spec_jsonb,
        {},
      ),
      flatAssetUrl: row.flat_asset_url,
      rackAssetUrl: row.rack_asset_url,
      notes: row.notes,
      status: row.status,
      reviewComment: row.review_note,
      reviewNote: row.review_note,
      reviewedBy: row.reviewer_id,
      reviewedAt: row.reviewed_at ? toIsoString(row.reviewed_at) : null,
      createdProductId: row.created_product_id,
      createdAt: toIsoString(row.created_at),
      updatedAt: toIsoString(row.updated_at),
    };
  }

  public async listAdminSubmissions(filters?: {
    status?: string;
    supplierId?: string;
  }): Promise<ReturnType<CatalogService['mapSubmissionRow']>[]> {
    const db = await this.dbService.getClient();
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters?.status) {
      params.push(filters.status.toUpperCase());
      clauses.push(`status = $${params.length}`);
    }
    if (filters?.supplierId) {
      params.push(filters.supplierId);
      clauses.push(`supplier_id = $${params.length}`);
    }

    const res = await db.query<SubmissionRow>(
      `SELECT * FROM supplier_product_submissions
       ${clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : ''}
       ORDER BY created_at DESC`,
      params,
    );
    return res.rows.map((r) => this.mapSubmissionRow(r));
  }

  public async reviewAdminSubmission(
    id: string,
    input: ReviewSubmissionInput,
    reviewerId?: string,
  ): Promise<ReturnType<CatalogService['mapSubmissionRow']>> {
    if (!UUID_REGEX.test(id)) {
      throw new NotFoundException(`Submission "${id}" not found`);
    }
    const db = await this.dbService.getClient();
    const found = await db.query<SubmissionRow>(
      'SELECT * FROM supplier_product_submissions WHERE id = $1',
      [id],
    );
    const current = found.rows[0];
    if (!current) {
      throw new NotFoundException(`Submission "${id}" not found`);
    }

    const decision = input.decision ?? input.status;
    if (
      decision !== SubmissionStatus.APPROVED &&
      decision !== SubmissionStatus.REJECTED
    ) {
      throw new BadRequestException(
        'decision must be either APPROVED or REJECTED',
      );
    }

    const comment = input.reviewComment ?? input.reviewNote ?? null;
    let createdProductId = current.created_product_id;

    if (decision === SubmissionStatus.APPROVED && !createdProductId) {
      const sizes = parseJsonField<SizeCode[]>(current.available_sizes_jsonb, [
        SizeCode.S,
        SizeCode.M,
        SizeCode.L,
      ]);
      const created = await this.createAdminProduct({
        categorySlug: current.category_slug,
        name: current.proposed_name,
        description:
          current.notes ??
          `Thiết kế đề xuất từ đối tác ${current.supplier_id}, đã qua thẩm định danh mục Atelier.`,
        fabricComposition: current.fabric_composition,
        isTryonEnabled: Boolean(current.flat_asset_url),
        tryonGarmentCategory: current.flat_asset_url
          ? TryOnGarmentCategory.UPPER
          : TryOnGarmentCategory.NONE,
        tryonFlatAssetUrl: current.flat_asset_url,
        status: ProductStatus.DRAFT,
        variants: [
          {
            colorName: current.color_name,
            colorHex: current.color_hex,
            lookbookMainUrl: current.rack_asset_url ?? current.flat_asset_url,
            tryonFlatPreviewUrl: current.flat_asset_url,
            rackFrontUrl: current.rack_asset_url,
            skus: sizes.map((sizeCode) => ({
              sizeCode,
              basePriceVnd: Number(current.suggested_retail_vnd),
              costPriceVnd: Number(current.wholesale_price_vnd),
              supplierId: current.supplier_id,
              inStock: true,
            })),
          },
        ],
      });
      createdProductId = created.id;
    }

    const validReviewerUuid =
      reviewerId && UUID_REGEX.test(reviewerId) ? reviewerId : null;

    const updatedRes = await db.query<SubmissionRow>(
      `UPDATE supplier_product_submissions SET
         status = $2,
         reviewer_id = $3,
         review_note = $4,
         reviewed_at = NOW(),
         created_product_id = $5,
         updated_at = NOW()
       WHERE id = $1
       RETURNING *`,
      [id, decision, validReviewerUuid, comment, createdProductId],
    );

    return this.mapSubmissionRow(updatedRes.rows[0]);
  }

  public async listPartnerSubmissions(
    supplierId: string,
  ): Promise<ReturnType<CatalogService['mapSubmissionRow']>[]> {
    if (!supplierId || !UUID_REGEX.test(supplierId)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Missing or invalid x-supplier-id tenant context',
      });
    }
    const db = await this.dbService.getClient();
    const res = await db.query<SubmissionRow>(
      `SELECT * FROM supplier_product_submissions
       WHERE supplier_id = $1
       ORDER BY created_at DESC`,
      [supplierId],
    );
    return res.rows.map((r) => this.mapSubmissionRow(r));
  }

  public async getPartnerSubmissionById(
    supplierId: string,
    submissionId: string,
  ): Promise<ReturnType<CatalogService['mapSubmissionRow']>> {
    if (!supplierId || !UUID_REGEX.test(supplierId)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Missing or invalid x-supplier-id tenant context',
      });
    }
    if (!UUID_REGEX.test(submissionId)) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Submission "${submissionId}" not found`,
      });
    }

    const db = await this.dbService.getClient();
    const res = await db.query<SubmissionRow>(
      'SELECT * FROM supplier_product_submissions WHERE id = $1',
      [submissionId],
    );
    const row = res.rows[0];
    if (!row) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Submission "${submissionId}" not found`,
      });
    }
    if (row.supplier_id !== supplierId) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Tenant isolation violation: submission belongs to another supplier',
      });
    }
    return this.mapSubmissionRow(row);
  }

  public async createPartnerSubmission(
    supplierId: string,
    input: CreatePartnerSubmissionInput,
  ): Promise<ReturnType<CatalogService['mapSubmissionRow']>> {
    if (!supplierId || !UUID_REGEX.test(supplierId)) {
      throw new ForbiddenException({
        code: ErrorCode.FORBIDDEN,
        message: 'Missing or invalid x-supplier-id tenant context',
      });
    }

    const wholesaleVnd = input.wholesaleCostVnd ?? input.wholesalePriceVnd ?? 0;
    const categorySlug =
      input.proposedCategorySlug ?? input.categorySlug ?? 'ao-so-mi';
    const sizes =
      input.availableSizes && input.availableSizes.length > 0
        ? input.availableSizes
        : [SizeCode.S, SizeCode.M, SizeCode.L];

    const id = randomUUID();
    const db = await this.dbService.getClient();
    const res = await db.query<SubmissionRow>(
      `INSERT INTO supplier_product_submissions (
         id, supplier_id, proposed_name, category_slug, wholesale_price_vnd,
         suggested_retail_vnd, fabric_composition, available_sizes_jsonb,
         color_name, color_hex, asset_ids_jsonb, raw_size_spec_jsonb,
         flat_asset_url, rack_asset_url, notes, status
       ) VALUES (
         $1, $2, $3, $4, $5,
         $6, $7, $8::jsonb,
         $9, $10, $11::jsonb, $12::jsonb,
         $13, $14, $15, $16
       )
       RETURNING *`,
      [
        id,
        supplierId,
        input.proposedName,
        categorySlug,
        wholesaleVnd,
        input.suggestedRetailVnd,
        input.fabricComposition,
        JSON.stringify(sizes),
        input.colorName ?? 'Trắng Ngà',
        input.colorHex ?? '#EFE7DA',
        JSON.stringify(input.assetIds ?? []),
        JSON.stringify(input.rawSizeSpec ?? {}),
        input.flatAssetUrl ?? null,
        input.rackAssetUrl ?? null,
        input.notes ?? null,
        SubmissionStatus.PENDING_REVIEW,
      ],
    );

    return this.mapSubmissionRow(res.rows[0]);
  }

  public async getSkusSnapshot(params: {
    skuIds?: string[];
    skuCodes?: string[];
  }): Promise<Array<Record<string, unknown>>> {
    const db = await this.dbService.getClient();
    const skuIds = (params.skuIds ?? []).filter((id) => UUID_REGEX.test(id));
    const skuCodes = params.skuCodes ?? [];

    if (skuIds.length === 0 && skuCodes.length === 0) {
      return [];
    }

    const clauses: string[] = [];
    const queryParams: unknown[] = [];
    if (skuIds.length > 0) {
      queryParams.push(skuIds);
      clauses.push(`s.id = ANY($${queryParams.length}::uuid[])`);
    }
    if (skuCodes.length > 0) {
      queryParams.push(skuCodes);
      clauses.push(`s.sku_code = ANY($${queryParams.length}::text[])`);
    }

    const res = await db.query<{
      id: string;
      sku_code: string;
      variant_id: string;
      product_id: string;
      product_name: string;
      product_slug: string;
      color_name: string;
      color_hex: string;
      size_code: string;
      base_price_vnd: number;
      sale_price_vnd: number | null;
      weight_grams: number;
      in_stock: boolean;
      is_returnable: boolean;
      lookbook_main_url: string | null;
    }>(
      `SELECT s.id, s.sku_code, s.variant_id, p.id AS product_id, p.name AS product_name,
              p.slug AS product_slug, v.color_name, v.color_hex, v.lookbook_main_url,
              s.size_code, s.base_price_vnd, s.sale_price_vnd, s.weight_grams,
              s.in_stock, s.is_returnable
       FROM skus s
       JOIN product_variants v ON v.id = s.variant_id
       JOIN products p ON p.id = v.product_id
       WHERE ${clauses.join(' OR ')}`,
      queryParams,
    );

    return res.rows.map((row) => {
      const effectivePrice =
        row.sale_price_vnd !== null && row.sale_price_vnd !== undefined
          ? Number(row.sale_price_vnd)
          : Number(row.base_price_vnd);
      return {
        skuId: row.id,
        skuCode: row.sku_code,
        variantId: row.variant_id,
        productId: row.product_id,
        productName: row.product_name,
        productSlug: row.product_slug,
        colorName: row.color_name,
        colorHex: row.color_hex,
        sizeCode: row.size_code,
        basePriceVnd: Number(row.base_price_vnd),
        salePriceVnd: effectivePrice,
        effectivePriceVnd: effectivePrice,
        weightGrams: Number(row.weight_grams),
        inStock: Boolean(row.in_stock),
        isReturnable: Boolean(row.is_returnable),
        imageUrl: row.lookbook_main_url,
      };
    });
  }

  public async handleMediaProcessed(
    input: MediaProcessedHookInput,
  ): Promise<{ updated: boolean; productId?: string; variantId?: string }> {
    const db = await this.dbService.getClient();
    let targetProductId = input.productId;

    if (input.variantId && UUID_REGEX.test(input.variantId)) {
      const variantRes = await db.query<{
        id: string;
        product_id: string;
        layer_spec_jsonb: Record<string, unknown> | string | null;
      }>('SELECT id, product_id, layer_spec_jsonb FROM product_variants WHERE id = $1', [
        input.variantId,
      ]);
      const variant = variantRes.rows[0];
      if (variant) {
        targetProductId = variant.product_id;
        const mergedSpec = {
          ...parseJsonField<Record<string, unknown>>(variant.layer_spec_jsonb, {}),
          ...(input.spatialMetadata ?? {}),
        };

        await db.query(
          `UPDATE product_variants SET
             rack_front_asset_id = COALESCE($2, rack_front_asset_id),
             rack_front_url = COALESCE($3, rack_front_url),
             rack_back_url = COALESCE($4, rack_back_url),
             studio_layer_url = COALESCE($5, studio_layer_url),
             tryon_flat_preview_url = COALESCE($6, tryon_flat_preview_url),
             layer_spec_jsonb = $7::jsonb
           WHERE id = $1`,
          [
            variant.id,
            input.assetType === 'RACK_CUTOUT_2_3' ? input.assetId : null,
            input.rackFrontUrl ??
              (input.assetType === 'RACK_CUTOUT_2_3' ? input.publicUrl : null),
            input.rackBackUrl ?? null,
            input.studioLayerUrl ??
              (input.assetType === 'STUDIO_LAYER' ? input.publicUrl : null),
            input.flatAssetUrl ??
              (input.assetType === 'TRYON_FLAT_3_4' ? input.publicUrl : null),
            JSON.stringify(mergedSpec),
          ],
        );
      }
    }

    if (targetProductId && UUID_REGEX.test(targetProductId)) {
      if (input.assetType === 'TRYON_FLAT_3_4' || input.flatAssetUrl) {
        await db.query(
          `UPDATE products SET
             tryon_flat_asset_url = COALESCE($2, tryon_flat_asset_url),
             updated_at = NOW()
           WHERE id = $1`,
          [targetProductId, input.flatAssetUrl ?? input.publicUrl ?? null],
        );
      }
      const updated = await this.getAdminProductByIdOrSlug(targetProductId);
      await this.meili.syncProducts([updated]);
      return {
        updated: true,
        productId: targetProductId,
        variantId: input.variantId,
      };
    }

    return { updated: false };
  }

  // ==========================================================================
  // Phase 5: Cache Invalidation, On-Demand ISR, AI Lookbook Studio & Stock Sync
  // ==========================================================================

  private async invalidateStorefrontCaches(slugs: string[] = []): Promise<void> {
    const patterns = [
      'bff:storefront:*',
      'bff:product:*',
      'bff:bootstrap:*',
      'bff:rack:*',
      'catalog:*',
    ];
    for (const pattern of patterns) {
      try {
        await this.redisClient.delByPattern(pattern);
      } catch {
        // Non-fatal if Redis is offline
      }
    }
    const directKeys = slugs.flatMap((slug) => [
      `bff:storefront:product:${slug}`,
      `bff:product:${slug}`,
    ]);
    if (directKeys.length > 0) {
      try {
        await this.redisClient.del(...directKeys);
      } catch {
        // Non-fatal if Redis is offline
      }
    }
  }

  private async triggerStorefrontRevalidate(
    slugs: string[],
    correlationId?: string,
    traceparent?: string,
  ): Promise<boolean> {
    const uniqueSlugs = Array.from(new Set(slugs.filter((s) => s.trim().length > 0)));
    const paths = ['/', '/bo-suu-tap', ...uniqueSlugs.map((slug) => `/san-pham/${slug}`)];
    const tags = [
      'storefront',
      'products',
      ...uniqueSlugs.map((slug) => `product:${slug}`),
    ];

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);
    try {
      const res = await fetch(`${this.config.infra.storefrontUrl}/api/revalidate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-revalidate-secret': this.config.infra.revalidateSecret,
          ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
          [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
        },
        body: JSON.stringify({ tags, paths }),
        signal: controller.signal,
      });
      return res.ok;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  private mapLookbookSessionRow(row: LookbookSessionRow): LookbookStudioSessionView {
    const normalizedStatus: 'GENERATED' | 'ATTACHED' =
      row.status === 'ATTACHED' ? 'ATTACHED' : 'GENERATED';
    const createdAtIso = toIsoString(row.created_at);
    return {
      id: row.id,
      productId: row.product_id,
      variantId: row.variant_id,
      virtualModelCode: row.virtual_model_code,
      scenePrompt: row.scene_prompt,
      sourceGarmentUrl: row.source_garment_url,
      resultUrl: row.result_url,
      bucket: this.config.infra.minioBucketPublic,
      objectKey: row.object_key,
      providerUsed: row.provider_used,
      width: 960,
      height: 1280,
      status: normalizedStatus,
      approvedForGallery: normalizedStatus === 'ATTACHED',
      attachedAt: row.attached_at ? toIsoString(row.attached_at) : null,
      createdByUserId: row.created_by,
      createdAt: createdAtIso,
      completedAt: createdAtIso,
    };
  }

  public async listLookbookSessions(
    productIdOrSlug: string,
  ): Promise<LookbookStudioSessionView[]> {
    const product = await this.getAdminProductByIdOrSlug(productIdOrSlug);
    const db = await this.dbService.getClient();
    const res = await db.query<LookbookSessionRow>(
      `SELECT id, product_id, variant_id, virtual_model_code, scene_prompt,
              source_garment_url, result_url, object_key, provider_used,
              status, attached_at, created_by, created_at
       FROM lookbook_studio_sessions
       WHERE product_id = $1
       ORDER BY created_at DESC`,
      [product.id],
    );
    return res.rows.map((row) => this.mapLookbookSessionRow(row));
  }

  public async generateLookbookSession(
    productIdOrSlug: string,
    input: {
      variantId?: string | null;
      virtualModelCode: VirtualModelCode;
      scenePrompt: string;
    },
    createdBy?: string,
    correlationId?: string,
    traceparent?: string,
  ): Promise<LookbookStudioSessionView> {
    const product = await this.getAdminProductByIdOrSlug(productIdOrSlug);

    let targetVariant: ProductVariantDto | undefined;
    if (input.variantId) {
      targetVariant = product.variants.find((v) => v.id === input.variantId);
      if (!targetVariant) {
        throw new NotFoundException({
          code: ErrorCode.NOT_FOUND,
          message: `Variant "${input.variantId}" does not belong to product "${product.id}"`,
        });
      }
    } else {
      targetVariant = product.variants[0];
    }

    const sourceGarmentUrl =
      targetVariant?.tryonFlatPreviewUrl ??
      product.tryonFlatAssetUrl ??
      targetVariant?.lookbookMainUrl ??
      null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20_000);
    let generated: {
      lookbookId?: string;
      resultUrl: string;
      objectKey: string;
      providerUsed: string;
      width?: number;
      height?: number;
    };

    try {
      const response = await fetch(
        `${this.config.infra.aiTryOnServiceUrl}/v1/tryon/lookbook-generate`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Accept: 'application/json',
            ...(correlationId ? { 'X-Correlation-Id': correlationId } : {}),
            [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
          },
          body: JSON.stringify({
            productId: product.id,
            variantId: targetVariant?.id ?? null,
            garmentImageUrl: sourceGarmentUrl,
            virtualModelCode: input.virtualModelCode,
            scenePrompt: input.scenePrompt,
            productName: product.name,
          }),
          signal: controller.signal,
        },
      );

      const rawJson = (await response.json().catch(() => null)) as
        | {
            success?: boolean;
            data?: Record<string, unknown>;
            error?: { code?: string; message?: string };
          }
        | null;

      if (!response.ok || !rawJson) {
        const errMsg =
          rawJson?.error?.message ??
          `AI Try-On Lookbook generator returned HTTP ${response.status}`;
        if (response.status >= 400 && response.status < 500) {
          throw new BadRequestException({
            code: rawJson?.error?.code ?? ErrorCode.VALIDATION_ERROR,
            message: errMsg,
          });
        }
        throw new BadGatewayException({
          code: ErrorCode.DEPENDENCY_UNAVAILABLE,
          message: errMsg,
        });
      }

      const payload = (rawJson.data ?? rawJson) as Record<string, unknown>;
      const resultUrl = typeof payload.resultUrl === 'string' ? payload.resultUrl : '';
      const objectKey = typeof payload.objectKey === 'string' ? payload.objectKey : '';
      const providerUsed =
        typeof payload.providerUsed === 'string' ? payload.providerUsed : 'MOCK';

      if (!resultUrl || !objectKey) {
        throw new BadGatewayException({
          code: ErrorCode.DEPENDENCY_UNAVAILABLE,
          message: 'AI Lookbook generator returned incomplete asset metadata',
        });
      }

      generated = {
        lookbookId:
          typeof payload.lookbookId === 'string' && UUID_REGEX.test(payload.lookbookId)
            ? payload.lookbookId
            : undefined,
        resultUrl,
        objectKey,
        providerUsed,
        width: typeof payload.width === 'number' ? payload.width : 960,
        height: typeof payload.height === 'number' ? payload.height : 1280,
      };
    } catch (error) {
      if (
        error instanceof BadRequestException ||
        error instanceof BadGatewayException ||
        error instanceof NotFoundException
      ) {
        throw error;
      }
      throw new BadGatewayException({
        code: ErrorCode.DEPENDENCY_UNAVAILABLE,
        message: `Failed to reach AI Lookbook service: ${
          error instanceof Error ? error.message : String(error)
        }`,
      });
    } finally {
      clearTimeout(timer);
    }

    const sessionId = generated.lookbookId ?? randomUUID();
    const db = await this.dbService.getClient();
    const inserted = await db.query<LookbookSessionRow>(
      `INSERT INTO lookbook_studio_sessions (
         id, product_id, variant_id, virtual_model_code, scene_prompt,
         source_garment_url, result_url, object_key, provider_used,
         status, created_by
       ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'GENERATED', $10)
       RETURNING id, product_id, variant_id, virtual_model_code, scene_prompt,
                 source_garment_url, result_url, object_key, provider_used,
                 status, attached_at, created_by, created_at`,
      [
        sessionId,
        product.id,
        targetVariant?.id ?? null,
        input.virtualModelCode,
        input.scenePrompt,
        sourceGarmentUrl,
        generated.resultUrl,
        generated.objectKey,
        generated.providerUsed,
        createdBy?.slice(0, 64) ?? null,
      ],
    );

    const mapped = this.mapLookbookSessionRow(inserted.rows[0]);
    mapped.width = generated.width ?? 960;
    mapped.height = generated.height ?? 1280;
    return mapped;
  }

  public async attachLookbookSession(
    productIdOrSlug: string,
    sessionId: string,
    correlationId?: string,
    traceparent?: string,
  ): Promise<{
    session: LookbookStudioSessionView;
    productSlug: string;
    attachedImageUrl: string;
    isrRevalidated: boolean;
  }> {
    const product = await this.getAdminProductByIdOrSlug(productIdOrSlug);
    if (!UUID_REGEX.test(sessionId)) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Lookbook session "${sessionId}" not found`,
      });
    }

    const db = await this.dbService.getClient();
    const existingRes = await db.query<LookbookSessionRow>(
      `SELECT id, product_id, variant_id, virtual_model_code, scene_prompt,
              source_garment_url, result_url, object_key, provider_used,
              status, attached_at, created_by, created_at
       FROM lookbook_studio_sessions
       WHERE id = $1 AND product_id = $2`,
      [sessionId, product.id],
    );
    const existing = existingRes.rows[0];
    if (!existing) {
      throw new NotFoundException({
        code: ErrorCode.NOT_FOUND,
        message: `Lookbook session "${sessionId}" not found for product "${product.id}"`,
      });
    }

    const targetVariantId =
      existing.variant_id ?? product.variants[0]?.id ?? null;

    const updatedSessionRes = await db.transaction(async (tx) => {
      const updated = await tx.query<LookbookSessionRow>(
        `UPDATE lookbook_studio_sessions
         SET status = 'ATTACHED',
             attached_at = NOW()
         WHERE id = $1
         RETURNING id, product_id, variant_id, virtual_model_code, scene_prompt,
                   source_garment_url, result_url, object_key, provider_used,
                   status, attached_at, created_by, created_at`,
        [existing.id],
      );

      if (targetVariantId) {
        await tx.query(
          `UPDATE product_variants
           SET lookbook_main_url = $2
           WHERE id = $1`,
          [targetVariantId, existing.result_url],
        );
      }

      const existingMedia = await tx.query<{ id: string }>(
        `SELECT id FROM product_media
         WHERE product_id = $1 AND source_session_id = $2
         LIMIT 1`,
        [product.id, existing.id],
      );

      if (existingMedia.rows.length > 0) {
        await tx.query(
          `UPDATE product_media
           SET variant_id = $2,
               media_type = 'LOOKBOOK',
               url = $3,
               object_key = $4
           WHERE id = $1`,
          [
            existingMedia.rows[0].id,
            targetVariantId,
            existing.result_url,
            existing.object_key,
          ],
        );
      } else {
        await tx.query(
          `INSERT INTO product_media (
             id, product_id, variant_id, media_type, url, object_key,
             source_session_id, sort_order
           ) VALUES ($1, $2, $3, 'LOOKBOOK', $4, $5, $6, 0)`,
          [
            randomUUID(),
            product.id,
            targetVariantId,
            existing.result_url,
            existing.object_key,
            existing.id,
          ],
        );
      }

      await tx.query(
        'UPDATE products SET updated_at = NOW() WHERE id = $1',
        [product.id],
      );

      return updated;
    });

    const refreshedProduct = await this.getAdminProductByIdOrSlug(product.id);
    await this.meili.syncProducts([refreshedProduct]);
    await this.invalidateStorefrontCaches([product.slug]);
    const isrRevalidated = await this.triggerStorefrontRevalidate(
      [product.slug],
      correlationId,
      traceparent,
    );

    return {
      session: this.mapLookbookSessionRow(updatedSessionRes.rows[0]),
      productSlug: product.slug,
      attachedImageUrl: existing.result_url,
      isrRevalidated,
    };
  }

  public async handleStockReplenished(
    input: StockReplenishedInput,
    correlationId?: string,
    traceparent?: string,
  ): Promise<{
    synced: boolean;
    updatedSkuCount: number;
    updatedProductIds: string[];
    updatedProductSlugs: string[];
    meilisearchSynced: boolean;
  }> {
    const db = await this.dbService.getClient();
    const affectedProductIds = new Set<string>();
    let updatedSkuCount = 0;

    // 1. Apply explicit per-SKU item updates (with availableQty if given, else true)
    const items = input.items ?? [];
    for (const item of items) {
      const nextInStock =
        typeof item.availableQty === 'number' ? item.availableQty > 0 : true;

      if (item.skuId && UUID_REGEX.test(item.skuId)) {
        const res = await db.query<{ id: string; product_id: string }>(
          `UPDATE skus s
           SET in_stock = $2
           FROM product_variants v
           WHERE s.variant_id = v.id AND s.id = $1
           RETURNING s.id, v.product_id`,
          [item.skuId, nextInStock],
        );
        for (const row of res.rows) {
          updatedSkuCount += 1;
          affectedProductIds.add(row.product_id);
        }
      } else if (item.skuCode && item.skuCode.trim().length > 0) {
        const res = await db.query<{ id: string; product_id: string }>(
          `UPDATE skus s
           SET in_stock = $2
           FROM product_variants v
           WHERE s.variant_id = v.id AND s.sku_code = $1
           RETURNING s.id, v.product_id`,
          [item.skuCode.trim(), nextInStock],
        );
        for (const row of res.rows) {
          updatedSkuCount += 1;
          affectedProductIds.add(row.product_id);
        }
      }

      if (item.productId && UUID_REGEX.test(item.productId)) {
        affectedProductIds.add(item.productId);
      }
    }

    // 2. Apply bulk skuIds (all marked in_stock = true)
    const validSkuIds = (input.skuIds ?? []).filter((id) => UUID_REGEX.test(id));
    if (validSkuIds.length > 0) {
      const res = await db.query<{ id: string; product_id: string }>(
        `UPDATE skus s
         SET in_stock = TRUE
         FROM product_variants v
         WHERE s.variant_id = v.id AND s.id = ANY($1::uuid[])
         RETURNING s.id, v.product_id`,
        [validSkuIds],
      );
      for (const row of res.rows) {
        updatedSkuCount += 1;
        affectedProductIds.add(row.product_id);
      }
    }

    // 3. Apply explicit productIds (if no SKU rows were supplied, mark their SKUs in_stock = true)
    const validProductIds = (input.productIds ?? []).filter((id) =>
      UUID_REGEX.test(id),
    );
    for (const pid of validProductIds) {
      affectedProductIds.add(pid);
    }
    if (
      validProductIds.length > 0 &&
      items.length === 0 &&
      validSkuIds.length === 0
    ) {
      const res = await db.query<{ id: string }>(
        `UPDATE skus s
         SET in_stock = TRUE
         FROM product_variants v
         WHERE s.variant_id = v.id AND v.product_id = ANY($1::uuid[])
         RETURNING s.id`,
        [validProductIds],
      );
      updatedSkuCount += res.rows.length;
    }

    const updatedProductIds = Array.from(affectedProductIds);
    if (updatedProductIds.length === 0) {
      return {
        synced: true,
        updatedSkuCount,
        updatedProductIds: [],
        updatedProductSlugs: [],
        meilisearchSynced: true,
      };
    }

    // 4. Recompute stock_status_summary for each affected product
    const refreshedProducts: ProductSpuDto[] = [];
    for (const productId of updatedProductIds) {
      const skuStateRes = await db.query<{ in_stock: boolean }>(
        `SELECT s.in_stock
         FROM skus s
         JOIN product_variants v ON v.id = s.variant_id
         WHERE v.product_id = $1`,
        [productId],
      );
      const inStockCount = skuStateRes.rows.filter((r) => r.in_stock).length;
      const summary =
        inStockCount === 0
          ? StockStatusSummary.OUT_OF_STOCK
          : inStockCount === 1
            ? StockStatusSummary.LOW_STOCK
            : StockStatusSummary.IN_STOCK;

      await db.query(
        `UPDATE products
         SET stock_status_summary = $2,
             updated_at = NOW()
         WHERE id = $1`,
        [productId, summary],
      );

      try {
        const prod = await this.getAdminProductByIdOrSlug(productId);
        refreshedProducts.push(prod);
      } catch {
        // Ignore unknown product IDs
      }
    }

    const publishedToSync = refreshedProducts.filter(
      (p) => p.status === ProductStatus.PUBLISHED,
    );
    const meilisearchSynced =
      publishedToSync.length > 0
        ? await this.meili.syncProducts(publishedToSync)
        : true;

    const updatedProductSlugs = refreshedProducts.map((p) => p.slug);
    await this.invalidateStorefrontCaches(updatedProductSlugs);
    void this.triggerStorefrontRevalidate(
      updatedProductSlugs,
      correlationId,
      traceparent,
    );

    return {
      synced: true,
      updatedSkuCount,
      updatedProductIds: refreshedProducts.map((p) => p.id),
      updatedProductSlugs,
      meilisearchSynced,
    };
  }
}
