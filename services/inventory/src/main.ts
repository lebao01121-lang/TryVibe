import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  correlationIdMiddleware,
  createLogger,
  createPrometheusHttpMiddleware,
  createPrometheusMetricsRouteMiddleware,
  initOpenTelemetry,
} from '@atelier/observability';
import { AppModule } from './app.module';
import { AtelierExceptionFilter } from './common/api-exception';
import { loadInventoryConfig, SERVICE_NAME } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadInventoryConfig();
  const logger = createLogger(config.serviceName);
  initOpenTelemetry({ serviceName: 'inventory', serviceVersion: '3.1.0' });

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  app.use(correlationIdMiddleware);
  app.use(createPrometheusHttpMiddleware('inventory'));
  app.use(createPrometheusMetricsRouteMiddleware());
  app.useGlobalFilters(new AtelierExceptionFilter());

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      const normalized = origin.replace(/\/+$/, '');
      const allowed =
        config.allowedOrigins.includes(normalized) ||
        /^https:\/\/([a-z0-9-]+\.)?localhost(:\d+)?$/i.test(normalized);
      callback(null, allowed);
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'X-CSRF-Token',
      'X-Correlation-Id',
      'traceparent',
      'Idempotency-Key',
      'X-Guest-Session-Id',
    ],
    exposedHeaders: ['X-Correlation-Id', 'traceparent'],
  });

  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
    },
    'Inventory & B2B Procurement microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
