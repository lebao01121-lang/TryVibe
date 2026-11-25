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
import { NotifyHttpExceptionFilter } from './common/http-exception.filter';
import { loadNotifyReviewConfig, SERVICE_NAME } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadNotifyReviewConfig();
  const logger = createLogger(config.serviceName);
  initOpenTelemetry({ serviceName: 'notify-review', serviceVersion: '3.1.0' });

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  app.use(correlationIdMiddleware);
  app.use(createPrometheusHttpMiddleware('notify-review'));
  app.use(createPrometheusMetricsRouteMiddleware());
  app.useGlobalFilters(new NotifyHttpExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
      smtpHost: config.infra.smtpHost,
      smtpPort: config.infra.smtpPort,
      catalogServiceUrl: config.infra.catalogServiceUrl,
    },
    'Notification & Verified Fit Reviews microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
