import { Inject, Injectable } from '@nestjs/common';
import { createLogger, type Logger } from '@atelier/observability';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';
import { HttpProxyService } from './http-proxy.service';
import { BffRedisService } from './redis.service';

export const STOREFRONT_BOOTSTRAP_CACHE_KEY = 'storefront:bootstrap:v1';
export const STOREFRONT_RACK_CACHE_KEY = 'storefront:rack:v1';
export const STOREFRONT_OCCASIONS_CACHE_KEY = 'storefront:occasions:v1';
export const STOREFRONT_SEASONS_CACHE_KEY = 'storefront:seasons:v1';
export const STOREFRONT_CATEGORIES_CACHE_KEY = 'bff:storefront:categories';

export interface RevalidationResult {
  deletedKeys: number;
  revalidated: boolean;
  status?: number;
  tags: string[];
  paths: string[];
}

@Injectable()
export class CacheInvalidationService {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);

  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
  ) {}

  async invalidateAndRevalidate(
    tags: string[],
    paths: string[] = [],
    correlationId?: string,
  ): Promise<RevalidationResult> {
    const [fixedDeleted, patternDeleted] = await Promise.all([
      this.redis.delSafe(
        STOREFRONT_BOOTSTRAP_CACHE_KEY,
        STOREFRONT_RACK_CACHE_KEY,
        STOREFRONT_OCCASIONS_CACHE_KEY,
        STOREFRONT_SEASONS_CACHE_KEY,
        STOREFRONT_CATEGORIES_CACHE_KEY,
      ),
      this.redis.delByPatternSafe('bff:storefront:*'),
    ]);

    const deletedKeys = fixedDeleted + patternDeleted;
    const uniqueTags = Array.from(new Set(tags.filter((t) => t.trim().length > 0)));
    const uniquePaths = Array.from(new Set(paths.filter((p) => p.trim().length > 0)));

    let revalidated = false;
    let status: number | undefined;

    try {
      const revalidateUrl = `${this.config.storefrontUrl}/api/revalidate`;
      const res = await this.proxy.request({
        method: 'POST',
        url: revalidateUrl,
        body: {
          tags: uniqueTags,
          paths: uniquePaths,
        },
        extraHeaders: {
          'x-revalidate-secret': this.config.revalidateSecret,
        },
        correlationId,
        timeoutMs: 2500,
      });

      status = res.status;
      revalidated = res.ok;

      if (res.ok) {
        this.logger.info(
          { deletedKeys, tags: uniqueTags, paths: uniquePaths, status, correlationId },
          'Storefront Redis cache invalidated and Next.js On-Demand ISR revalidated',
        );
      } else {
        this.logger.warn(
          { deletedKeys, tags: uniqueTags, paths: uniquePaths, status, correlationId },
          'Storefront Redis cache invalidated; Next.js On-Demand ISR returned non-2xx',
        );
      }
    } catch (error) {
      this.logger.warn(
        {
          deletedKeys,
          tags: uniqueTags,
          paths: uniquePaths,
          correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Storefront Redis cache invalidated; Next.js On-Demand ISR webhook unreachable (non-fatal)',
      );
    }

    return {
      deletedKeys,
      revalidated,
      ...(status !== undefined ? { status } : {}),
      tags: uniqueTags,
      paths: uniquePaths,
    };
  }
}
