import { Module } from '@nestjs/common';
import { CatalogController } from './catalog/catalog.controller';
import { CatalogService } from './catalog/catalog.service';
import { CATALOG_CONFIG_TOKEN, loadCatalogLookbookConfig } from './config/env';
import { CatalogDbService } from './db/catalog-db.service';
import { CatalogRagService } from './rag/catalog-rag.service';
import { MeilisearchService } from './search/meilisearch.service';
import { CatalogLookbookController } from './service.controller';

@Module({
  controllers: [CatalogLookbookController, CatalogController],
  providers: [
    {
      provide: CATALOG_CONFIG_TOKEN,
      useFactory: () => loadCatalogLookbookConfig(),
    },
    CatalogDbService,
    MeilisearchService,
    CatalogRagService,
    CatalogService,
  ],
})
export class AppModule {}
