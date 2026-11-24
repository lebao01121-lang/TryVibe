import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import { HTTP_HEADERS } from '@atelier/contracts';
import {
  correlationIdMiddleware,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import { AppModule } from './app.module';
import { loadBffConfig } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadBffConfig();
  const logger = createLogger(config.serviceName);

  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    logger: ['error', 'warn'],
    bodyParser: false,
  });

  app.useBodyParser('json', { limit: '15mb' });
  app.useBodyParser('urlencoded', { extended: true, limit: '15mb' });
  app.use(cookieParser());
  app.use(correlationIdMiddleware);

  const allowedOriginSet = new Set(
    config.corsAllowedOrigins.map((origin) => origin.trim().replace(/\/+$/, '')),
  );

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void,
    ) => {
      if (!origin || allowedOriginSet.has(origin.trim().replace(/\/+$/, ''))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Accept',
      'Content-Type',
      'Origin',
      'X-Requested-With',
      HTTP_HEADERS.AUTHORIZATION,
      HTTP_HEADERS.CORRELATION_ID,
      TRACEPARENT_HEADER,
      HTTP_HEADERS.IDEMPOTENCY_KEY,
      HTTP_HEADERS.CSRF_TOKEN,
      HTTP_HEADERS.GUEST_SESSION_ID,
      'x-load-test-bypass',
    ],
    exposedHeaders: [
      HTTP_HEADERS.CORRELATION_ID,
      TRACEPARENT_HEADER,
      'X-Cache',
      'X-Cache-Key',
      'X-RateLimit-Limit',
      'X-RateLimit-Remaining',
      'Retry-After',
    ],
    preflightContinue: false,
    optionsSuccessStatus: 204,
    maxAge: 600,
  });

  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      corsOrigins: config.corsAllowedOrigins,
      realtimeNamespace: '/realtime',
      authUpstream: config.upstreams.authCustomerUrl,
      catalogUpstream: config.upstreams.catalogLookbookUrl,
      mediaUpstream: config.upstreams.mediaPipelineUrl,
    },
    'Zero-Trust Fashion Atelier BFF & Socket.io Hub listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger('@atelier/bff');
  logger.error({ err: error }, 'Failed to bootstrap @atelier/bff');
  process.exit(1);
});
