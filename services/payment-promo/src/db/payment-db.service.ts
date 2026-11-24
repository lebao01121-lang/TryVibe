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
  EXPECTED_DATABASE_NAME,
  PAYMENT_CONFIG_TOKEN,
  SERVICE_NAME,
  type PaymentPromoConfig,
} from '../config/env';
import { seedPromotionsIdempotently } from './seed';

@Injectable()
export class PaymentDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private client: AtelierDbClient | null = null;

  constructor(@Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig) {}

  async onModuleInit(): Promise<void> {
    const dbName = this.config.database.targetDatabase || EXPECTED_DATABASE_NAME;
    this.client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName,
    });

    const schemaSql = this.loadSchemaSql();
    await this.client.exec(schemaSql);
    const seededCount = await seedPromotionsIdempotently(this.client);

    this.logger.info(
      {
        dbName: this.client.dbName,
        mode: this.client.mode,
        dataDir: this.client.dataDir,
        seededPromotions: seededCount,
      },
      'Isolated payment_db connected, migrated, and promotions seeded',
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
      throw new Error('PaymentDbService has not been initialized yet.');
    }
    return this.client;
  }

  private loadSchemaSql(): string {
    const candidates = [
      path.resolve(__dirname, 'schema.sql'),
      path.resolve(__dirname, '../../src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
      path.resolve(process.cwd(), 'services/payment-promo/src/db/schema.sql'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }

    throw new Error(
      `Unable to locate payment_db schema.sql in any candidate path: ${candidates.join(', ')}`,
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
