import { Inject, Injectable } from '@nestjs/common';
import type { ProductSpuDto } from '@atelier/contracts';
import { isTcpReachable } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import { MeiliSearch } from 'meilisearch';
import {
  CATALOG_CONFIG_TOKEN,
  type CatalogLookbookConfig,
  SERVICE_NAME,
} from '../config/env';

export const ATELIER_PRODUCTS_INDEX = 'atelier_products';

export interface MeiliProductDocument {
  id: string;
  slug: string;
  name: string;
  subtitle: string;
  categorySlug: string;
  categoryName: string;
  fabricComposition: string;
  description: string;
  occasionSlugs: string[];
  seasonSlugs: string[];
  sizes: string[];
  inStockSizes: string[];
  inStock: boolean;
  stockStatusSummary: string;
  colorFamily: string[];
  gender: string;
  isTryonEnabled: boolean;
  minPriceVnd: number;
  status: string;
  createdAt: string;
}

export interface ProductSearchQuery {
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
  status?: string;
  sort?: string;
  limit: number;
  offset: number;
}

export interface MeiliSearchExecutionResult {
  usedMeilisearch: boolean;
  hitIds: string[];
  totalHits: number;
  processingTimeMs: number;
}

export const VIETNAMESE_CATALOG_SYNONYMS: Record<string, string[]> = {
  'đầm dự tiệc': ['váy đi tiệc', 'đầm đi tiệc', 'vay di tiec'],
  'váy đi tiệc': ['đầm dự tiệc', 'đầm đi tiệc'],
  'áo khoác': ['blazer', 'trench', 'ao khoac'],
  blazer: ['áo khoác', 'ao khoac'],
  'quần tây': ['quần âu', 'quan tay', 'quan au'],
  'quần âu': ['quần tây', 'quan tay'],
  'áo sơ mi lụa': ['ao so mi lua', 'sơ mi lụa'],
};

function parseHostPort(urlString: string): { host: string; port: number } {
  try {
    const parsed = new URL(urlString);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port
        ? Number.parseInt(parsed.port, 10)
        : parsed.protocol === 'https:'
          ? 443
          : 7700,
    };
  } catch {
    return { host: '127.0.0.1', port: 7700 };
  }
}

function escapeFilterValue(value: string): string {
  return value.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

export function toMeiliDocument(product: ProductSpuDto): MeiliProductDocument {
  const sizesSet = new Set<string>();
  const inStockSizesSet = new Set<string>();
  const colorsSet = new Set<string>();

  for (const variant of product.variants) {
    colorsSet.add(variant.colorName);
    for (const sku of variant.skus) {
      sizesSet.add(sku.sizeCode);
      if (sku.inStock) {
        inStockSizesSet.add(sku.sizeCode);
      }
    }
  }

  return {
    id: product.id,
    slug: product.slug,
    name: product.name,
    subtitle: product.subtitle ?? '',
    categorySlug: product.categorySlug,
    categoryName: product.categoryName,
    fabricComposition: product.fabricComposition,
    description: product.description,
    occasionSlugs: product.occasionSlugs,
    seasonSlugs: product.seasonSlugs,
    sizes: Array.from(sizesSet),
    inStockSizes: Array.from(inStockSizesSet),
    inStock: inStockSizesSet.size > 0,
    stockStatusSummary: product.stockStatusSummary,
    colorFamily: Array.from(colorsSet),
    gender: product.gender,
    isTryonEnabled: product.isTryonEnabled,
    minPriceVnd: product.minPriceVnd,
    status: product.status,
    createdAt: product.createdAt,
  };
}

@Injectable()
export class MeilisearchService {
  private readonly logger = createLogger(`${SERVICE_NAME}:meilisearch`);
  private readonly client: MeiliSearch;
  private settingsConfigured = false;
  private lastKnownHealthy = false;

  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    private readonly config: CatalogLookbookConfig,
  ) {
    this.client = new MeiliSearch({
      host: this.config.infra.meilisearchHost,
      apiKey: this.config.infra.meilisearchMasterKey,
    });
  }

  public isHealthy(): boolean {
    return this.lastKnownHealthy;
  }

  public async checkReachable(timeoutMs = 500): Promise<boolean> {
    const { host, port } = parseHostPort(this.config.infra.meilisearchHost);
    const ok = await isTcpReachable(host, port, timeoutMs);
    this.lastKnownHealthy = ok;
    return ok;
  }

  public async ensureIndexConfigured(): Promise<boolean> {
    if (!(await this.checkReachable(2500))) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      if (!(await this.checkReachable(2500))) {
        return false;
      }
    }

    if (this.settingsConfigured) {
      return true;
    }

    try {
      try {
        const createTask = await this.client.createIndex(ATELIER_PRODUCTS_INDEX, {
          primaryKey: 'id',
        });
        await this.client.waitForTask(createTask.taskUid);
      } catch {
        // Index may already exist
      }

      const index = this.client.index<MeiliProductDocument>(
        ATELIER_PRODUCTS_INDEX,
      );
      const settingsTask = await index.updateSettings({
        searchableAttributes: [
          'name',
          'subtitle',
          'categoryName',
          'fabricComposition',
          'description',
          'occasionSlugs',
          'seasonSlugs',
        ],
        filterableAttributes: [
          'categorySlug',
          'sizes',
          'inStockSizes',
          'inStock',
          'stockStatusSummary',
          'colorFamily',
          'occasionSlugs',
          'seasonSlugs',
          'gender',
          'isTryonEnabled',
          'minPriceVnd',
          'status',
        ],
        sortableAttributes: ['minPriceVnd', 'createdAt'],
        synonyms: VIETNAMESE_CATALOG_SYNONYMS,
      });

      await this.client.waitForTask(settingsTask.taskUid);

      this.settingsConfigured = true;
      this.lastKnownHealthy = true;
      return true;
    } catch (error) {
      this.lastKnownHealthy = false;
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Meilisearch index configuration skipped (unavailable)',
      );
      return false;
    }
  }

  public async syncProducts(products: readonly ProductSpuDto[]): Promise<boolean> {
    if (products.length === 0) {
      return true;
    }
    const ready = await this.ensureIndexConfigured();
    if (!ready) {
      return false;
    }

    try {
      const index = this.client.index<MeiliProductDocument>(
        ATELIER_PRODUCTS_INDEX,
      );
      const docs = products.map((product) => toMeiliDocument(product));
      const task = await index.addDocuments(docs, { primaryKey: 'id' });
      await this.client.waitForTask(task.taskUid);
      this.lastKnownHealthy = true;
      return true;
    } catch (error) {
      this.lastKnownHealthy = false;
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Failed to sync products to Meilisearch',
      );
      return false;
    }
  }

  public async searchProducts(
    query: ProductSearchQuery,
  ): Promise<MeiliSearchExecutionResult> {
    const startedAt = Date.now();
    const ready = await this.ensureIndexConfigured();
    if (!ready) {
      return {
        usedMeilisearch: false,
        hitIds: [],
        totalHits: 0,
        processingTimeMs: Date.now() - startedAt,
      };
    }

    const filters: string[] = [];
    if (query.status) {
      filters.push(`status = "${escapeFilterValue(query.status)}"`);
    }
    if (query.categorySlug) {
      filters.push(`categorySlug = "${escapeFilterValue(query.categorySlug)}"`);
    }
    if (query.size) {
      filters.push(`sizes = "${escapeFilterValue(query.size.toUpperCase())}"`);
    }
    if (query.inStockSize) {
      filters.push(
        `inStockSizes = "${escapeFilterValue(query.inStockSize.toUpperCase())}"`,
      );
    }
    if (query.color) {
      filters.push(`colorFamily = "${escapeFilterValue(query.color)}"`);
    }
    if (query.occasion) {
      filters.push(`occasionSlugs = "${escapeFilterValue(query.occasion)}"`);
    }
    if (query.season) {
      filters.push(`seasonSlugs = "${escapeFilterValue(query.season)}"`);
    }
    if (query.gender) {
      filters.push(`gender = "${escapeFilterValue(query.gender.toUpperCase())}"`);
    }
    if (query.isTryonEnabled !== undefined) {
      filters.push(`isTryonEnabled = ${query.isTryonEnabled ? 'true' : 'false'}`);
    }
    if (query.minPriceVnd !== undefined) {
      filters.push(`minPriceVnd >= ${Math.floor(query.minPriceVnd)}`);
    }
    if (query.maxPriceVnd !== undefined) {
      filters.push(`minPriceVnd <= ${Math.floor(query.maxPriceVnd)}`);
    }

    const sort: string[] = [];
    if (query.sort === 'price_asc' || query.sort === 'minPriceVnd:asc') {
      sort.push('minPriceVnd:asc');
    } else if (query.sort === 'price_desc' || query.sort === 'minPriceVnd:desc') {
      sort.push('minPriceVnd:desc');
    } else if (query.sort === 'newest' || query.sort === 'createdAt:desc') {
      sort.push('createdAt:desc');
    }

    try {
      const index = this.client.index<MeiliProductDocument>(
        ATELIER_PRODUCTS_INDEX,
      );
      const res = await index.search(query.q ?? '', {
        filter: filters.length > 0 ? filters : undefined,
        sort: sort.length > 0 ? sort : undefined,
        limit: query.limit,
        offset: query.offset,
      });

      this.lastKnownHealthy = true;
      return {
        usedMeilisearch: true,
        hitIds: res.hits.map((hit) => hit.id),
        totalHits: res.estimatedTotalHits ?? res.hits.length,
        processingTimeMs: res.processingTimeMs ?? Date.now() - startedAt,
      };
    } catch (error) {
      this.lastKnownHealthy = false;
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Meilisearch search failed — falling back to PostgreSQL catalog search',
      );
      return {
        usedMeilisearch: false,
        hitIds: [],
        totalHits: 0,
        processingTimeMs: Date.now() - startedAt,
      };
    }
  }
}
