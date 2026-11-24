import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  createApiResponse,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type ApiResponse,
  type DependencyCheck,
} from '@atelier/contracts';
import {
  buildHealthPayload,
  buildReadinessPayload,
  getOrCreateCorrelationId,
  type HeaderBag,
  type StandardHealthPayload,
  type StandardReadinessPayload,
} from '@atelier/observability';
import { CatalogService } from './catalog/catalog.service';
import { CATALOG_CONFIG_TOKEN, type CatalogLookbookConfig } from './config/env';
import { CatalogDbService } from './db/catalog-db.service';
import { CatalogRagService } from './rag/catalog-rag.service';
import { MeilisearchService } from './search/meilisearch.service';

@Controller()
export class CatalogLookbookController {
  constructor(
    @Inject(CATALOG_CONFIG_TOKEN)
    private readonly config: CatalogLookbookConfig,
    @Inject(CatalogDbService) private readonly db: CatalogDbService,
    @Inject(MeilisearchService) private readonly meili: MeilisearchService,
    @Inject(CatalogRagService) private readonly rag: CatalogRagService,
    @Inject(CatalogService) private readonly catalog: CatalogService,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      startedAtMs,
      version: '3.0.0',
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        dbMode: this.db.getMode(),
        ragDbMode: this.rag.getMode(),
        ragDocuments: this.rag.getDocumentCount(),
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const dbStart = Date.now();
    let dbUp = false;
    try {
      const client = await this.db.getClient();
      await client.query('SELECT 1 AS ok');
      dbUp = true;
    } catch {
      dbUp = false;
    }
    const dbLatencyMs = Date.now() - dbStart;

    const meiliStart = Date.now();
    const meiliReachable = await this.meili.checkReachable(300);
    const meiliLatencyMs = Date.now() - meiliStart;

    const checks: DependencyCheck[] = [
      {
        name: 'catalog-db',
        status: dbUp ? 'up' : 'down',
        latencyMs: dbLatencyMs,
        detail: `${this.config.database.targetDatabase} (${this.db.getMode()})`,
      },
      {
        name: 'rag-vector-db',
        status: this.rag.getDocumentCount() > 0 ? 'up' : 'skipped',
        detail: `rag_vector_db (${this.rag.getMode()}, docs=${this.rag.getDocumentCount()})`,
      },
      {
        name: 'meilisearch-index',
        status: meiliReachable ? 'up' : 'skipped',
        latencyMs: meiliLatencyMs,
        detail: meiliReachable
          ? `Connected to ${this.config.infra.meilisearchHost} (atelier_products)`
          : `Meilisearch unreachable at ${this.config.infra.meilisearchHost} — PostgreSQL fallback active`,
      },
      {
        name: 'rabbitmq-event-bus',
        status: 'skipped',
        detail: this.config.infra.rabbitmqConfigured
          ? `Exchange ${RABBITMQ_EXCHANGES.DOMAIN_TOPIC} configured`
          : 'RabbitMQ URL not configured',
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseEnvVar: this.config.database.envVar,
        seedSummary: this.catalog.getLastSeedSummary(),
      },
    });
  }

  @Get('api/v1/catalog/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-1',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          configured: this.config.database.configured,
          activeMode: this.db.getMode(),
        },
        ragVectorDb: {
          envVar: this.config.ragDatabase.envVar,
          targetDatabase: this.config.ragDatabase.targetDatabase,
          activeMode: this.rag.getMode(),
          seededDocuments: this.rag.getDocumentCount(),
          pgvectorEnabled: true,
        },
        aggregates: [
          'categories',
          'size_charts',
          'products',
          'product_variants',
          'skus',
          'occasion_lookbooks',
          'seasonal_collections',
          'packaging_options',
          'homepage_campaigns',
          'supplier_product_submissions',
        ],
        searchEngine: {
          provider: 'Meilisearch',
          index: 'atelier_products',
          host: this.config.infra.meilisearchHost,
          healthy: this.meili.isHealthy(),
          vietnameseAccentInsensitive: true,
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          publishes: [
            'catalog.product.published',
            'catalog.sku.created',
            'catalog.lookbook.updated',
          ],
          consumes: [
            EVENT_NAMES.MEDIA_ASSET_PROCESSED,
            EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED,
          ],
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
