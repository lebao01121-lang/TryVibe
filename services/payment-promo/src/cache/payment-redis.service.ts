import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  PAYMENT_CONFIG_TOKEN,
  SERVICE_NAME,
  type PaymentPromoConfig,
} from '../config/env';

@Injectable()
export class PaymentRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private readonly client: AtelierRedisClient;

  constructor(@Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig) {
    this.client = createRedisClient({ url: this.config.infra.redisUrl });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.client.ping();
    if (ok) {
      this.logger.info('Connected to Redis for Flash Sale atomic voucher counters');
    } else {
      this.logger.warn(
        'Redis offline at boot — payment-promo will enforce promotion limits via payment_db fallback',
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
        ? 'Redis flash-sale voucher lock ready'
        : 'Redis unreachable — DB-backed voucher lock fallback active',
    };
  }

  /**
   * Atomically increments `promo:flash:{code}` counter on Redis.
   * Seeds from DB `baselineUsedCount` via SET NX if key is missing.
   * On overflow (`next > usageLimit`), immediately decrements and returns `{ allowed: false }`.
   */
  async tryAcquireFlashCounter(
    code: string,
    usageLimit: number,
    baselineUsedCount: number,
  ): Promise<{ available: boolean; allowed: boolean; count: number }> {
    const key = `promo:flash:${code.toUpperCase()}`;
    try {
      const ok = await this.client.connect();
      if (!ok) {
        return { available: false, allowed: true, count: baselineUsedCount };
      }

      // Initialize counter from DB baseline only if key does not exist yet
      await this.client.raw.set(key, String(Math.max(0, baselineUsedCount)), 'NX');
      const next = await this.client.raw.incr(key);

      if (next > usageLimit) {
        await this.client.raw.decr(key);
        return { available: true, allowed: false, count: usageLimit };
      }
      return { available: true, allowed: true, count: next };
    } catch (error: unknown) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis flash counter failure — falling back to DB guard',
      );
      return { available: false, allowed: true, count: baselineUsedCount };
    }
  }

  async releaseFlashCounter(code: string): Promise<void> {
    const key = `promo:flash:${code.toUpperCase()}`;
    try {
      const ok = await this.client.connect();
      if (!ok) {
        return;
      }
      const next = await this.client.raw.decr(key);
      if (next < 0) {
        await this.client.raw.set(key, '0');
      }
    } catch (error: unknown) {
      this.logger.warn(
        { key, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis flash counter release failure',
      );
    }
  }

  /**
   * Clears cached promotion listings and optional flash-sale counter key on promo mutations
   * (create, update, archive, approve-draft) so Storefront sees live changes immediately.
   */
  async clearPromotionCaches(promoCode?: string): Promise<number> {
    let deletedCount = 0;
    try {
      const ok = await this.client.connect();
      if (!ok) {
        return 0;
      }

      const patterns = [
        'promo:active*',
        'promotions:*',
        'atelier:promotions:*',
        'bff:storefront:promotions*',
        'storefront:promotions*',
      ];

      const keysToDelete = new Set<string>();
      if (promoCode && promoCode.trim().length > 0) {
        keysToDelete.add(`promo:flash:${promoCode.trim().toUpperCase()}`);
      }

      for (const pattern of patterns) {
        let cursor = '0';
        let iterations = 0;
        do {
          const [nextCursor, batch] = await this.client.raw.scan(
            cursor,
            'MATCH',
            pattern,
            'COUNT',
            100,
          );
          cursor = nextCursor;
          for (const key of batch) {
            keysToDelete.add(key);
          }
          iterations += 1;
        } while (cursor !== '0' && iterations < 20);
      }

      if (keysToDelete.size > 0) {
        deletedCount = await this.client.raw.del(...Array.from(keysToDelete));
      }
    } catch (error: unknown) {
      this.logger.warn(
        { promoCode, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal Redis promotion cache invalidation failure',
      );
    }
    return deletedCount;
  }
}
