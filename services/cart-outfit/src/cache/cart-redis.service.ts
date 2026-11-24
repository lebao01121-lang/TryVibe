import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  CART_CONFIG_TOKEN,
  SERVICE_NAME,
  type CartOutfitConfig,
} from '../config/env';

@Injectable()
export class CartRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private readonly client: AtelierRedisClient;

  constructor(@Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig) {
    this.client = createRedisClient({ url: this.config.infra.redisUrl });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.client.ping();
    if (ok) {
      this.logger.info(
        { ttlSeconds: this.config.cartRedisTtlSeconds },
        'Connected to Redis active cart cache (TTL 30 days)',
      );
    } else {
      this.logger.warn(
        'Redis is offline at boot — cart-outfit will fall back cleanly to cart_db until Redis comes online',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async checkHealth(): Promise<{ ok: boolean; latencyMs: number; detail: string }> {
    const start = Date.now();
    const ok = await this.client.ping();
    return {
      ok,
      latencyMs: Date.now() - start,
      detail: ok
        ? `Redis active cart cache ready (TTL=${this.config.cartRedisTtlSeconds}s)`
        : 'Redis unreachable — running in cart_db fallback mode',
    };
  }

  async getJson<T>(key: string): Promise<T | null> {
    try {
      const raw = await this.client.get(key);
      if (!raw) {
        return null;
      }
      return JSON.parse(raw) as T;
    } catch (error: unknown) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis read failure (falling back to cart_db)',
      );
      return null;
    }
  }

  async setJson(key: string, value: unknown, ttlSeconds?: number): Promise<void> {
    try {
      const ttl = ttlSeconds ?? this.config.cartRedisTtlSeconds;
      await this.client.set(key, JSON.stringify(value), ttl);
    } catch (error: unknown) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis write failure',
      );
    }
  }

  async del(...keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    try {
      await this.client.del(...keys);
    } catch (error: unknown) {
      this.logger.warn(
        { keys, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis delete failure',
      );
    }
  }
}
