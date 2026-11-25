import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  createApiResponse,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  RETRY_BACKOFF_MS,
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
import { ORDER_CONFIG_TOKEN, type OrderRmaConfig } from './config/env';
import { OrderDbService } from './db/order-db.service';
import { OrderRabbitMqService } from './infra/rabbitmq.service';
import { ShippingProviderRegistry } from './shipping/shipping-provider.registry';

@Controller()
export class OrderRmaController {
  constructor(
    @Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig,
    private readonly db: OrderDbService,
    private readonly rabbitmq: OrderRabbitMqService,
    private readonly shippingRegistry: ShippingProviderRegistry,
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
        dbMode: this.db.mode,
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const dbStart = Date.now();
    const dbUp = await this.db.ping();
    const dbLatencyMs = Date.now() - dbStart;

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-postgres-order-db',
        status: dbUp ? 'up' : 'down',
        latencyMs: dbLatencyMs,
        detail: `${this.config.database.envVar} -> ${this.config.database.targetDatabase} (${this.db.mode})`,
      },
    ];

    if (this.rabbitmq.isConnected()) {
      checks.push({
        name: 'rabbitmq-saga-bus',
        status: 'up',
        latencyMs: 0,
        detail: `Exchange ${RABBITMQ_EXCHANGES.DOMAIN_TOPIC} connected`,
      });
    }

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseEnvVar: this.config.database.envVar,
        dbMode: this.db.mode,
        rabbitmqConfigured: this.config.rabbitmq.configured,
        rabbitmqConnected: this.rabbitmq.isConnected(),
      },
    });
  }

  @Get('api/v1/orders/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-6',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          configured: this.config.database.configured,
          mode: this.db.mode,
        },
        aggregates: [
          'orders',
          'order_items',
          'shipments',
          'rma_requests',
          'rma_items',
          'outbox_events',
          'processed_events',
          'processed_shipping_webhooks',
        ],
        shippingProviders: this.shippingRegistry.getProviderStatuses(),
        shippingEndpoints: [
          'POST /v1/shipping/quote',
          'POST /v1/shipping/webhooks/ghn',
          'POST /v1/shipping/webhooks/ghtk',
          'POST /v1/shipping/webhooks/ahamove',
        ],
        sagaPolicy: {
          orchestrator: true,
          transactionalOutbox: true,
          reservationTtlSeconds: this.config.reservationTtlSeconds,
          sweeperIntervalMs: this.config.sweeperIntervalMs,
          retryBackoffMs: [...RETRY_BACKOFF_MS],
          supportedRmaTypes: ['SIZE_EXCHANGE', 'COLOR_EXCHANGE', 'RETURN_REFUND'],
          supportedExchangeModes: ['INSTANT_2WAY', 'STANDARD_QC'],
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          dlxExchange: RABBITMQ_EXCHANGES.DLX_DIRECT,
          publishes: [
            EVENT_NAMES.ORDER_CREATED,
            EVENT_NAMES.PAYMENT_EXPIRED,
            EVENT_NAMES.PAYMENT_LATE_DETECTED,
            EVENT_NAMES.RMA_REQUESTED,
            EVENT_NAMES.RMA_QC_PASSED,
          ],
          consumes: [EVENT_NAMES.PAYMENT_SUCCEEDED],
        },
        infra: this.config.infra,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
