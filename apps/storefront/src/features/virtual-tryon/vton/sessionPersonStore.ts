import {
  TRYON_SESSION_TTL_MS,
  type LightingPresetId,
  type SessionPersonFrame,
  type TryOnSynthesisGarmentInput,
  type TryOnSynthesisResult,
} from './types';

const MAX_SYNTHESIS_CACHE_ENTRIES = 36;

function fnv1aDeterministic64Hex(bytes: Uint8Array): string {
  // Four independent 32-bit FNV-1a lanes mixed with avalanche constants -> 64 hex chars
  let h0 = 0x811c9dc5;
  let h1 = 0x9e3779b9;
  let h2 = 0x85ebca6b;
  let h3 = 0xc2b2ae35;

  const step = bytes.length > 65_536 ? Math.floor(bytes.length / 65_536) : 1;
  for (let i = 0; i < bytes.length; i += step) {
    const b = bytes[i] ?? 0;
    h0 = Math.imul(h0 ^ b, 0x01000193);
    h1 = Math.imul(h1 ^ ((b + i) & 0xff), 0x85ebca6b);
    h2 = Math.imul(h2 ^ ((b ^ (i >>> 3)) & 0xff), 0xc2b2ae35);
    h3 = Math.imul(h3 ^ ((b + (i * 7)) & 0xff), 0x27d4eb2f);
  }

  // Mix length to avoid collisions on truncated/padded payloads
  const len = bytes.length >>> 0;
  h0 = Math.imul(h0 ^ len, 0x01000193);
  h1 = Math.imul(h1 ^ (len >>> 8), 0x85ebca6b);
  h2 = Math.imul(h2 ^ (len >>> 16), 0xc2b2ae35);
  h3 = Math.imul(h3 ^ (len ^ 0xa5a5a5a5), 0x27d4eb2f);

  const toHex8 = (v: number) => (v >>> 0).toString(16).padStart(8, '0');
  const firstHalf = `${toHex8(h0)}${toHex8(h1)}${toHex8(h2)}${toHex8(h3)}`;
  const h4 = Math.imul(h0 ^ h2, 0x9e3779b1);
  const h5 = Math.imul(h1 ^ h3, 0x85ebca77);
  const h6 = Math.imul(h4 ^ h1, 0xc2b2ae3d);
  const h7 = Math.imul(h5 ^ h0, 0x27d4eb2d);
  return `${firstHalf}${toHex8(h4)}${toHex8(h5)}${toHex8(h6)}${toHex8(h7)}`;
}

function toUint8Array(input: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof input === 'string') {
    if (typeof TextEncoder !== 'undefined') {
      return new TextEncoder().encode(input);
    }
    const out = new Uint8Array(input.length);
    for (let i = 0; i < input.length; i += 1) {
      out[i] = input.charCodeAt(i) & 0xff;
    }
    return out;
  }
  if (input instanceof Uint8Array) {
    return input;
  }
  return new Uint8Array(input);
}

/**
 * Browser-safe SHA-256 hex digest with deterministic FNV-1a fallback when
 * `crypto.subtle` is unavailable (e.g. non-secure LAN HTTP origin).
 */
export async function computeSha256Hex(
  input: string | Uint8Array | ArrayBuffer,
): Promise<string> {
  const bytes = toUint8Array(input);
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    try {
      const buffer = bytes.buffer.slice(
        bytes.byteOffset,
        bytes.byteOffset + bytes.byteLength,
      ) as ArrayBuffer;
      const digest = await crypto.subtle.digest('SHA-256', buffer);
      const out = new Uint8Array(digest);
      let hex = '';
      for (let i = 0; i < out.length; i += 1) {
        hex += out[i]!.toString(16).padStart(2, '0');
      }
      return hex;
    } catch {
      // Fall through to deterministic FNV-1a fallback
    }
  }
  return fnv1aDeterministic64Hex(bytes);
}

/**
 * Computes a deterministic cache key across the locked person frame hash,
 * canonically sorted garments (productId + variantId + slot + colorHex), and lighting preset.
 */
export async function computeTryOnCacheKey(
  personFrameHash: string,
  garments: readonly TryOnSynthesisGarmentInput[],
  lightingPreset: LightingPresetId,
): Promise<string> {
  const garmentSignature = [...garments]
    .map((g) =>
      [
        g.slot,
        g.productId.trim(),
        g.variantId.trim(),
        g.colorHex.trim().toLowerCase(),
        g.garmentImageUrl.trim(),
      ].join(':'),
    )
    .sort()
    .join('|');

  const canonical = `vton-v2|${personFrameHash.trim()}|${garmentSignature}|${lightingPreset}`;
  return computeSha256Hex(canonical);
}

export class SessionPersonFrameStore {
  private currentFrame: SessionPersonFrame | null = null;
  private purgeTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly synthesisCache = new Map<string, TryOnSynthesisResult>();
  private readonly maxCacheEntries: number;

  constructor(maxCacheEntries = MAX_SYNTHESIS_CACHE_ENTRIES) {
    this.maxCacheEntries = Math.max(4, maxCacheEntries);
  }

  private clearPurgeTimer(): void {
    if (this.purgeTimer !== null) {
      clearTimeout(this.purgeTimer);
      this.purgeTimer = null;
    }
  }

  private notify(): void {
    this.listeners.forEach((listener) => {
      try {
        listener();
      } catch {
        // Never allow a single UI subscriber error to break store notifications
      }
    });
  }

  private scheduleAutoPurge(expiresAt: number): void {
    this.clearPurgeTimer();
    const delayMs = Math.max(0, expiresAt - Date.now());
    this.purgeTimer = setTimeout(() => {
      this.purgeTimer = null;
      if (this.currentFrame && Date.now() >= this.currentFrame.expiresAt) {
        this.currentFrame = null;
        this.synthesisCache.clear();
        this.notify();
      }
    }, delayMs + 50);
  }

  public getFrame(): SessionPersonFrame | null {
    if (!this.currentFrame) return null;
    if (Date.now() >= this.currentFrame.expiresAt) {
      this.currentFrame = null;
      this.synthesisCache.clear();
      this.clearPurgeTimer();
      this.notify();
      return null;
    }
    return this.currentFrame;
  }

  public setFrame(frame: SessionPersonFrame): SessionPersonFrame {
    const now = Date.now();
    const capturedAt = Number.isFinite(frame.capturedAt) ? frame.capturedAt : now;
    const expiresAt =
      Number.isFinite(frame.expiresAt) && frame.expiresAt > now
        ? frame.expiresAt
        : capturedAt + TRYON_SESSION_TTL_MS;

    const normalized: SessionPersonFrame = {
      ...frame,
      width: 768,
      height: 1024,
      capturedAt,
      expiresAt,
    };

    this.currentFrame = normalized;
    this.scheduleAutoPurge(normalized.expiresAt);
    this.notify();
    return normalized;
  }

  public clearFrame(clearCache = true): void {
    this.clearPurgeTimer();
    this.currentFrame = null;
    if (clearCache) {
      this.synthesisCache.clear();
    }
    this.notify();
  }

  public getRemainingSeconds(): number {
    const frame = this.getFrame();
    if (!frame) return 0;
    return Math.max(0, Math.ceil((frame.expiresAt - Date.now()) / 1000));
  }

  public subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  public getCachedResult(cacheKey: string): TryOnSynthesisResult | null {
    const hit = this.synthesisCache.get(cacheKey);
    if (!hit) return null;
    // LRU promotion: delete and re-insert at tail
    this.synthesisCache.delete(cacheKey);
    this.synthesisCache.set(cacheKey, hit);
    return hit;
  }

  public setCachedResult(
    cacheKey: string,
    result: TryOnSynthesisResult,
  ): void {
    if (this.synthesisCache.has(cacheKey)) {
      this.synthesisCache.delete(cacheKey);
    } else if (this.synthesisCache.size >= this.maxCacheEntries) {
      const oldestKey = this.synthesisCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.synthesisCache.delete(oldestKey);
      }
    }
    this.synthesisCache.set(cacheKey, result);
  }

  public clearSynthesisCache(): void {
    this.synthesisCache.clear();
  }

  public getCacheSize(): number {
    return this.synthesisCache.size;
  }
}

export const sessionPersonStore = new SessionPersonFrameStore();
