import Redis, { type RedisOptions } from 'ioredis';

export interface CreateRedisClientOptions {
  url?: string;
  password?: string;
  connectTimeoutMs?: number;
  maxRetriesPerRequest?: number;
}

export interface AtelierRedisClient {
  readonly raw: Redis;
  readonly url: string;
  connect(): Promise<boolean>;
  isConnected(): boolean;
  ping(): Promise<boolean>;
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  del(...keys: string[]): Promise<number>;
  delByPattern(pattern: string): Promise<number>;
  incr(key: string, ttlSeconds?: number): Promise<number>;
  ttl(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<unknown>;
  quit(): Promise<void>;
}

function buildRedisConfig(input?: string | CreateRedisClientOptions): {
  url: string;
  options: RedisOptions;
} {
  const opts: CreateRedisClientOptions =
    typeof input === 'string' ? { url: input } : (input ?? {});
  const url = opts.url ?? process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';

  let host = '127.0.0.1';
  let port = 6379;
  let password = opts.password;
  let db = 0;

  try {
    const parsed = new URL(url);
    host = parsed.hostname || '127.0.0.1';
    port = parsed.port ? Number(parsed.port) : 6379;
    if (!password && parsed.password) {
      password = decodeURIComponent(parsed.password);
    }
    const pathDb = parsed.pathname.replace(/^\//, '');
    if (pathDb && /^\d+$/.test(pathDb)) {
      db = Number(pathDb);
    }
  } catch {
    // Keep defaults if URL is malformed
  }

  if (!password && process.env.REDIS_PASSWORD) {
    password = process.env.REDIS_PASSWORD;
  }

  const options: RedisOptions = {
    host,
    port,
    db,
    ...(password ? { password } : {}),
    lazyConnect: true,
    connectTimeout: opts.connectTimeoutMs ?? 2000,
    maxRetriesPerRequest: opts.maxRetriesPerRequest ?? 2,
    enableReadyCheck: false,
    retryStrategy(times: number): number | null {
      if (times > 5) {
        return null;
      }
      return Math.min(times * 250, 1500);
    },
  };

  return { url, options };
}

export function createRedisClient(
  input?: string | CreateRedisClientOptions,
): AtelierRedisClient {
  const { url, options } = buildRedisConfig(input);
  const client = new Redis(options);

  // Prevent unhandled ioredis EventEmitter errors from crashing services when Redis is offline
  client.on('error', () => {
    // Handled gracefully by callers checking ping() / isConnected()
  });

  async function ensureConnected(): Promise<boolean> {
    if (client.status === 'ready' || client.status === 'connect') {
      return true;
    }
    if (client.status === 'connecting' || client.status === 'reconnecting') {
      return new Promise((resolve) => {
        const onReady = (): void => {
          cleanup();
          resolve(true);
        };
        const onFail = (): void => {
          cleanup();
          resolve(false);
        };
        const cleanup = (): void => {
          client.off('ready', onReady);
          client.off('connect', onReady);
          client.off('error', onFail);
          client.off('close', onFail);
        };
        client.once('ready', onReady);
        client.once('connect', onReady);
        client.once('error', onFail);
        client.once('close', onFail);
      });
    }
    try {
      await client.connect();
      return true;
    } catch {
      return false;
    }
  }

  return {
    raw: client,
    url,
    async connect(): Promise<boolean> {
      return ensureConnected();
    },
    isConnected(): boolean {
      return client.status === 'ready' || client.status === 'connect';
    },
    async ping(): Promise<boolean> {
      try {
        const ok = await ensureConnected();
        if (!ok) {
          return false;
        }
        const reply = await client.ping();
        return reply === 'PONG';
      } catch {
        return false;
      }
    },
    async get(key: string): Promise<string | null> {
      await ensureConnected();
      return client.get(key);
    },
    async set(key: string, value: string, ttlSeconds?: number): Promise<void> {
      await ensureConnected();
      if (typeof ttlSeconds === 'number' && ttlSeconds > 0) {
        await client.set(key, value, 'EX', Math.ceil(ttlSeconds));
      } else {
        await client.set(key, value);
      }
    },
    async del(...keys: string[]): Promise<number> {
      if (keys.length === 0) {
        return 0;
      }
      await ensureConnected();
      return client.del(...keys);
    },
    async delByPattern(pattern: string): Promise<number> {
      await ensureConnected();
      let cursor = '0';
      let deletedTotal = 0;

      do {
        const [nextCursor, keys] = await client.scan(cursor, 'MATCH', pattern, 'COUNT', 100);
        cursor = nextCursor;
        if (keys.length > 0) {
          deletedTotal += await client.del(...keys);
        }
      } while (cursor !== '0');

      return deletedTotal;
    },
    async incr(key: string, ttlSeconds?: number): Promise<number> {
      await ensureConnected();
      const next = await client.incr(key);
      if (next === 1 && typeof ttlSeconds === 'number' && ttlSeconds > 0) {
        await client.expire(key, Math.ceil(ttlSeconds));
      }
      return next;
    },
    async ttl(key: string): Promise<number> {
      await ensureConnected();
      return client.ttl(key);
    },
    async eval(
      script: string,
      numKeys: number,
      ...args: (string | number)[]
    ): Promise<unknown> {
      await ensureConnected();
      return client.eval(script, numKeys, ...args);
    },
    async quit(): Promise<void> {
      try {
        if (client.status === 'ready' || client.status === 'connect') {
          await client.quit();
        } else {
          client.disconnect();
        }
      } catch {
        client.disconnect();
      }
    },
  };
}
