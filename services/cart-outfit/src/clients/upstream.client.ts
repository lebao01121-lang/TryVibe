import { Inject, Injectable } from '@nestjs/common';
import type { SkuAvailabilityDto } from '@atelier/contracts';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import {
  CART_CONFIG_TOKEN,
  SERVICE_NAME,
  type CartOutfitConfig,
} from '../config/env';

export interface CatalogSkuSnapshot {
  skuId: string;
  skuCode: string;
  variantId: string;
  productId: string;
  productName: string;
  productSlug: string;
  colorName: string;
  colorHex: string;
  sizeCode: string;
  basePriceVnd: number;
  salePriceVnd: number;
  effectivePriceVnd: number;
  inStock: boolean;
  imageUrl: string | null;
}

export interface PackagingOptionInfo {
  id: string;
  code: string;
  name: string;
  priceVnd: number;
  isDefault: boolean;
}

export interface SkuSnapshotFetchResult {
  reachable: boolean;
  map: Map<string, CatalogSkuSnapshot>;
}

export interface AvailabilityFetchResult {
  reachable: boolean;
  map: Map<string, SkuAvailabilityDto>;
}

const DEFAULT_PACKAGING_OPTIONS: readonly PackagingOptionInfo[] = [
  {
    id: 'tui-vai-linen-moc',
    code: 'tui-vai-linen-moc',
    name: 'Túi Vải Linen Mộc Tiêu Chuẩn',
    priceVnd: 0,
    isDefault: true,
  },
  {
    id: 'hop-lua-co-dien',
    code: 'hop-lua-co-dien',
    name: 'Hộp Lụa Cổ Điển Ivory',
    priceVnd: 80_000,
    isDefault: false,
  },
  {
    id: 'hop-qua-khac-ten-gold',
    code: 'hop-qua-khac-ten-gold',
    name: 'Hộp Quà Khắc Tên Ánh Kim Gold',
    priceVnd: 150_000,
    isDefault: false,
  },
] as const;

const PACKAGING_CACHE_TTL_MS = 30_000;

@Injectable()
export class UpstreamClientService {
  private readonly logger = createLogger(SERVICE_NAME);
  private packagingCache: { items: PackagingOptionInfo[]; expiresAt: number } | null = null;

  constructor(@Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig) {}

  async fetchSkusSnapshot(
    skuIds: string[],
    correlationId: string,
    traceparent?: string,
  ): Promise<SkuSnapshotFetchResult> {
    const uniqueIds = Array.from(new Set(skuIds.map((id) => id.trim()).filter(Boolean)));
    const map = new Map<string, CatalogSkuSnapshot>();

    if (uniqueIds.length === 0) {
      return { reachable: true, map };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);

    try {
      const response = await fetch(
        `${this.config.upstreams.catalogServiceUrl}/v1/catalog/internal/skus/snapshot`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': correlationId,
            [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
          },
          body: JSON.stringify({ skuIds: uniqueIds }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, correlationId },
          'catalog-lookbook SKU snapshot returned non-OK status',
        );
        return { reachable: false, map };
      }

      const json = (await response.json()) as { data?: unknown };
      const rows = Array.isArray(json.data) ? json.data : [];
      for (const item of rows) {
        if (!item || typeof item !== 'object') {
          continue;
        }
        const rec = item as Record<string, unknown>;
        const skuId = typeof rec.skuId === 'string' ? rec.skuId : '';
        if (!skuId) {
          continue;
        }
        const basePriceVnd = Number(rec.basePriceVnd ?? 0);
        const effectivePriceVnd = Number(
          rec.effectivePriceVnd ?? rec.salePriceVnd ?? basePriceVnd,
        );
        map.set(skuId, {
          skuId,
          skuCode: String(rec.skuCode ?? skuId),
          variantId: String(rec.variantId ?? ''),
          productId: String(rec.productId ?? ''),
          productName: String(rec.productName ?? 'Thiết kế Tầm Xuân'),
          productSlug: String(rec.productSlug ?? ''),
          colorName: String(rec.colorName ?? 'Mặc định'),
          colorHex: String(rec.colorHex ?? '#1C1410'),
          sizeCode: String(rec.sizeCode ?? 'M'),
          basePriceVnd: Number.isFinite(basePriceVnd) ? Math.max(0, Math.round(basePriceVnd)) : 0,
          salePriceVnd: Number.isFinite(effectivePriceVnd)
            ? Math.max(0, Math.round(effectivePriceVnd))
            : 0,
          effectivePriceVnd: Number.isFinite(effectivePriceVnd)
            ? Math.max(0, Math.round(effectivePriceVnd))
            : 0,
          inStock: rec.inStock !== false,
          imageUrl: typeof rec.imageUrl === 'string' && rec.imageUrl.length > 0 ? rec.imageUrl : null,
        });
      }

      return { reachable: true, map };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Failed to reach catalog-lookbook SKU snapshot endpoint',
      );
      return { reachable: false, map };
    } finally {
      clearTimeout(timer);
    }
  }

  async fetchPackagingOptions(
    correlationId: string,
    traceparent?: string,
  ): Promise<PackagingOptionInfo[]> {
    if (this.packagingCache && Date.now() < this.packagingCache.expiresAt) {
      return this.packagingCache.items;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(
        `${this.config.upstreams.catalogServiceUrl}/v1/catalog/bootstrap`,
        {
          method: 'GET',
          headers: {
            Accept: 'application/json',
            'X-Correlation-Id': correlationId,
            [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
          },
          signal: controller.signal,
        },
      );

      if (response.ok) {
        const json = (await response.json()) as {
          data?: { packagingOptions?: Array<Record<string, unknown>> };
        };
        const rawList = Array.isArray(json.data?.packagingOptions)
          ? json.data.packagingOptions
          : [];
        if (rawList.length > 0) {
          const items: PackagingOptionInfo[] = rawList.map((raw) => ({
            id: String(raw.id ?? raw.code ?? ''),
            code: String(raw.code ?? raw.id ?? ''),
            name: String(raw.name ?? 'Đóng gói tiêu chuẩn'),
            priceVnd: Math.max(0, Math.round(Number(raw.priceVnd ?? 0) || 0)),
            isDefault: Boolean(raw.isDefault),
          }));
          this.packagingCache = {
            items,
            expiresAt: Date.now() + PACKAGING_CACHE_TTL_MS,
          };
          return items;
        }
      }
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'Using fallback packaging options (catalog-lookbook bootstrap unreachable)',
      );
    } finally {
      clearTimeout(timer);
    }

    return [...DEFAULT_PACKAGING_OPTIONS];
  }

  async resolvePackagingOption(
    packagingOptionId: string | null | undefined,
    correlationId: string,
    traceparent?: string,
  ): Promise<PackagingOptionInfo | null> {
    if (!packagingOptionId || packagingOptionId.trim() === '') {
      return null;
    }
    const target = packagingOptionId.trim();
    const options = await this.fetchPackagingOptions(correlationId, traceparent);
    const matched = options.find((opt) => opt.id === target || opt.code === target);
    if (matched) {
      return matched;
    }
    const fallback = DEFAULT_PACKAGING_OPTIONS.find(
      (opt) => opt.id === target || opt.code === target,
    );
    return fallback ?? null;
  }

  async fetchBatchAvailability(
    skuIds: string[],
    correlationId: string,
    traceparent?: string,
  ): Promise<AvailabilityFetchResult> {
    const uniqueIds = Array.from(new Set(skuIds.map((id) => id.trim()).filter(Boolean)));
    const map = new Map<string, SkuAvailabilityDto>();

    if (uniqueIds.length === 0) {
      return { reachable: true, map };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2500);

    try {
      const response = await fetch(
        `${this.config.upstreams.inventoryServiceUrl}/v1/inventory/availability/batch`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Correlation-Id': correlationId,
            [TRACEPARENT_HEADER]: createChildTraceparent(traceparent),
          },
          body: JSON.stringify({ skuIds: uniqueIds }),
          signal: controller.signal,
        },
      );

      if (!response.ok) {
        this.logger.warn(
          { status: response.status, correlationId },
          'inventory availability/batch returned non-OK status (using graceful fallback)',
        );
        return { reachable: false, map };
      }

      const json = (await response.json()) as {
        data?: {
          items?: Record<string, SkuAvailabilityDto>;
          list?: SkuAvailabilityDto[];
        };
      };

      const recordMap = json.data?.items;
      if (recordMap && typeof recordMap === 'object') {
        for (const [key, entry] of Object.entries(recordMap)) {
          if (entry && typeof entry === 'object') {
            map.set(entry.skuId || key, entry);
          }
        }
      }

      if (map.size === 0 && Array.isArray(json.data?.list)) {
        for (const entry of json.data.list) {
          if (entry && typeof entry === 'object' && entry.skuId) {
            map.set(entry.skuId, entry);
          }
        }
      }

      return { reachable: true, map };
    } catch (error: unknown) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error), correlationId },
        'inventory service unreachable — using graceful stock fallback (never reserves stock)',
      );
      return { reachable: false, map };
    } finally {
      clearTimeout(timer);
    }
  }
}
