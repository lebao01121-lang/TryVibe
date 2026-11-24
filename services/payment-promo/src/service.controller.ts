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
import { PaymentRedisService } from './cache/payment-redis.service';
import { PAYMENT_CONFIG_TOKEN, type PaymentPromoConfig } from './config/env';
import { PaymentDbService } from './db/payment-db.service';
import { PaymentEventPublisherService } from './messaging/payment-event-publisher.service';

@Controller()
export class PaymentPromoController {
  constructor(
    @Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig,
    private readonly db: PaymentDbService,
    private readonly redis: PaymentRedisService,
    private readonly eventPublisher: PaymentEventPublisherService,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: this.db.getMode(),
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const [dbCheck, redisCheck] = await Promise.all([
      this.db.ping(),
      this.redis.checkHealth(),
    ]);
    const mqConnected = this.eventPublisher.isConnected();

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-payment-db',
        status: dbCheck.ok ? 'up' : 'down',
        latencyMs: dbCheck.latencyMs,
        detail: `${this.config.database.envVar} -> ${dbCheck.detail}`,
      },
      {
        name: 'redis-voucher-lock',
        status: redisCheck.ok ? 'up' : 'skipped',
        latencyMs: redisCheck.latencyMs,
        detail: redisCheck.detail,
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseMode: dbCheck.mode,
        databaseEnvVar: this.config.database.envVar,
        rabbitmqConnected: mqConnected,
      },
    });
  }

  @Get('api/v1/payments/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-5',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          mode: this.db.getMode(),
          configured: this.config.database.configured,
        },
        aggregates: [
          'payment_transactions',
          'processed_webhooks',
          'promotions',
          'voucher_redemptions',
        ],
        paymentGateways: ['VIETQR', 'VNPAY', 'MOMO', 'COD'],
        idempotencyPolicy: {
          webhookSignatureVerification: 'HMAC_SHA256_TIMING_SAFE',
          uniqueWebhookConstraint: '(provider, provider_event_id)',
          latePaymentDetection: true,
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          connected: this.eventPublisher.isConnected(),
          publishes: [
            EVENT_NAMES.PAYMENT_SUCCEEDED,
            EVENT_NAMES.PAYMENT_EXPIRED,
            EVENT_NAMES.PAYMENT_LATE_DETECTED,
          ],
          consumes: [EVENT_NAMES.ORDER_CREATED, EVENT_NAMES.RMA_QC_PASSED],
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
