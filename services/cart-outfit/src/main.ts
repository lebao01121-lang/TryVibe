import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { HTTP_HEADERS } from '@atelier/contracts';
import {
  correlationIdMiddleware,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import { AppModule } from './app.module';
import {
  isAllowedCorsOrigin,
  loadCartOutfitConfig,
  SERVICE_NAME,
} from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadCartOutfitConfig();
  const logger = createLogger(config.serviceName);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });

  app.useBodyParser('json', { limit: '2mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '2mb' });
  app.use(correlationIdMiddleware);

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
    ],
    exposedHeaders: [HTTP_HEADERS.CORRELATION_ID, TRACEPARENT_HEADER],
  });

  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
      upstreams: config.upstreams,
    },
    'Cart & Outfit Studio microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
