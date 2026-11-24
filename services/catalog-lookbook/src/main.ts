import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { correlationIdMiddleware, createLogger } from '@atelier/observability';
import { AppModule } from './app.module';
import { CatalogHttpExceptionFilter } from './common/http-exception.filter';
import { loadCatalogLookbookConfig, SERVICE_NAME } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadCatalogLookbookConfig();
  const logger = createLogger(config.serviceName);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new CatalogHttpExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
      ragVectorDatabase: config.ragDatabase.targetDatabase,
      meilisearchHost: config.infra.meilisearchHost,
    },
    'Catalog & Lookbook microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
