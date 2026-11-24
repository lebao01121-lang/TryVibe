import * as fs from 'node:fs';
import * as path from 'node:path';
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  createIsolatedPgClient,
  type AtelierDbClient,
  type AtelierDbExecutor,
  type AtelierDbMode,
  type AtelierQueryResult,
} from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  CART_CONFIG_TOKEN,
  EXPECTED_DATABASE_NAME,
  SERVICE_NAME,
  type CartOutfitConfig,
} from '../config/env';

@Injectable()
export class CartDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private client: AtelierDbClient | null = null;

  constructor(@Inject(CART_CONFIG_TOKEN) private readonly config: CartOutfitConfig) {}

  async onModuleInit(): Promise<void> {
    const dbName = this.config.database.targetDatabase || EXPECTED_DATABASE_NAME;
    this.client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName,
    });

    const schemaSql = this.loadSchemaSql();
    await this.client.exec(schemaSql);

    this.logger.info(
      {
        dbName: this.client.dbName,
        mode: this.client.mode,
        dataDir: this.client.dataDir,
      },
      'Isolated cart_db connected and idempotent schema migration completed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  private ensureClient(): AtelierDbClient {
    if (!this.client) {
      throw new Error('CartDbService has not been initialized yet.');
    }
    return this.client;
  }

  private loadSchemaSql(): string {
    const candidates = [
      path.resolve(__dirname, 'schema.sql'),
      path.resolve(__dirname, '../../src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
      path.resolve(process.cwd(), 'services/cart-outfit/src/db/schema.sql'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }

    throw new Error(
      `Unable to locate cart_db schema.sql in any candidate path: ${candidates.join(', ')}`,
    );
  }

  getMode(): AtelierDbMode | 'uninitialized' {
    return this.client ? this.client.mode : 'uninitialized';
  }

  async ping(): Promise<{ ok: boolean; latencyMs: number; mode: string; detail: string }> {
    const start = Date.now();
    try {
      const db = this.ensureClient();
      await db.query('SELECT 1 AS ok');
      return {
        ok: true,
        latencyMs: Date.now() - start,
        mode: db.mode,
        detail: `${db.dbName} (${db.mode}) reachable`,
      };
    } catch (error: unknown) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        mode: this.getMode(),
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<AtelierQueryResult<T>> {
    return this.ensureClient().query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    return this.ensureClient().exec(sql);
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    return this.ensureClient().transaction(fn);
  }
}
