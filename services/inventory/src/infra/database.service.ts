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
import { INVENTORY_CONFIG_TOKEN, type InventoryConfig } from '../config/env';
import { seedInventoryDatabase } from '../db/seed';
import { InventoryRedisService } from './redis.service';

@Injectable()
export class InventoryDatabaseService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('@atelier/inventory:db');
  private client: AtelierDbClient | null = null;
  private ready = false;

  constructor(
    @Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig,
    private readonly redis: InventoryRedisService,
  ) {}

  async onModuleInit(): Promise<void> {
    this.client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName: this.config.database.targetDatabase || 'inventory_db',
    });

    const schemaSql = this.loadSchemaSql();
    await this.client.exec(schemaSql);

    const seedSummary = await seedInventoryDatabase(this.client);
    await this.warmAllRedisStockCounters();

    this.ready = true;
    this.logger.info(
      {
        mode: this.client.mode,
        dbName: this.client.dbName,
        ...(this.client.dataDir ? { dataDir: this.client.dataDir } : {}),
        ...seedSummary,
      },
      'Isolated inventory_db migrated, seeded (100 SKUs), and Redis counters warmed',
    );
  }

  async onModuleDestroy(): Promise<void> {
    this.ready = false;
    if (this.client) {
      await this.client.close();
      this.client = null;
    }
  }

  get mode(): AtelierDbMode | 'uninitialized' {
    return this.client?.mode ?? 'uninitialized';
  }

  isReady(): boolean {
    return this.ready && this.client !== null;
  }

  private getClient(): AtelierDbClient {
    if (!this.client) {
      throw new Error('InventoryDatabaseService is not initialized yet.');
    }
    return this.client;
  }

  async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<AtelierQueryResult<T>> {
    return this.getClient().query<T>(sql, params);
  }

  async exec(sql: string): Promise<void> {
    return this.getClient().exec(sql);
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    return this.getClient().transaction(fn);
  }

  async ping(): Promise<boolean> {
    if (!this.client) {
      return false;
    }
    try {
      await this.client.query('SELECT 1');
      return true;
    } catch {
      return false;
    }
  }

  async warmAllRedisStockCounters(): Promise<void> {
    if (!this.client) {
      return;
    }
    const totals = await this.client.query<{ sku_id: string; total_avail: number | string }>(
      `SELECT sku_id, COALESCE(SUM(available_qty), 0)::int AS total_avail
       FROM stock_levels
       GROUP BY sku_id`,
    );
    for (const row of totals.rows) {
      await this.redis.setStockAvailable(row.sku_id, Number(row.total_avail));
    }
  }

  private loadSchemaSql(): string {
    const candidates = [
      path.resolve(__dirname, '../db/schema.sql'),
      path.resolve(__dirname, '../../src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
      path.resolve(process.cwd(), 'services/inventory/src/db/schema.sql'),
    ];

    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new Error(`Unable to locate inventory schema.sql in: ${candidates.join(', ')}`);
    }
    return fs.readFileSync(found, 'utf8');
  }
}
