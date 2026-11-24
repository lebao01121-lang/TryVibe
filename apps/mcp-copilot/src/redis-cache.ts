import { Socket } from 'node:net';
import { ContentHashCache } from '@atelier/ai-harness';
import { parseSafeConnectionTarget } from './config.js';

export const COPILOT_CACHE_KEY_PREFIX = 'copilot:cache:';
export const DEFAULT_COPILOT_CACHE_TTL_SECONDS = 300;

interface ParsedRespValue {
  value: string | null;
  nextOffset: number;
}

function encodeRespCommand(args: readonly string[]): Buffer {
  const parts: Buffer[] = [Buffer.from(`*${args.length}\r\n`, 'utf8')];
  for (const arg of args) {
    const buf = Buffer.from(arg, 'utf8');
    parts.push(
      Buffer.from(`$${buf.length}\r\n`, 'utf8'),
      buf,
      Buffer.from('\r\n', 'utf8'),
    );
  }
  return Buffer.concat(parts);
}

function tryParseOneRespValue(
  buf: Buffer,
  offset: number,
): ParsedRespValue | null {
  if (offset >= buf.length) {
    return null;
  }

  const prefix = buf[offset];
  const lineEnd = buf.indexOf('\r\n', offset);
  if (lineEnd === -1) {
    return null;
  }

  if (prefix === 0x2b || prefix === 0x2d || prefix === 0x3a) {
    // '+' simple string, '-' error, ':' integer
    const text = buf.subarray(offset + 1, lineEnd).toString('utf8');
    return {
      value: prefix === 0x2d ? null : text,
      nextOffset: lineEnd + 2,
    };
  }

  if (prefix === 0x24) {
    // '$' bulk string
    const byteLen = Number.parseInt(
      buf.subarray(offset + 1, lineEnd).toString('utf8'),
      10,
    );
    if (Number.isNaN(byteLen)) {
      return null;
    }
    if (byteLen < 0) {
      return { value: null, nextOffset: lineEnd + 2 };
    }
    const dataStart = lineEnd + 2;
    const dataEnd = dataStart + byteLen;
    if (dataEnd + 2 > buf.length) {
      return null;
    }
    return {
      value: buf.subarray(dataStart, dataEnd).toString('utf8'),
      nextOffset: dataEnd + 2,
    };
  }

  return null;
}

export class RedisSemanticCache {
  private readonly host: string | null;
  private readonly port: number;
  private readonly password?: string;
  private readonly ttlSeconds: number;
  private readonly memoryFallback: ContentHashCache<string>;

  constructor(redisUrl: string, ttlSeconds = DEFAULT_COPILOT_CACHE_TTL_SECONDS) {
    const target = parseSafeConnectionTarget(redisUrl);
    this.host = target?.host ?? null;
    this.port = target?.port ?? 6379;
    this.password = target?.password;
    this.ttlSeconds = Math.max(10, ttlSeconds);
    this.memoryFallback = new ContentHashCache<string>({
      defaultTtlMs: this.ttlSeconds * 1000,
      maxEntries: 256,
    });
  }

  public formatKey(rawHash: string): string {
    return rawHash.startsWith(COPILOT_CACHE_KEY_PREFIX)
      ? rawHash
      : `${COPILOT_CACHE_KEY_PREFIX}${rawHash}`;
  }

  private execRedisCommand(
    args: readonly string[],
    timeoutMs = 350,
  ): Promise<{ ok: boolean; value: string | null }> {
    if (!this.host) {
      return Promise.resolve({ ok: false, value: null });
    }

    const host = this.host;
    const port = this.port;
    const commands: Array<readonly string[]> = [];
    if (this.password) {
      commands.push(['AUTH', this.password]);
    }
    commands.push(args);

    const payload = Buffer.concat(commands.map((cmd) => encodeRespCommand(cmd)));
    const expectedReplies = commands.length;

    return new Promise((resolvePromise) => {
      const socket = new Socket();
      let settled = false;
      let buffer: Buffer = Buffer.alloc(0);

      const finish = (ok: boolean, value: string | null): void => {
        if (settled) {
          return;
        }
        settled = true;
        socket.removeAllListeners();
        socket.destroy();
        resolvePromise({ ok, value });
      };

      socket.setTimeout(timeoutMs);
      socket.once('timeout', () => finish(false, null));
      socket.once('error', () => finish(false, null));

      socket.once('connect', () => {
        socket.write(payload);
      });

      socket.on('data', (chunk: Buffer | string) => {
        const piece = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        buffer = Buffer.concat([buffer, piece]);

        let cursor = 0;
        let lastValue: string | null = null;
        let parsedCount = 0;

        while (parsedCount < expectedReplies) {
          const parsed = tryParseOneRespValue(buffer, cursor);
          if (!parsed) {
            return;
          }
          lastValue = parsed.value;
          cursor = parsed.nextOffset;
          parsedCount += 1;
        }

        finish(true, lastValue);
      });

      socket.connect(port, host);
    });
  }

  public async ping(): Promise<{ reachable: boolean; latencyMs: number }> {
    const startedAt = Date.now();
    const res = await this.execRedisCommand(['PING'], 300);
    return {
      reachable: res.ok && res.value === 'PONG',
      latencyMs: Date.now() - startedAt,
    };
  }

  public async getJson<T>(rawKey: string): Promise<{ value: T | null; backend: 'redis' | 'memory' | 'miss' }> {
    const key = this.formatKey(rawKey);
    const redisRes = await this.execRedisCommand(['GET', key]);
    if (redisRes.ok && redisRes.value) {
      try {
        return { value: JSON.parse(redisRes.value) as T, backend: 'redis' };
      } catch {
        return { value: null, backend: 'miss' };
      }
    }

    const mem = this.memoryFallback.get(key);
    if (mem) {
      try {
        return { value: JSON.parse(mem) as T, backend: 'memory' };
      } catch {
        return { value: null, backend: 'miss' };
      }
    }

    return { value: null, backend: 'miss' };
  }

  public async setJson<T>(
    rawKey: string,
    value: T,
    ttlSeconds = this.ttlSeconds,
  ): Promise<void> {
    const key = this.formatKey(rawKey);
    const serialized = JSON.stringify(value);
    const effectiveTtl = Math.max(10, Math.floor(ttlSeconds));
    this.memoryFallback.set(key, serialized, effectiveTtl * 1000);
    await this.execRedisCommand(['SET', key, serialized, 'EX', String(effectiveTtl)]);
  }
}
