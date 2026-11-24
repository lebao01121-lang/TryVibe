import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { Pool, type PoolClient } from 'pg';
import { findRepoRoot } from './env';

export type AtelierDbMode = 'postgres' | 'pglite';

export interface AtelierQueryResult<T = Record<string, unknown>> {
  rows: T[];
  rowCount: number;
}

export interface AtelierDbExecutor {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<AtelierQueryResult<T>>;
  exec(sql: string): Promise<void>;
}

export interface AtelierDbClient extends AtelierDbExecutor {
  readonly mode: AtelierDbMode;
  readonly dbName: string;
  readonly dataDir?: string;
  transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface CreateIsolatedPgClientOptions {
  databaseUrl: string;
  dbName: string;
  enableVector?: boolean;
  dataDirRoot?: string;
  connectTimeoutMs?: number;
  forcePglite?: boolean;
}

interface PgliteQueryResult<T = Record<string, unknown>> {
  rows: T[];
  affectedRows?: number;
}

interface PgliteTransactionLike {
  query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<PgliteQueryResult<T>>;
  exec(sql: string): Promise<unknown>;
}

interface PgliteInstanceLike extends PgliteTransactionLike {
  waitReady: Promise<void>;
  transaction<T>(callback: (tx: PgliteTransactionLike) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

interface PgliteModuleLike {
  PGlite: {
    new (dataDir?: string, options?: { extensions?: Record<string, unknown> }): PgliteInstanceLike;
    create?: (
      dataDir?: string,
      options?: { extensions?: Record<string, unknown> },
    ) => Promise<PgliteInstanceLike>;
  };
}

interface PgliteVectorModuleLike {
  vector: unknown;
}

// Preserve native ESM import() even when compiled to CommonJS by tsc
const dynamicImport = new Function('specifier', 'return import(specifier);') as <T>(
  specifier: string,
) => Promise<T>;

function parsePgHostPort(databaseUrl: string): { host: string; port: number } {
  try {
    const parsed = new URL(databaseUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number(parsed.port) : 5432,
    };
  } catch {
    return { host: '127.0.0.1', port: 5432 };
  }
}

export function isTcpReachable(
  host: string,
  port: number,
  timeoutMs: number = 1500,
): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const finish = (reachable: boolean): void => {
      if (settled) {
        return;
      }
      settled = true;
      socket.removeAllListeners();
      socket.destroy();
      resolve(reachable);
    };

    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
    socket.connect(port, host);
  });
}

function sanitizeDbDirName(dbName: string): string {
  const cleaned = dbName.trim().replace(/[^a-zA-Z0-9_-]/g, '_');
  if (!cleaned) {
    throw new Error(`Invalid dbName "${dbName}" for isolated storage directory`);
  }
  return cleaned;
}

function normalizePgliteResult<T>(res: PgliteQueryResult<T>): AtelierQueryResult<T> {
  const rows = Array.isArray(res.rows) ? res.rows : [];
  const rowCount =
    typeof res.affectedRows === 'number' && res.affectedRows > 0
      ? res.affectedRows
      : rows.length;
  return { rows, rowCount };
}

function wrapPgPool(pool: Pool, dbName: string): AtelierDbClient {
  return {
    mode: 'postgres',
    dbName,
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<AtelierQueryResult<T>> {
      const res = await pool.query(sql, params);
      const rows = res.rows as T[];
      return {
        rows,
        rowCount: res.rowCount ?? rows.length,
      };
    },
    async exec(sql: string): Promise<void> {
      await pool.query(sql);
    },
    async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
      const client: PoolClient = await pool.connect();
      try {
        await client.query('BEGIN');
        const tx: AtelierDbExecutor = {
          async query<R = Record<string, unknown>>(
            sql: string,
            params?: unknown[],
          ): Promise<AtelierQueryResult<R>> {
            const res = await client.query(sql, params);
            const rows = res.rows as R[];
            return {
              rows,
              rowCount: res.rowCount ?? rows.length,
            };
          },
          async exec(sql: string): Promise<void> {
            await client.query(sql);
          },
        };
        const result = await fn(tx);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function createAsyncMutex(): <T>(task: () => Promise<T>) => Promise<T> {
  let queue: Promise<void> = Promise.resolve();

  return async function runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const previous = queue;
    let release!: () => void;
    queue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

function wrapPglite(db: PgliteInstanceLike, dbName: string, dataDir: string): AtelierDbClient {
  const runExclusive = createAsyncMutex();

  return {
    mode: 'pglite',
    dbName,
    dataDir,
    async query<T = Record<string, unknown>>(
      sql: string,
      params?: unknown[],
    ): Promise<AtelierQueryResult<T>> {
      return runExclusive(async () => {
        const res = await db.query<T>(sql, params);
        return normalizePgliteResult(res);
      });
    },
    async exec(sql: string): Promise<void> {
      return runExclusive(async () => {
        await db.exec(sql);
      });
    },
    async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
      return runExclusive(async () =>
        db.transaction(async (rawTx) => {
          const tx: AtelierDbExecutor = {
            async query<R = Record<string, unknown>>(
              sql: string,
              params?: unknown[],
            ): Promise<AtelierQueryResult<R>> {
              const res = await rawTx.query<R>(sql, params);
              return normalizePgliteResult(res);
            },
            async exec(sql: string): Promise<void> {
              await rawTx.exec(sql);
            },
          };
          return fn(tx);
        }),
      );
    },
    async close(): Promise<void> {
      return runExclusive(async () => {
        await db.close();
      });
    },
  };
}

/**
 * Creates a database-per-service PostgreSQL client:
 * - Connects to real PostgreSQL via `pg.Pool` when TCP host:port is reachable (`mode: 'postgres'`).
 * - Falls back automatically to an isolated per-DB `@electric-sql/pglite` PostgreSQL 16 WASM
 *   directory under `.local-pgdata/<dbName>` when PostgreSQL is offline (`mode: 'pglite'`).
 */
export async function createIsolatedPgClient(
  opts: CreateIsolatedPgClientOptions,
): Promise<AtelierDbClient> {
  const timeoutMs = opts.connectTimeoutMs ?? 1500;
  const { host, port } = parsePgHostPort(opts.databaseUrl);

  const reachable = opts.forcePglite ? false : await isTcpReachable(host, port, timeoutMs);

  if (reachable) {
    const pool = new Pool({
      connectionString: opts.databaseUrl,
      connectionTimeoutMillis: Math.max(timeoutMs, 3000),
      max: 10,
    });
    pool.on('error', () => {
      // Prevent unhandled idle pool errors from crashing worker processes
    });
    return wrapPgPool(pool, opts.dbName);
  }

  const baseRoot = opts.dataDirRoot ?? path.join(findRepoRoot(), '.local-pgdata');
  const safeDbName = sanitizeDbDirName(opts.dbName);
  const dataDir = path.join(baseRoot, safeDbName);
  fs.mkdirSync(dataDir, { recursive: true });

  const { PGlite } = await dynamicImport<PgliteModuleLike>('@electric-sql/pglite');
  const extensions: Record<string, unknown> = {};

  if (opts.enableVector) {
    const { vector } = await dynamicImport<PgliteVectorModuleLike>('@electric-sql/pglite/vector');
    extensions.vector = vector;
  }

  const pgliteOptions = Object.keys(extensions).length > 0 ? { extensions } : undefined;
  let db: PgliteInstanceLike;

  if (typeof PGlite.create === 'function') {
    db = await PGlite.create(dataDir, pgliteOptions);
  } else {
    db = new PGlite(dataDir, pgliteOptions);
    await db.waitReady;
  }

  return wrapPglite(db, opts.dbName, dataDir);
}
