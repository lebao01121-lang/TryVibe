import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { correlationIdMiddleware, createLogger } from '@atelier/observability';
import { AppModule } from './app.module';
import { ApiExceptionFilter } from './common/api-exception';
import { loadOrderRmaConfig, SERVICE_NAME } from './config/env';

async function bootstrap(): Promise<void> {
  const config = loadOrderRmaConfig();
  const logger = createLogger(config.serviceName);

  const app = await NestFactory.create(AppModule, {
    logger: ['error', 'warn'],
  });

  app.enableCors({
    origin: config.corsAllowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Idempotency-Key',
      'X-Correlation-Id',
      'traceparent',
      'X-Guest-Session-Id',
      'X-User-Id',
      'X-Actor-Roles',
      'X-Loyalty-Tier',
      'X-Internal-Secret',
    ],
    exposedHeaders: ['X-Correlation-Id', 'traceparent'],
  });

  app.use(correlationIdMiddleware);
  app.useGlobalFilters(new ApiExceptionFilter());
  app.enableShutdownHooks();

  await app.listen(config.port);

  logger.info(
    {
      port: config.port,
      boundedContext: config.boundedContext,
      isolatedDatabase: config.database.targetDatabase,
    },
    'Order Saga & RMA microservice listening',
  );
}

void bootstrap().catch((error: unknown) => {
  const logger = createLogger(SERVICE_NAME);
  logger.error({ err: error }, `Failed to bootstrap ${SERVICE_NAME}`);
  process.exit(1);
});
