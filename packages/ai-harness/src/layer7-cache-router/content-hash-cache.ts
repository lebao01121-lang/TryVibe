import { createHash } from 'node:crypto';

export interface ContentHashCacheOptions {
  defaultTtlMs?: number;
  maxEntries?: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
  createdAt: number;
}

export interface ContentHashCacheStats {
  size: number;
  hits: number;
  misses: number;
  evictions: number;
}

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalize(item)).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const sortedKeys = Object.keys(obj).sort();
  const pairs = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalize(obj[key])}`,
  );
  return `{${pairs.join(',')}}`;
}

export class ContentHashCache<T = unknown> {
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly entries = new Map<string, CacheEntry<T>>();
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(options: ContentHashCacheOptions = {}) {
    this.defaultTtlMs = Math.max(100, options.defaultTtlMs ?? 60_000);
    this.maxEntries = Math.max(1, options.maxEntries ?? 500);
  }

  public static hashInput(input: unknown): string {
    const serialized =
      typeof input === 'string' ? input : canonicalize(input);
    return createHash('sha256').update(serialized).digest('hex');
  }

  public computeHash(input: unknown): string {
    return ContentHashCache.hashInput(input);
  }

  public get(rawKey: unknown, now = Date.now()): T | undefined {
    const key = this.computeHash(rawKey);
    const entry = this.entries.get(key);
    if (!entry) {
      this.misses += 1;
      return undefined;
    }

    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      this.misses += 1;
      return undefined;
    }

    // Touch for LRU recency
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits += 1;
    return entry.value;
  }

  public set(
    rawKey: unknown,
    value: T,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
  ): string {
    const key = this.computeHash(rawKey);
    if (this.entries.has(key)) {
      this.entries.delete(key);
    } else if (this.entries.size >= this.maxEntries) {
      const oldestKey = this.entries.keys().next().value;
      if (oldestKey !== undefined) {
        this.entries.delete(oldestKey);
        this.evictions += 1;
      }
    }

    this.entries.set(key, {
      value,
      createdAt: now,
      expiresAt: now + Math.max(1, ttlMs),
    });

    return key;
  }

  public has(rawKey: unknown, now = Date.now()): boolean {
    const key = this.computeHash(rawKey);
    const entry = this.entries.get(key);
    if (!entry) {
      return false;
    }
    if (now >= entry.expiresAt) {
      this.entries.delete(key);
      return false;
    }
    return true;
  }

  public delete(rawKey: unknown): boolean {
    return this.entries.delete(this.computeHash(rawKey));
  }

  public clear(): void {
    this.entries.clear();
  }

  public getStats(): ContentHashCacheStats {
    return {
      size: this.entries.size,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
    };
  }
}
