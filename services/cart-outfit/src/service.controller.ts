import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  createApiResponse,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type ApiResponse,
  type DependencyCheck,
} from '@atelier/contracts';
import {
  buildHealthPayload,
  buildReadinessPayload,
  getOrCreateCorrelationId,
  type HeaderBag,
  type StandardHealthPayload,
  type StandardReadinessPayload,
} from '@atelier/observability';
import { CartRedisService } from './cache/cart-redis.service';
import { CART_CONFIG_TOKEN, type CartOutfitConfig } from './config/env';
import { CartDbService } from './db/cart-db.service';

@Controller()
export class CartOutfitController {
  constructor(
    @Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig,
    private readonly db: CartDbService,
    private readonly redis: CartRedisService,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: this.db.getMode(),
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const [dbCheck, redisCheck] = await Promise.all([
      this.db.ping(),
      this.redis.checkHealth(),
    ]);

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-cart-db',
        status: dbCheck.ok ? 'up' : 'down',
        latencyMs: dbCheck.latencyMs,
        detail: `${this.config.database.envVar} -> ${dbCheck.detail}`,
      },
      {
        name: 'redis-active-cart',
        status: redisCheck.ok ? 'up' : 'skipped',
        latencyMs: redisCheck.latencyMs,
        detail: redisCheck.detail,
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: dbCheck.mode,
        databaseEnvVar: this.config.database.envVar,
      },
    });
  }

  @Get('api/v1/cart/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-4',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          mode: this.db.getMode(),
          configured: this.config.database.configured,
        },
        storage: {
          redisTtlSeconds: this.config.cartRedisTtlSeconds,
          keyPatterns: ['cart:user:{userId}', 'cart:guest:{guestSessionId}'],
          dualWriteThrough: true,
        },
        pricingRules: {
          serverAuthoritative: true,
          reserveStockOnAddToCart: false,
          comboDiscountTiers: {
            twoDistinctSlotsPct: 5,
            threeOrMoreDistinctSlotsPct: 10,
          },
          freeShipThresholdVnd: this.config.freeShipThresholdVnd,
        },
        aggregates: ['carts', 'cart_items', 'saved_outfits'],
        outfitStudioLayers: ['TOP', 'BOTTOM', 'ONE_PIECE', 'OUTERWEAR', 'ACCESSORY'],
        upstreams: this.config.upstreams,
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          publishes: ['cart.abandoned', 'outfit.saved'],
          consumes: [EVENT_NAMES.ORDER_CREATED],
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
