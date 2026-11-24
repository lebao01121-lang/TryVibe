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
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

@Injectable()
export class NotifyDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:db`);
  private client: AtelierDbClient | null = null;
  private initPromise: Promise<AtelierDbClient> | null = null;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN)
    private readonly config: NotifyReviewConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.getClient();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.client) {
      const active = this.client;
      this.client = null;
      this.initPromise = null;
      await active.close();
    }
  }

  public getMode(): AtelierDbMode | 'uninitialized' {
    return this.client ? this.client.mode : 'uninitialized';
  }

  public isReady(): boolean {
    return this.client !== null;
  }

  public async getClient(): Promise<AtelierDbClient> {
    if (this.client) {
      return this.client;
    }
    if (!this.initPromise) {
      this.initPromise = this.initializeDatabase();
    }
    return this.initPromise;
  }

  private resolveSchemaSql(): string {
    const candidates = [
      path.resolve(__dirname, 'schema.sql'),
      path.resolve(__dirname, '../../src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
      path.resolve(process.cwd(), 'services/notify-review/src/db/schema.sql'),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }

    throw new Error(
      `Unable to locate notify_db schema.sql in any candidate path: ${candidates.join(', ')}`,
    );
  }

  private async initializeDatabase(): Promise<AtelierDbClient> {
    const dbName = this.config.database.targetDatabase || EXPECTED_DATABASE_NAME;
    const client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName,
    });

    const schemaSql = this.resolveSchemaSql();
    await client.exec(schemaSql);

    this.client = client;
    this.logger.info(
      {
        dbName: client.dbName,
        mode: client.mode,
        dataDir: client.dataDir,
      },
      'Isolated notify_db connected and idempotent schema migration completed',
    );
    return client;
  }

  public async ping(): Promise<{
    ok: boolean;
    latencyMs: number;
    mode: string;
    detail: string;
  }> {
    const start = Date.now();
    try {
      const db = await this.getClient();
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

  public async query<T = Record<string, unknown>>(
    sql: string,
    params?: unknown[],
  ): Promise<AtelierQueryResult<T>> {
    const db = await this.getClient();
    return db.query<T>(sql, params);
  }

  public async exec(sql: string): Promise<void> {
    const db = await this.getClient();
    return db.exec(sql);
  }

  public async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    const db = await this.getClient();
    return db.transaction(fn);
  }
}
