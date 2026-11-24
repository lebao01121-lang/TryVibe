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
import { INVENTORY_CONFIG_TOKEN, type InventoryConfig } from './config/env';
import { InventoryDatabaseService } from './infra/database.service';
import { InventoryRabbitMqService } from './infra/rabbitmq.service';
import { InventoryRedisService } from './infra/redis.service';

@Controller()
export class InventoryController {
  constructor(
    @Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig,
    private readonly db: InventoryDatabaseService,
    private readonly redis: InventoryRedisService,
    private readonly rabbitmq: InventoryRabbitMqService,
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
        dbReady: this.db.isReady(),
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const dbStart = Date.now();
    const dbUp = await this.db.ping();
    const dbLatency = Date.now() - dbStart;

    const redisStart = Date.now();
    const redisUp = await this.redis.ping();
    const redisLatency = Date.now() - redisStart;

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-inventory-db',
        status: dbUp ? 'up' : 'down',
        latencyMs: dbLatency,
        detail: `${this.config.database.envVar} -> ${this.config.database.targetDatabase} (mode=${this.db.mode})`,
      },
      {
        name: 'redis-atomic-lua-gate',
        status: redisUp ? 'up' : 'skipped',
        latencyMs: redisLatency,
        detail: redisUp
          ? 'Redis connected (ATELIER_LUA_RESERVE / ATELIER_LUA_RELEASE)'
          : 'Redis unreachable (ACID Postgres fallback active)',
      },
      {
        name: 'rabbitmq-event-bus',
        status: this.rabbitmq.isConnected() ? 'up' : 'skipped',
        detail: this.config.infra.rabbitmqConfigured
          ? `Exchange ${RABBITMQ_EXCHANGES.DOMAIN_TOPIC} configured (graceful async publish)`
          : 'RabbitMQ URL not configured',
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        databaseEnvVar: this.config.database.envVar,
        dbMode: this.db.mode,
      },
    });
  }

  @Get('api/v1/inventory/meta')
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
          configured: this.config.database.configured,
          mode: this.db.mode,
        },
        aggregates: [
          'warehouses',
          'stock_levels',
          'stock_reservations',
          'stock_reservation_items',
          'inventory_ledger',
          'suppliers',
          'purchase_orders',
          'purchase_order_items',
          'goods_receipts',
          'goods_receipt_items',
          'supplier_payables',
          'outbox_events',
          'processed_events',
        ],
        consistencyGuarantees: {
          antiOversellLock: 'Redis Lua ATELIER_LUA_RESERVE + Postgres FOR UPDATE & CHECK(available_qty >= 0)',
          deadlockPrevention: 'ascending_sku_id_sort',
          autoReleaseIntervalSeconds: Math.round(this.config.expireSweepIntervalMs / 1000),
          aiPoDraftStatus: 'NHAP_AI',
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          publishes: [
            EVENT_NAMES.INVENTORY_STOCK_RESERVED,
            EVENT_NAMES.INVENTORY_STOCK_RESERVE_FAILED,
            EVENT_NAMES.INVENTORY_STOCK_REPLENISHED,
            'inventory.availability.changed',
          ],
          consumes: [EVENT_NAMES.ORDER_CREATED, EVENT_NAMES.RMA_QC_PASSED],
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
