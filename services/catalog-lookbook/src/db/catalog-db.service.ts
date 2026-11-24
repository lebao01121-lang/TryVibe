import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  createIsolatedPgClient,
  type AtelierDbClient,
  type AtelierDbMode,
} from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  CATALOG_CONFIG_TOKEN,
  type CatalogLookbookConfig,
  SERVICE_NAME,
} from '../config/env';

@Injectable()
export class CatalogDbService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:db`);
  private client: AtelierDbClient | null = null;
  private initPromise: Promise<AtelierDbClient> | null = null;

  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    private readonly config: CatalogLookbookConfig,
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

  public getMode(): AtelierDbMode {
    return this.client?.mode ?? 'pglite';
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
      path.resolve(process.cwd(), 'services/catalog-lookbook/src/db/schema.sql'),
      path.resolve(process.cwd(), 'src/db/schema.sql'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return fs.readFileSync(candidate, 'utf8');
      }
    }
    throw new Error('Could not locate catalog-lookbook schema.sql');
  }

  private async initializeDatabase(): Promise<AtelierDbClient> {
    const client = await createIsolatedPgClient({
      databaseUrl: this.config.database.url,
      dbName: this.config.database.targetDatabase,
      enableVector: false,
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
      'Isolated catalog_db initialized and schema migrated',
    );
    return client;
  }
}
