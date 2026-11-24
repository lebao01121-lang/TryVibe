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
import { ORDER_CONFIG_TOKEN, type OrderRmaConfig } from '../config/env';
import { seedOrderDatabase } from './seed';

@Injectable()
export class OrderDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('@atelier/order-rma:db');
  private client: AtelierDbClient | null = null;
  private ready = false;

  constructor(@Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig) {}

  async onModuleInit(): Promise<void> {
    this.client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName: this.config.database.targetDatabase || 'order_db',
    });

    const schemaSql = this.loadSchemaSql();
    await this.client.exec(schemaSql);

    const seedSummary = await seedOrderDatabase(this.client);
    this.ready = true;

    this.logger.info(
      {
        mode: this.client.mode,
        dbName: this.client.dbName,
        ...(this.client.dataDir ? { dataDir: this.client.dataDir } : {}),
        ...seedSummary,
      },
      'Isolated order_db migrated and seeded cleanly',
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
      throw new Error('OrderDbService is not initialized yet.');
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

  private loadSchemaSql(): string {
    const candidates = [
      path.resolve(__dirname, './schema.sql'),
      path.resolve(__dirname, '../../src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
      path.resolve(process.cwd(), 'services/order-rma/src/db/schema.sql'),
    ];
    const found = candidates.find((candidate) => fs.existsSync(candidate));
    if (!found) {
      throw new Error(`Unable to locate order-rma schema.sql in: ${candidates.join(', ')}`);
    }
    return fs.readFileSync(found, 'utf8');
  }
}
