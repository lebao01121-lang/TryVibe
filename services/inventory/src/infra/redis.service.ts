import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { InsufficientStockDetail } from '@atelier/contracts';
import { createRedisClient, type AtelierRedisClient } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import { INVENTORY_CONFIG_TOKEN, type InventoryConfig } from '../config/env';

export const INV_AVAIL_KEY_PREFIX = 'inv:avail:';

/**
 * Atomic multi-SKU Redis stock check & decrement script.
 * Marker `-- ATELIER_LUA_RESERVE` ensures identical semantics across both
 * real Redis 7 (Docker) and `scripts/local-infra-dev.mjs`.
 */
export const LUA_RESERVE_SCRIPT = `-- ATELIER_LUA_RESERVE
local insufficient = {}
for i = 1, #KEYS do
  local raw = redis.call('GET', KEYS[i])
  if not raw then
    return {'MISS', KEYS[i]}
  end
  local avail = tonumber(raw)
  local req = tonumber(ARGV[i])
  if (not avail) or (not req) or req < 0 then
    return redis.error_reply('ERR value is not an integer or out of range')
  end
  if avail < req then
    table.insert(insufficient, KEYS[i])
    table.insert(insufficient, avail)
    table.insert(insufficient, req)
  end
end
if #insufficient > 0 then
  local res = {'INSUFFICIENT'}
  for i = 1, #insufficient do
    table.insert(res, insufficient[i])
  end
  return res
end
for i = 1, #KEYS do
  redis.call('DECRBY', KEYS[i], tonumber(ARGV[i]))
end
return {'OK'}
`;

/**
 * Atomic multi-SKU Redis stock release/rollback script.
 * Marker `-- ATELIER_LUA_RELEASE` matches both real Redis 7 and local harness.
 */
export const LUA_RELEASE_SCRIPT = `-- ATELIER_LUA_RELEASE
for i = 1, #KEYS do
  local delta = tonumber(ARGV[i])
  if delta and delta ~= 0 then
    if redis.call('EXISTS', KEYS[i]) == 1 then
      redis.call('INCRBY', KEYS[i], delta)
    end
  end
end
return 'OK'
`;

export type RedisReserveOutcome =
  | { status: 'OK' }
  | { status: 'MISS'; missingKey: string }
  | { status: 'INSUFFICIENT'; insufficientSkus: InsufficientStockDetail[] }
  | { status: 'UNAVAILABLE' };

@Injectable()
export class InventoryRedisService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('@atelier/inventory:redis');
  private readonly client: AtelierRedisClient;

  constructor(@Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig) {
    this.client = createRedisClient({
      url: this.config.redis.url,
      ...(this.config.redis.password ? { password: this.config.redis.password } : {}),
    });
  }

  async onModuleInit(): Promise<void> {
    const ok = await this.ping();
    if (ok) {
      this.logger.info({ redisUrl: this.config.redis.url }, 'Connected to Redis stock gate');
    } else {
      this.logger.warn(
        { redisUrl: this.config.redis.url },
        'Redis not reachable on inventory startup; falling back gracefully until available',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.client.quit();
  }

  async ping(): Promise<boolean> {
    return this.client.ping();
  }

  stockKey(skuId: string): string {
    return `${INV_AVAIL_KEY_PREFIX}${skuId}`;
  }

  async setStockAvailable(skuId: string, qty: number): Promise<void> {
    try {
      await this.client.set(this.stockKey(skuId), String(Math.max(0, Math.floor(qty))));
    } catch (error) {
      this.logger.warn({ err: error, skuId, qty }, 'Failed to set Redis stock counter');
    }
  }

  async setStockIfAbsent(skuId: string, qty: number): Promise<boolean> {
    try {
      const ok = await this.client.connect();
      if (!ok) {
        return false;
      }
      const res = await this.client.raw.set(
        this.stockKey(skuId),
        String(Math.max(0, Math.floor(qty))),
        'NX',
      );
      return res === 'OK';
    } catch {
      return false;
    }
  }

  async getStockAvailable(skuId: string): Promise<number | null> {
    try {
      const raw = await this.client.get(this.stockKey(skuId));
      if (raw === null) {
        return null;
      }
      const parsed = Number.parseInt(raw, 10);
      return Number.isInteger(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  async atomicReserve(items: ReadonlyArray<{ skuId: string; qty: number }>): Promise<RedisReserveOutcome> {
    if (items.length === 0) {
      return { status: 'OK' };
    }
    try {
      const keys = items.map((item) => this.stockKey(item.skuId));
      const qtys = items.map((item) => item.qty);
      const raw = await this.client.eval(LUA_RESERVE_SCRIPT, keys.length, ...keys, ...qtys);

      if (!Array.isArray(raw) || raw.length === 0) {
        return { status: 'UNAVAILABLE' };
      }

      const tag = String(raw[0]);
      if (tag === 'OK') {
        return { status: 'OK' };
      }
      if (tag === 'MISS') {
        return { status: 'MISS', missingKey: String(raw[1] ?? '') };
      }
      if (tag === 'INSUFFICIENT') {
        const insufficientSkus: InsufficientStockDetail[] = [];
        for (let i = 1; i + 2 < raw.length; i += 3) {
          const rawKey = String(raw[i] ?? '');
          const skuId = rawKey.startsWith(INV_AVAIL_KEY_PREFIX)
            ? rawKey.slice(INV_AVAIL_KEY_PREFIX.length)
            : rawKey;
          const availableQty = Math.max(0, Number(raw[i + 1] ?? 0));
          const requestedQty = Math.max(1, Number(raw[i + 2] ?? 1));
          insufficientSkus.push({ skuId, requestedQty, availableQty });
        }
        return { status: 'INSUFFICIENT', insufficientSkus };
      }

      return { status: 'UNAVAILABLE' };
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis Lua reserve unavailable; deferring to Postgres ACID lock');
      return { status: 'UNAVAILABLE' };
    }
  }

  async atomicRelease(items: ReadonlyArray<{ skuId: string; qty: number }>): Promise<boolean> {
    if (items.length === 0) {
      return true;
    }
    try {
      const keys = items.map((item) => this.stockKey(item.skuId));
      const qtys = items.map((item) => item.qty);
      await this.client.eval(LUA_RELEASE_SCRIPT, keys.length, ...keys, ...qtys);
      return true;
    } catch (error) {
      this.logger.warn({ err: error }, 'Redis Lua release failed');
      return false;
    }
  }
}
