import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger, type Logger } from '@atelier/observability';
import { BFF_CONFIG_TOKEN, BFF_SERVICE_NAME, type BffConfig } from '../config/env';

@Injectable()
export class BffRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger: Logger = createLogger(BFF_SERVICE_NAME);
  private readonly client: AtelierRedisClient;

  constructor(@Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig) {
    this.client = createRedisClient({
      url: this.config.redisUrl,
      connectTimeoutMs: 1500,
      maxRetriesPerRequest: 1,
    });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.client.connect();
    if (ok) {
      this.logger.info({ redisUrl: this.sanitizeUrl(this.config.redisUrl) }, 'BFF Redis connected');
    } else {
      this.logger.warn(
        { redisUrl: this.sanitizeUrl(this.config.redisUrl) },
        'BFF Redis unavailable on boot — cache-aside will degrade gracefully until reachable',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    try {
      return await this.client.ping();
    } catch {
      return false;
    }
  }

  async getSafe(key: string): Promise<string | null> {
    try {
      return await this.client.get(key);
    } catch (error) {
      this.logger.warn({ key, err: error }, 'Redis GET failed; degrading gracefully');
      return null;
    }
  }

  async setSafe(key: string, value: string, ttlSeconds?: number): Promise<boolean> {
    try {
      await this.client.set(key, value, ttlSeconds);
      return true;
    } catch (error) {
      this.logger.warn({ key, err: error }, 'Redis SET failed; degrading gracefully');
      return false;
    }
  }

  async delSafe(...keys: string[]): Promise<number> {
    if (keys.length === 0) {
      return 0;
    }
    try {
      return await this.client.del(...keys);
    } catch (error) {
      this.logger.warn({ keys, err: error }, 'Redis DEL failed');
      return 0;
    }
  }

  async delByPatternSafe(pattern: string): Promise<number> {
    try {
      const deleted = await this.client.delByPattern(pattern);
      this.logger.info({ pattern, deleted }, 'Invalidated Redis cache keys by pattern');
      return deleted;
    } catch (error) {
      this.logger.warn({ pattern, err: error }, 'Redis pattern invalidation failed');
      return 0;
    }
  }

  async incrWithTtlSafe(
    key: string,
    ttlSeconds: number,
  ): Promise<{ count: number; ttlSeconds: number } | null> {
    try {
      const count = await this.client.incr(key, ttlSeconds);
      const ttl = await this.client.ttl(key);
      return {
        count,
        ttlSeconds: ttl > 0 ? ttl : ttlSeconds,
      };
    } catch {
      return null;
    }
  }

  private sanitizeUrl(raw: string): string {
    try {
      const parsed = new URL(raw);
      return `${parsed.protocol}//${parsed.hostname}:${parsed.port || '6379'}`;
    } catch {
      return 'redis://127.0.0.1:6379';
    }
  }
}
