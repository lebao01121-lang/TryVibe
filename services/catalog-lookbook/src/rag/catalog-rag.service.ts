import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import {
  PgVectorRagStore,
  type HybridRagQueryOutput,
} from '@atelier/ai-harness';
import type { AtelierDbMode } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  CATALOG_CONFIG_TOKEN,
  type CatalogLookbookConfig,
  SERVICE_NAME,
} from '../config/env';

@Injectable()
export class CatalogRagService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:rag`);
  private readonly store: PgVectorRagStore;
  private seededCount = 0;

  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    config: CatalogLookbookConfig,
  ) {
    this.store = new PgVectorRagStore({
      databaseUrl: config.ragDatabase.url,
      dbName: config.ragDatabase.targetDatabase,
    });
  }

  async onModuleInit(): Promise<void> {
    try {
      await this.store.ensureInitialized();
      this.seededCount = await this.store.getDocumentCount();
      this.logger.info(
        {
          dbName: 'rag_vector_db',
          mode: this.store.getMode(),
          documents: this.seededCount,
        },
        'Hybrid RAG pgvector store initialized on rag_vector_db',
      );
    } catch (error) {
      this.logger.warn(
        { err: error instanceof Error ? error.message : String(error) },
        'Lazy RAG initialization deferred until first query',
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    await this.store.close();
  }

  public getMode(): AtelierDbMode {
    return this.store.getMode();
  }

  public getDocumentCount(): number {
    return this.seededCount;
  }

  public async query(queryText: string, topK = 5): Promise<HybridRagQueryOutput> {
    const result = await this.store.queryHybrid(queryText, { topK });
    if (this.seededCount === 0) {
      this.seededCount = await this.store.getDocumentCount().catch(() => 0);
    }
    return result;
  }
}
