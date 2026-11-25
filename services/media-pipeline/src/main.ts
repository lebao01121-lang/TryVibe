import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HTTP_HEADERS } from '@atelier/contracts';
import {
  correlationIdMiddleware,
  createLogger,
  createPrometheusHttpMiddleware,
  createPrometheusMetricsRouteMiddleware,
  initOpenTelemetry,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import { AppModule } from './app.module';
import {
  isAllowedCorsOrigin,
  loadMediaPipelineConfig,
  SERVICE_NAME,
} from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadMediaPipelineConfig();
  const logger = createLogger(config.serviceName);
  initOpenTelemetry({ serviceName: 'media-pipeline', serviceVersion: '3.1.0' });

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });

  // Support up to 20MB JSON payloads for base64 image uploads (raw image cap is strictly 10MB)
  app.useBodyParser('json', { limit: '20mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '20mb' });
  app.useBodyParser('raw', {
    type: ['image/*', 'application/octet-stream'],
    limit: '15mb',
  });
  app.use(correlationIdMiddleware);
  app.use(createPrometheusHttpMiddleware('media-pipeline'));
  app.use(createPrometheusMetricsRouteMiddleware());

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (isAllowedCorsOrigin(origin, config.corsAllowedOrigins)) {
        callback(null, true);
      } else {
        callback(null, false);
      }
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Accept',
      HTTP_HEADERS.AUTHORIZATION,
      HTTP_HEADERS.CORRELATION_ID,
      HTTP_HEADERS.IDEMPOTENCY_KEY,
      HTTP_HEADERS.CSRF_TOKEN,
      HTTP_HEADERS.GUEST_SESSION_ID,
      TRACEPARENT_HEADER,
      'X-User-Id',
      'X-Supplier-Id',
    ],
    exposedHeaders: [
      HTTP_HEADERS.CORRELATION_ID,
      TRACEPARENT_HEADER,
      'ETag',
      'Content-Length',
      'Content-Type',
    ],
  });

  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
      minioEndpoint: config.infra.minioEndpointUrl,
      publicBaseUrl: config.publicBaseUrl,
      buckets: config.infra.buckets,
    },
    'Media & Asset Pipeline microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
