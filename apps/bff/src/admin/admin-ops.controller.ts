import * as crypto from 'node:crypto';
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Post,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  HTTP_HEADERS,
  Permission,
  Role,
  type ApiResponse,
  type JwtAccessPayload,
} from '@atelier/contracts';
import {
  createChildTraceparent,
  getOrCreateCorrelationId,
  getOrCreateTraceparent,
  TRACEPARENT_HEADER,
  type HeaderBag,
} from '@atelier/observability';
import type { Request } from 'express';
import { BffRedisService } from '../common/redis.service';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../security/auth-types';
import { AdminPortalGuard, JwtAuthGuard } from '../security/guards';

type NodeHealthStatus = 'UP' | 'DEGRADED' | 'DOWN';

interface ClusterNodeHealth {
  name: string;
  port: number;
  url?: string;
  status: NodeHealthStatus;
  latencyMs: number;
  details: Record<string, unknown>;
}

interface RabbitQueueApiItem {
  name?: string;
  state?: string;
  messages?: number;
  messages_ready?: number;
  messages_unacknowledged?: number;
  consumers?: number;
}

interface RabbitGetMessageApiItem {
  payload?: string;
  payload_bytes?: number;
  payload_encoding?: string;
  redelivered?: boolean;
  exchange?: string;
  routing_key?: string;
  message_count?: number;
  properties?: {
    message_id?: string;
    correlation_id?: string;
    content_type?: string;
    delivery_mode?: number;
    timestamp?: number;
    headers?: Record<string, unknown>;
    [key: string]: unknown;
  };
}

interface OllamaTagsProbeResult {
  reachable: boolean;
  port: number;
  baseUrl: string;
  latencyMs: number;
  loadedModels: string[];
  error?: string;
}

const VALID_DLQ_NAME_REGEX = /^[a-zA-Z0-9._-]+\.dlq$/;
const CORE_CLUSTER_SERVICES = new Set([
  'bff',
  'auth-customer',
  'catalog-lookbook',
  'inventory',
  'order-rma',
  'payment-promo',
]);

function extractPortFromUrl(url: string, fallback: number): number {
  try {
    const parsed = new URL(url);
    if (parsed.port) {
      const p = Number.parseInt(parsed.port, 10);
      if (Number.isFinite(p) && p > 0) {
        return p;
      }
    }
    return parsed.protocol === 'https:' ? 443 : fallback;
  } catch {
    return fallback;
  }
}

function normalizeNodeStatus(raw: unknown, readyFlag?: unknown): NodeHealthStatus {
  if (readyFlag === false) {
    return 'DOWN';
  }
  const s = String(raw ?? '').toUpperCase();
  if (s === 'UP' || s === 'OK' || s === 'HEALTHY' || s === 'AVAILABLE') {
    return 'UP';
  }
  if (s === 'DEGRADED' || s === 'WARN' || s === 'WARNING') {
    return 'DEGRADED';
  }
  return 'DOWN';
}

function unwrapDataRecord(payload: unknown): Record<string, unknown> {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {};
  }
  const rec = payload as Record<string, unknown>;
  if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return rec;
}

function asNum(value: unknown, fallback = 0): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function asStr(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback;
}

function tryParseJsonPayload(raw: unknown): unknown {
  if (typeof raw !== 'string') {
    return raw ?? null;
  }
  const trimmed = raw.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return raw;
  }
}

@Controller('api/v1/admin/ops')
@UseGuards(JwtAuthGuard, AdminPortalGuard)
export class AdminOpsController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  // ============================================================================
  // 1. 11-Service Cluster Health & 5-Node Infrastructure Telemetry
  // ============================================================================

  @Get('health-cluster')
  @RequireAnyPermission(Permission.ADMIN_AUDIT_READ, Permission.INVENTORY_STOCK_READ)
  async getHealthCluster(@Req() req: Request): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);
    const checkedAt = new Date().toISOString();

    const serviceTargets: Array<{ name: string; baseUrl: string; defaultPort: number }> = [
      { name: 'auth-customer', baseUrl: this.config.upstreams.authCustomerUrl, defaultPort: 4001 },
      {
        name: 'catalog-lookbook',
        baseUrl: this.config.upstreams.catalogLookbookUrl,
        defaultPort: 4002,
      },
      {
        name: 'media-pipeline',
        baseUrl: this.config.upstreams.mediaPipelineUrl,
        defaultPort: 4003,
      },
      { name: 'inventory', baseUrl: this.config.upstreams.inventoryUrl, defaultPort: 4004 },
      { name: 'cart-outfit', baseUrl: this.config.upstreams.cartOutfitUrl, defaultPort: 4005 },
      { name: 'order-rma', baseUrl: this.config.upstreams.orderRmaUrl, defaultPort: 4006 },
      { name: 'payment-promo', baseUrl: this.config.upstreams.paymentPromoUrl, defaultPort: 4007 },
      { name: 'notify-review', baseUrl: this.config.upstreams.notifyReviewUrl, defaultPort: 4008 },
      { name: 'ai-tryon', baseUrl: this.config.upstreams.aiTryOnUrl, defaultPort: 4009 },
      { name: 'mcp-copilot', baseUrl: this.config.upstreams.mcpCopilotUrl, defaultPort: 4010 },
    ];

    const [bffSelf, remoteServices, coreInfra, ollamaProbe] = await Promise.all([
      this.probeBffSelf(),
      Promise.all(
        serviceTargets.map((target) =>
          this.probeServiceNode(
            target.name,
            target.baseUrl,
            extractPortFromUrl(target.baseUrl, target.defaultPort),
            correlationId,
            parentTraceparent,
          ),
        ),
      ),
      Promise.all([
        this.probeRedisInfra(),
        this.probeHttpInfra(
          'Meilisearch',
          extractPortFromUrl(this.config.meilisearchHost, 7700),
          [`${this.config.meilisearchHost}/health`],
          correlationId,
          parentTraceparent,
        ),
        this.probeHttpInfra(
          'MinIO',
          extractPortFromUrl(this.config.minioPublicUrl, 9000),
          [`${this.config.minioPublicUrl}/minio/health/live`, `${this.config.minioPublicUrl}/`],
          correlationId,
          parentTraceparent,
        ),
        this.probeHttpInfra(
          'Mailpit',
          extractPortFromUrl(this.config.mailpitUiUrl, 8025),
          [`${this.config.mailpitUiUrl}/livez`, `${this.config.mailpitUiUrl}/api/v1/messages`],
          correlationId,
          parentTraceparent,
        ),
        this.probeRabbitMqInfra(correlationId, parentTraceparent),
      ]),
      this.probeOllamaEngine(correlationId, parentTraceparent),
    ]);

    const mcpNode = remoteServices.find((node) => node.name === 'mcp-copilot');
    const mcpDetails = mcpNode?.details ?? {};
    const mcpMeta =
      mcpDetails.metadata && typeof mcpDetails.metadata === 'object'
        ? (mcpDetails.metadata as Record<string, unknown>)
        : {};

    const activeMainModel =
      asStr(mcpMeta.activeMainModel ?? mcpDetails.activeMainModel) ||
      this.config.ollamaMainModel;
    const activeFastModel =
      asStr(mcpMeta.activeFastModel ?? mcpDetails.activeFastModel) ||
      this.config.ollamaFastModel;
    const activeEmbedModel =
      asStr(mcpMeta.activeEmbedModel ?? mcpDetails.activeEmbedModel) ||
      this.config.ollamaEmbedModel;
    const embedDim = asNum(
      mcpMeta.embedDim ?? mcpDetails.embedDim,
      this.config.ollamaEmbedDim,
    );
    const ollamaReachable =
      ollamaProbe.reachable ||
      Boolean(mcpMeta.ollamaReachable ?? mcpDetails.ollamaReachable);
    const fallbackMode =
      mcpMeta.fallbackMode !== undefined
        ? Boolean(mcpMeta.fallbackMode)
        : mcpDetails.fallbackMode !== undefined
          ? Boolean(mcpDetails.fallbackMode)
          : !ollamaReachable;

    const ollamaInfraNode: ClusterNodeHealth = {
      name: 'Ollama Local AI',
      port: ollamaProbe.port,
      status: ollamaProbe.reachable ? 'UP' : 'DOWN',
      latencyMs: ollamaProbe.latencyMs,
      details: {
        baseUrl: ollamaProbe.baseUrl,
        loadedModels: ollamaProbe.loadedModels,
        activeMainModel,
        activeFastModel,
        activeEmbedModel,
        embedDim,
        fallbackMode,
        ...(ollamaProbe.error ? { error: ollamaProbe.error } : {}),
      },
    };

    const infra: ClusterNodeHealth[] = [...coreInfra, ollamaInfraNode];
    const services: ClusterNodeHealth[] = [bffSelf, ...remoteServices];
    const servicesUp = services.filter((s) => s.status === 'UP').length;
    const servicesDegraded = services.filter((s) => s.status === 'DEGRADED').length;
    const servicesDown = services.filter((s) => s.status === 'DOWN').length;
    const infraUp = infra.filter((n) => n.status === 'UP').length;

    const coreDown = services.some(
      (s) => CORE_CLUSTER_SERVICES.has(s.name) && s.status === 'DOWN',
    );

    let overallStatus: NodeHealthStatus = 'UP';
    if (coreDown || servicesDown > 3) {
      overallStatus = 'DOWN';
    } else if (
      servicesDown > 0 ||
      servicesDegraded > 0 ||
      infra.some((n) => n.status !== 'UP')
    ) {
      overallStatus = 'DEGRADED';
    }

    return createApiResponse(
      {
        checkedAt,
        overallStatus,
        summary: {
          totalServices: services.length,
          servicesUp,
          servicesDegraded,
          servicesDown,
          totalInfra: infra.length,
          infraUp,
        },
        ollama: {
          reachable: ollamaReachable,
          baseUrl: ollamaProbe.baseUrl,
          activeMainModel,
          activeFastModel,
          activeEmbedModel,
          embedDim,
          loadedModels: ollamaProbe.loadedModels,
          fallbackMode,
        },
        services,
        infra,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  // ============================================================================
  // 2. RabbitMQ Dead-Letter Queue (*.dlq) Operational Console
  // ============================================================================

  @Get('dlq')
  @RequireAnyPermission(Permission.ADMIN_AUDIT_READ, Permission.INVENTORY_STOCK_READ)
  async listDlqQueues(@Req() req: Request): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);

    const queuesResp = await this.rabbitRequest<RabbitQueueApiItem[]>(
      'GET',
      '/api/queues/%2F',
      undefined,
      correlationId,
      parentTraceparent,
    );

    const dlqItems = (Array.isArray(queuesResp) ? queuesResp : [])
      .filter((q) => typeof q.name === 'string' && q.name.endsWith('.dlq'))
      .sort((a, b) => (a.name ?? '').localeCompare(b.name ?? ''));

    const queues = await Promise.all(
      dlqItems.map(async (q) => {
        const name = q.name ?? 'unknown.dlq';
        const messageCount = asNum(q.messages ?? q.messages_ready, 0);
        let peeked: RabbitGetMessageApiItem[] = [];

        if (messageCount > 0) {
          try {
            const rawMessages = await this.rabbitRequest<RabbitGetMessageApiItem[]>(
              'POST',
              `/api/queues/%2F/${encodeURIComponent(name)}/get`,
              {
                count: 20,
                ackmode: 'ack_requeue_true',
                encoding: 'auto',
                truncate: 50_000,
              },
              correlationId,
              parentTraceparent,
            );
            peeked = Array.isArray(rawMessages) ? rawMessages : [];
          } catch {
            peeked = [];
          }
        }

        const messages = peeked.map((msg) => this.normalizeDlqMessage(msg, name));
        return {
          name,
          state: asStr(q.state, 'running'),
          messageCount: Math.max(messageCount, messages.length),
          consumers: asNum(q.consumers, 0),
          messages,
        };
      }),
    );

    return createApiResponse(
      {
        source: this.config.rabbitmqMgmtUrl,
        checkedAt: new Date().toISOString(),
        queues,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  @Post('dlq/:queue/replay')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async replayDlqQueue(
    @Param('queue') queue: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);
    this.assertSuperAdminWithMfa(user, correlationId);
    const normalizedQueue = this.assertValidDlqName(queue, correlationId);
    const targetQueue = normalizedQueue.replace(/\.dlq$/, '');

    const requestedMax = asNum(body?.maxCount, 50);
    const maxCount = Math.max(1, Math.min(500, Math.floor(requestedMax)));

    const popped = await this.rabbitRequest<RabbitGetMessageApiItem[]>(
      'POST',
      `/api/queues/%2F/${encodeURIComponent(normalizedQueue)}/get`,
      {
        count: maxCount,
        ackmode: 'ack_requeue_false',
        encoding: 'auto',
      },
      correlationId,
      parentTraceparent,
    );

    const items = Array.isArray(popped) ? popped : [];
    let replayedCount = 0;
    let failedCount = 0;
    const replayedCorrelationIds: string[] = [];

    for (const msg of items) {
      const origProps = msg.properties ?? {};
      const origHeaders =
        origProps.headers && typeof origProps.headers === 'object' ? origProps.headers : {};
      const msgCorrelationId =
        asStr(origHeaders['x-correlation-id']) ||
        asStr(origProps.correlation_id) ||
        correlationId;

      const publishBody = {
        properties: {
          ...origProps,
          delivery_mode: origProps.delivery_mode ?? 2,
          content_type: origProps.content_type ?? 'application/json',
          correlation_id: msgCorrelationId,
          headers: {
            ...origHeaders,
            'x-correlation-id': msgCorrelationId,
            'x-replayed-from': normalizedQueue,
            'x-replayed-by': user.sub,
            'x-replayed-at': new Date().toISOString(),
          },
        },
        routing_key: targetQueue,
        payload:
          typeof msg.payload === 'string' ? msg.payload : JSON.stringify(msg.payload ?? {}),
        payload_encoding: msg.payload_encoding || 'string',
      };

      try {
        await this.rabbitRequest<Record<string, unknown>>(
          'POST',
          '/api/exchanges/%2F/amq.default/publish',
          publishBody,
          correlationId,
          parentTraceparent,
        );
        replayedCount += 1;
        replayedCorrelationIds.push(msgCorrelationId);
      } catch {
        failedCount += 1;
      }
    }

    await this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: 'DLQ_REPLAY',
      resourceType: 'RABBITMQ_DLQ',
      resourceId: normalizedQueue,
      beforeJsonb: {
        queue: normalizedQueue,
        poppedCount: items.length,
      },
      afterJsonb: {
        queue: normalizedQueue,
        targetQueue,
        replayedCount,
        failedCount,
        replayedCorrelationIds: replayedCorrelationIds.slice(0, 20),
      },
      correlationId,
      ipAddress: req.ip,
    });

    return createApiResponse(
      {
        queue: normalizedQueue,
        targetQueue,
        poppedCount: items.length,
        replayedCount,
        failedCount,
        replayedCorrelationIds,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  @Delete('dlq/:queue/purge')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async purgeDlqQueue(
    @Param('queue') queue: string,
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);
    this.assertSuperAdminWithMfa(user, correlationId);
    const normalizedQueue = this.assertValidDlqName(queue, correlationId);

    let previousMessageCount = 0;
    try {
      const info = await this.rabbitRequest<RabbitQueueApiItem>(
        'GET',
        `/api/queues/%2F/${encodeURIComponent(normalizedQueue)}`,
        undefined,
        correlationId,
        parentTraceparent,
      );
      previousMessageCount = asNum(info?.messages ?? info?.messages_ready, 0);
    } catch {
      previousMessageCount = 0;
    }

    await this.rabbitRequest<unknown>(
      'DELETE',
      `/api/queues/%2F/${encodeURIComponent(normalizedQueue)}/contents`,
      undefined,
      correlationId,
      parentTraceparent,
    );

    await this.audit.record({
      actorId: user.sub,
      actorEmail: user.email,
      action: 'DLQ_PURGE',
      resourceType: 'RABBITMQ_DLQ',
      resourceId: normalizedQueue,
      beforeJsonb: {
        queue: normalizedQueue,
        previousMessageCount,
      },
      afterJsonb: {
        queue: normalizedQueue,
        purged: true,
        remainingMessageCount: 0,
      },
      correlationId,
      ipAddress: req.ip,
    });

    return createApiResponse(
      {
        queue: normalizedQueue,
        purged: true,
        previousMessageCount,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  @Post('dlq/:queue/seed-test')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async seedTestDlqMessage(
    @Param('queue') queue: string,
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);

    if (this.config.nodeEnv === 'production') {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'DLQ test seeding is strictly disabled in production environments.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }

    this.assertSuperAdminWithMfa(user, correlationId);
    const normalizedQueue = this.assertValidDlqName(queue, correlationId);

    const msgCorrelationId = asStr(body?.correlationId) || correlationId || crypto.randomUUID();
    const retryCount = asNum(body?.retryCount, 3);
    const failureReason =
      asStr(body?.failureReason) || 'SIMULATED_TRANSIENT_FAILURE_AFTER_3_RETRIES';

    const eventPayload =
      body?.payload && typeof body.payload === 'object'
        ? body.payload
        : {
            eventId: crypto.randomUUID(),
            queue: normalizedQueue,
            originQueue: normalizedQueue.replace(/\.dlq$/, ''),
            correlationId: msgCorrelationId,
            failureReason,
            seededBy: user.email,
            seededAt: new Date().toISOString(),
          };

    const publishResp = await this.rabbitRequest<Record<string, unknown>>(
      'POST',
      '/api/exchanges/%2F/amq.default/publish',
      {
        properties: {
          delivery_mode: 2,
          content_type: 'application/json',
          message_id: crypto.randomUUID(),
          correlation_id: msgCorrelationId,
          timestamp: Math.floor(Date.now() / 1000),
          headers: {
            'x-correlation-id': msgCorrelationId,
            'x-retry-count': retryCount,
            'x-failure-reason': failureReason,
            'x-seeded-by': user.sub,
          },
        },
        routing_key: normalizedQueue,
        payload: JSON.stringify(eventPayload),
        payload_encoding: 'string',
      },
      correlationId,
      parentTraceparent,
    );

    return createApiResponse(
      {
        queue: normalizedQueue,
        seeded: true,
        routed: Boolean(publishResp?.routed ?? true),
        correlationId: msgCorrelationId,
        retryCount,
        failureReason,
        payload: eventPayload,
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  // ============================================================================
  // 3. Commerce & AI Ops Telemetry Funnel Aggregator
  // ============================================================================

  @Get('ai-funnel')
  @RequireAnyPermission(
    Permission.ADMIN_AUDIT_READ,
    Permission.TRYON_SIGNALS_READ,
    Permission.INVENTORY_STOCK_READ,
  )
  async getAiFunnel(@Req() req: Request): Promise<ApiResponse<Record<string, unknown>>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const parentTraceparent = getOrCreateTraceparent(req.headers as HeaderBag);

    const [
      tryonRes,
      ordersRes,
      paymentsRes,
      inventoryRes,
      copilotRes,
      reviewsRes,
      ollamaProbe,
    ] = await Promise.all([
      this.fetchJsonGraceful(
        `${this.config.upstreams.aiTryOnUrl}/v1/tryon/ops/metrics`,
        correlationId,
        parentTraceparent,
      ),
      this.fetchJsonGraceful(
        `${this.config.upstreams.orderRmaUrl}/v1/admin/orders/ops-metrics`,
        correlationId,
        parentTraceparent,
      ),
      this.fetchJsonGraceful(
        `${this.config.upstreams.paymentPromoUrl}/v1/payments/ops/metrics`,
        correlationId,
        parentTraceparent,
      ),
      this.fetchJsonGraceful(
        `${this.config.upstreams.inventoryUrl}/v1/inventory/ops/summary`,
        correlationId,
        parentTraceparent,
      ),
      this.fetchJsonGraceful(
        `${this.config.upstreams.mcpCopilotUrl}/v1/copilot/ops/metrics`,
        correlationId,
        parentTraceparent,
      ),
      this.fetchJsonGraceful(
        `${this.config.upstreams.notifyReviewUrl}/v1/reviews/ops/summary`,
        correlationId,
        parentTraceparent,
      ),
      this.probeOllamaEngine(correlationId, parentTraceparent),
    ]);

    const t = tryonRes.data;
    const o = ordersRes.data;
    const p = paymentsRes.data;
    const inv = inventoryRes.data;
    const cp = copilotRes.data;
    const rev = reviewsRes.data;

    const totalSessions = asNum(t.totalSessions, 0);
    const completedSessions = asNum(t.completedSessions, 0);
    const failedSessions = asNum(t.failedSessions, 0);
    const mockCount = asNum(t.mockCount, 0);
    const falCount = asNum(t.falCount, 0);
    const cacheHitCount = asNum(t.cacheHitCount, 0);
    const demandEventsCount = asNum(t.demandEventsCount, 0);
    const addToCartAfterTryonCount = asNum(t.addToCartAfterTryonCount, 0);
    const estimatedApiCostUsd = asNum(t.estimatedApiCostUsd, 0);
    const estimatedSavingsUsd = asNum(t.estimatedSavingsUsd, 0);
    const activeUnpurgedImagesCount = asNum(t.activeUnpurgedImagesCount, 0);

    const cacheHitSavingsPct =
      t.cacheHitRatePct !== undefined
        ? Number(asNum(t.cacheHitRatePct, 0).toFixed(2))
        : completedSessions > 0
          ? Number(((cacheHitCount / completedSessions) * 100).toFixed(2))
          : 0;

    const totalOrders = asNum(o.totalOrders, 0);
    const confirmedPaidOrders = asNum(o.confirmedPaidOrders, 0);
    const deliveredOrders = asNum(o.deliveredOrders, 0);
    const latePaymentAlertsCount = asNum(o.latePaymentAlertsCount, 0);
    const totalRevenueVnd = asNum(o.totalRevenueVnd, 0);
    const totalRmaCount = asNum(o.totalRmaCount, 0);
    const overallSizeExchangeRatePct = asNum(o.sizeExchangeRatePct, 0);

    const succeededCharges = asNum(p.succeededCharges, 0);
    const totalPaidVnd = asNum(p.totalPaidVnd, 0);
    const totalRefundedVnd = asNum(p.totalRefundedVnd, 0);
    const paidOrders = Math.max(confirmedPaidOrders, succeededCharges);

    const rawAiProvider = asStr(cp.aiProvider);
    const aiProvider: 'ollama' | 'rule_fallback' =
      rawAiProvider === 'rule_fallback'
        ? 'rule_fallback'
        : rawAiProvider === 'ollama' || ollamaProbe.reachable
          ? 'ollama'
          : 'rule_fallback';
    const activeMainModel =
      asStr(cp.modelUsed ?? cp.activeMainModel) || this.config.ollamaMainModel;
    const activeFastModel =
      asStr(cp.activeFastModel) || this.config.ollamaFastModel;
    const activeEmbedModel =
      asStr(cp.embedModel ?? cp.activeEmbedModel) || this.config.ollamaEmbedModel;
    const embedDim = asNum(cp.embedDim, this.config.ollamaEmbedDim);
    const avgTokensPerSec = Number(
      asNum(cp.tokensPerSec ?? cp.avgTokensPerSec, 0).toFixed(2),
    );
    const totalPromptTokens = asNum(cp.promptEvalCount ?? cp.totalPromptTokens, 0);
    const totalEvalTokens = asNum(cp.evalCount ?? cp.totalCompletionTokens, 0);
    const fallbackMode =
      cp.fallbackModeUsed !== undefined
        ? Boolean(cp.fallbackModeUsed)
        : !ollamaProbe.reachable;

    // 100% Local Ollama inference has $0 API cost (0₫ / Offline Privacy)
    const localInferenceCostUsd = 0;
    const estimatedGeminiCostUsd = 0;
    const totalAiCostUsd = estimatedApiCostUsd + localInferenceCostUsd;
    const estimatedAiCostPerOrderUsd =
      paidOrders > 0
        ? Number((totalAiCostUsd / paidOrders).toFixed(4))
        : Number(totalAiCostUsd.toFixed(4));

    const rawRmaByProduct = Array.isArray(o.rmaByProduct)
      ? (o.rmaByProduct as Array<Record<string, unknown>>)
      : [];

    const rmaSizeExchangeByProduct = rawRmaByProduct.map((row) => {
      const rmaCount = asNum(row.rmaCount ?? row.totalRmas, 0);
      const ratePct = asNum(row.sizeExchangeRatePct ?? row.returnRatePct, 0);
      return {
        productId: asStr(row.productId, 'unknown'),
        productName: asStr(row.productName, ''),
        totalOrdered: asNum(row.totalOrdered, 0),
        totalRmas: rmaCount,
        sizeExchangeCount: rmaCount,
        sizeExchangeRatePct: Number(ratePct.toFixed(2)),
        returnRatePct: Number(ratePct.toFixed(2)),
        dominantReasonCode: asStr(row.dominantReasonCode, 'SIZE_FIT_EXCHANGE'),
      };
    });

    const tryOnModalOpens = Math.max(totalSessions, demandEventsCount);
    const rackOrOutfitInteractions = Math.max(
      tryOnModalOpens,
      completedSessions + addToCartAfterTryonCount,
      1,
    );

    return createApiResponse(
      {
        generatedAt: new Date().toISOString(),
        estimatedAiCostPerOrderUsd,
        cacheHitSavingsPct,
        rmaSizeExchangeByProduct,
        localAi: {
          provider: aiProvider,
          badge: 'Local AI · Ollama Qwen 2.5 (0₫ / Offline Privacy)',
          reachable: ollamaProbe.reachable,
          baseUrl: ollamaProbe.baseUrl,
          activeMainModel,
          activeFastModel,
          activeEmbedModel,
          embedDim,
          loadedModels: ollamaProbe.loadedModels,
          avgTokensPerSec,
          tokensPerSec: avgTokensPerSec,
          totalPromptTokens,
          promptEvalCount: totalPromptTokens,
          totalEvalTokens,
          evalCount: totalEvalTokens,
          localInferenceCostUsd,
          costUsd: localInferenceCostUsd,
          fallbackMode,
        },
        funnel: {
          rackOrOutfitInteractions,
          tryOnModalOpens,
          tryOnCompleted: completedSessions,
          tryOnMockCount: mockCount,
          tryOnFalCount: falCount,
          tryOnCacheHitCount: cacheHitCount,
          addToCartAfterTryOn: addToCartAfterTryonCount,
          paidOrders,
        },
        tryon: {
          totalSessions,
          completedSessions,
          failedSessions,
          mockCount,
          falCount,
          cacheHitCount,
          cacheHitRatePct: cacheHitSavingsPct,
          cacheHitSavingsPct,
          estimatedSavingsUsd,
          estimatedApiCostUsd,
          estimatedTotalCostUsd: estimatedApiCostUsd,
          openModalSignals: tryOnModalOpens,
          addToCartAfterTryonCount,
          addToCartAfterTryOnSignals: addToCartAfterTryonCount,
          demandEventsCount,
          activeUnpurgedImagesCount,
        },
        orders: {
          totalOrders,
          confirmedPaidOrders,
          paidOrders,
          deliveredOrders,
          latePaymentAlertsCount,
          totalRevenueVnd,
          totalRmaCount,
          totalRmas: totalRmaCount,
          sizeExchangeRatePct: overallSizeExchangeRatePct,
        },
        payments: {
          totalChargeTransactions: asNum(p.totalChargeTransactions, 0),
          succeededCharges,
          refundedTransactions: asNum(p.refundedTransactions, 0),
          totalPaidVnd,
          totalRefundedVnd,
          processedWebhooksCount: asNum(p.processedWebhooksCount, 0),
          activePromotionsCount: asNum(p.activePromotionsCount, 0),
        },
        inventory: {
          totalSkus: asNum(inv.totalSkus, 0),
          lowStockCount: asNum(inv.lowStockCount, 0),
          outOfStockCount: asNum(inv.outOfStockCount, 0),
          activeReservationsCount: asNum(inv.activeReservationsCount, 0),
          totalAvailableQty: asNum(inv.totalAvailableQty, 0),
          totalReservedQty: asNum(inv.totalReservedQty, 0),
          totalCommittedQty: asNum(inv.totalCommittedQty, 0),
          totalDamagedQty: asNum(inv.totalDamagedQty, 0),
          pendingAiDraftPosCount: asNum(inv.pendingAiDraftPosCount, 0),
        },
        copilot: {
          aiProvider,
          modelUsed: activeMainModel,
          embedModel: activeEmbedModel,
          embedDim,
          tokensPerSec: avgTokensPerSec,
          promptEvalCount: totalPromptTokens,
          evalCount: totalEvalTokens,
          costUsd: localInferenceCostUsd,
          totalChatTurns: asNum(cp.totalChatTurns, 0),
          totalToolCalls: asNum(cp.totalToolCalls, 0),
          semanticCacheHits: asNum(cp.semanticCacheHits, 0),
          semanticCacheHitRatePct: asNum(cp.semanticCacheHitRatePct, 0),
          promptInjectionsBlocked: asNum(cp.promptInjectionsBlocked, 0),
          rbacDenials: asNum(cp.rbacDenials, 0),
          estimatedGeminiCostUsd,
          fallbackModeUsed: fallbackMode,
          averageLatencyMs: asNum(cp.averageLatencyMs, 0),
        },
        reviews: {
          totalVerifiedReviews: asNum(rev.totalVerifiedReviews, 0),
          averageRating: asNum(rev.averageRating, 0),
          notificationsSentCount: asNum(rev.notificationsSentCount, 0),
          totalNotificationLogs: asNum(rev.totalNotificationLogs, 0),
          productsCovered: asNum(rev.productsCovered, 0),
        },
        sources: {
          aiTryon: tryonRes.ok ? 'UP' : 'DEGRADED',
          orderRma: ordersRes.ok ? 'UP' : 'DEGRADED',
          paymentPromo: paymentsRes.ok ? 'UP' : 'DEGRADED',
          inventory: inventoryRes.ok ? 'UP' : 'DEGRADED',
          mcpCopilot: copilotRes.ok ? 'UP' : 'DEGRADED',
          notifyReview: reviewsRes.ok ? 'UP' : 'DEGRADED',
          ollama: ollamaProbe.reachable ? 'UP' : 'DOWN',
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }

  // ============================================================================
  // Internal Probe & RabbitMQ Helpers
  // ============================================================================

  private assertSuperAdminWithMfa(user: JwtAccessPayload, correlationId: string): void {
    if (!user.roles.includes(Role.SUPER_ADMIN) || user.mfaVerified !== true) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'DLQ mutation actions (replay/purge/seed) strictly require SUPER_ADMIN with verified 2FA.',
          { roles: user.roles, mfaVerified: user.mfaVerified === true },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertValidDlqName(queue: string, correlationId: string): string {
    const trimmed = (queue ?? '').trim();
    if (!VALID_DLQ_NAME_REGEX.test(trimmed)) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          `Invalid DLQ name "${queue}". Queue must end with ".dlq" and contain only alphanumeric, dot, dash, or underscore characters.`,
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.BAD_REQUEST,
      );
    }
    return trimmed;
  }

  private buildRabbitAuthHeader(): string {
    return `Basic ${Buffer.from(
      `${this.config.rabbitmqUser}:${this.config.rabbitmqPassword}`,
      'utf8',
    ).toString('base64')}`;
  }

  private normalizeDlqMessage(
    msg: RabbitGetMessageApiItem,
    queueName: string,
  ): Record<string, unknown> {
    const props = msg.properties ?? {};
    const headers =
      props.headers && typeof props.headers === 'object' ? props.headers : {};
    const rawDeath = Array.isArray(headers['x-death']) ? headers['x-death'][0] : null;
    const deathObj =
      rawDeath && typeof rawDeath === 'object' ? (rawDeath as Record<string, unknown>) : null;

    const correlationId =
      asStr(headers['x-correlation-id']) || asStr(props.correlation_id) || null;
    const retryCount = asNum(headers['x-retry-count'] ?? deathObj?.count, 0);
    const failureReason =
      asStr(headers['x-failure-reason']) || asStr(deathObj?.reason) || null;

    return {
      routingKey: asStr(msg.routing_key, queueName),
      exchange: asStr(msg.exchange, 'amq.default'),
      messageId: asStr(props.message_id) || null,
      correlationId,
      retryCount,
      failureReason,
      redelivered: Boolean(msg.redelivered),
      timestamp: props.timestamp ?? null,
      payload: tryParseJsonPayload(msg.payload),
    };
  }

  private async rabbitRequest<T>(
    method: string,
    pathname: string,
    body: unknown,
    correlationId: string,
    parentTraceparent: string,
  ): Promise<T> {
    const url = `${this.config.rabbitmqMgmtUrl}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3500);

    try {
      const headers = new Headers();
      headers.set('Authorization', this.buildRabbitAuthHeader());
      headers.set('Accept', 'application/json');
      headers.set(HTTP_HEADERS.CORRELATION_ID, correlationId);
      headers.set(TRACEPARENT_HEADER, createChildTraceparent(parentTraceparent));

      let encodedBody: string | undefined;
      if (body !== undefined && method !== 'GET' && method !== 'DELETE') {
        headers.set('Content-Type', 'application/json');
        encodedBody = JSON.stringify(body);
      }

      const response = await fetch(url, {
        method,
        headers,
        body: encodedBody,
        signal: controller.signal,
      });

      if (response.status === 204) {
        return {} as T;
      }

      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        parsed = text;
      }

      if (!response.ok) {
        const reason =
          parsed && typeof parsed === 'object' && 'reason' in parsed
            ? String((parsed as Record<string, unknown>).reason)
            : `RabbitMQ Management API returned HTTP ${response.status}`;
        throw new HttpException(
          createApiErrorResponse(
            response.status === 404 ? ErrorCode.NOT_FOUND : ErrorCode.DEPENDENCY_UNAVAILABLE,
            reason,
            { status: response.status, url },
            { correlationId, service: this.config.serviceName },
          ),
          response.status === 404 ? HttpStatus.NOT_FOUND : HttpStatus.BAD_GATEWAY,
        );
      }

      return parsed as T;
    } catch (error) {
      if (error instanceof HttpException) {
        throw error;
      }
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.DEPENDENCY_UNAVAILABLE,
          `RabbitMQ Management API unreachable at ${this.config.rabbitmqMgmtUrl}`,
          { err: error instanceof Error ? error.message : String(error) },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.SERVICE_UNAVAILABLE,
      );
    } finally {
      clearTimeout(timer);
    }
  }

  private async probeBffSelf(): Promise<ClusterNodeHealth> {
    const startedAt = Date.now();
    const redisAlive = await this.redis.ping();
    const latencyMs = Math.max(0, Date.now() - startedAt);
    return {
      name: 'bff',
      port: this.config.port,
      status: redisAlive ? 'UP' : 'DEGRADED',
      latencyMs,
      details: {
        service: this.config.serviceName,
        redisConnected: redisAlive,
        realtimeNamespaces: ['/realtime', '/'],
      },
    };
  }

  private async probeServiceNode(
    name: string,
    baseUrl: string,
    port: number,
    correlationId: string,
    parentTraceparent: string,
  ): Promise<ClusterNodeHealth> {
    const startedAt = Date.now();
    const readyProbe = await this.singleHttpProbe(
      `${baseUrl}/ready`,
      2000,
      correlationId,
      parentTraceparent,
    );

    if (readyProbe.ok) {
      const rec = unwrapDataRecord(readyProbe.body);
      const status = normalizeNodeStatus(rec.status ?? 'UP', rec.ready);
      const metadata =
        rec.metadata && typeof rec.metadata === 'object' && !Array.isArray(rec.metadata)
          ? (rec.metadata as Record<string, unknown>)
          : undefined;
      return {
        name,
        port,
        status,
        latencyMs: readyProbe.latencyMs,
        details: {
          endpoint: '/ready',
          httpStatus: readyProbe.httpStatus,
          ready: rec.ready ?? status !== 'DOWN',
          checksCount: Array.isArray(rec.checks) ? rec.checks.length : undefined,
          ...(metadata ? { metadata } : {}),
          ...(rec.ollamaReachable !== undefined
            ? { ollamaReachable: Boolean(rec.ollamaReachable) }
            : {}),
          ...(typeof rec.activeMainModel === 'string'
            ? { activeMainModel: rec.activeMainModel }
            : {}),
          ...(typeof rec.activeFastModel === 'string'
            ? { activeFastModel: rec.activeFastModel }
            : {}),
          ...(typeof rec.activeEmbedModel === 'string'
            ? { activeEmbedModel: rec.activeEmbedModel }
            : {}),
          ...(rec.embedDim !== undefined ? { embedDim: asNum(rec.embedDim, 768) } : {}),
          ...(rec.fallbackMode !== undefined
            ? { fallbackMode: Boolean(rec.fallbackMode) }
            : {}),
        },
      };
    }

    // Fallback to /health when /ready fails or returns non-200
    const healthProbe = await this.singleHttpProbe(
      `${baseUrl}/health`,
      1500,
      correlationId,
      parentTraceparent,
    );

    if (healthProbe.ok) {
      const rec = unwrapDataRecord(healthProbe.body);
      const status: NodeHealthStatus =
        readyProbe.httpStatus === 404 ? normalizeNodeStatus(rec.status ?? 'UP') : 'DEGRADED';
      return {
        name,
        port,
        status,
        latencyMs: healthProbe.latencyMs,
        details: {
          endpoint: '/health',
          httpStatus: healthProbe.httpStatus,
          readyHttpStatus: readyProbe.httpStatus,
        },
      };
    }

    return {
      name,
      port,
      status: 'DOWN',
      latencyMs: Math.max(0, Date.now() - startedAt),
      details: {
        error: healthProbe.error ?? readyProbe.error ?? 'Service unreachable',
        httpStatus: readyProbe.httpStatus,
      },
    };
  }

  private async probeRedisInfra(): Promise<ClusterNodeHealth> {
    const startedAt = Date.now();
    const alive = await this.redis.ping();
    return {
      name: 'Redis',
      port: extractPortFromUrl(this.config.redisUrl, 6379),
      status: alive ? 'UP' : 'DOWN',
      latencyMs: Math.max(0, Date.now() - startedAt),
      details: { connected: alive },
    };
  }

  private async probeHttpInfra(
    name: string,
    port: number,
    urls: string[],
    correlationId: string,
    parentTraceparent: string,
  ): Promise<ClusterNodeHealth> {
    const startedAt = Date.now();
    let lastError = 'Unreachable';
    for (const url of urls) {
      const probe = await this.singleHttpProbe(url, 2000, correlationId, parentTraceparent);
      if (probe.ok || (probe.httpStatus > 0 && probe.httpStatus < 500 && probe.httpStatus !== 404)) {
        return {
          name,
          port,
          status: 'UP',
          latencyMs: probe.latencyMs,
          details: { endpoint: url, httpStatus: probe.httpStatus },
        };
      }
      if (probe.error) {
        lastError = probe.error;
      }
    }
    return {
      name,
      port,
      status: 'DOWN',
      latencyMs: Math.max(0, Date.now() - startedAt),
      details: { error: lastError },
    };
  }

  private async probeOllamaEngine(
    correlationId: string,
    parentTraceparent: string,
  ): Promise<OllamaTagsProbeResult> {
    const baseUrl = this.config.ollamaBaseUrl;
    const port = extractPortFromUrl(baseUrl, 11434);
    const probe = await this.singleHttpProbe(
      `${baseUrl}/api/tags`,
      2000,
      correlationId,
      parentTraceparent,
    );

    if (!probe.ok) {
      return {
        reachable: false,
        port,
        baseUrl,
        latencyMs: probe.latencyMs,
        loadedModels: [],
        error: probe.error ?? `HTTP ${probe.httpStatus}`,
      };
    }

    const rec = unwrapDataRecord(probe.body);
    const rawModels = Array.isArray(rec.models)
      ? (rec.models as Array<Record<string, unknown>>)
      : [];
    const loadedModels = rawModels
      .map((item) => asStr(item?.name ?? item?.model).trim())
      .filter((name) => name.length > 0);

    return {
      reachable: true,
      port,
      baseUrl,
      latencyMs: probe.latencyMs,
      loadedModels,
    };
  }

  private async probeRabbitMqInfra(
    correlationId: string,
    parentTraceparent: string,
  ): Promise<ClusterNodeHealth> {
    const startedAt = Date.now();
    const port = extractPortFromUrl(this.config.rabbitmqMgmtUrl, 15672);
    const probe = await this.singleHttpProbe(
      `${this.config.rabbitmqMgmtUrl}/api/overview`,
      2000,
      correlationId,
      parentTraceparent,
      { Authorization: this.buildRabbitAuthHeader() },
    );

    if (probe.ok) {
      return {
        name: 'RabbitMQ Mgmt',
        port,
        status: 'UP',
        latencyMs: probe.latencyMs,
        details: { endpoint: '/api/overview', httpStatus: probe.httpStatus },
      };
    }

    return {
      name: 'RabbitMQ Mgmt',
      port,
      status: 'DOWN',
      latencyMs: Math.max(0, Date.now() - startedAt),
      details: {
        httpStatus: probe.httpStatus,
        error: probe.error ?? `HTTP ${probe.httpStatus}`,
      },
    };
  }

  private async singleHttpProbe(
    url: string,
    timeoutMs: number,
    correlationId: string,
    parentTraceparent: string,
    extraHeaders?: Record<string, string>,
  ): Promise<{ ok: boolean; httpStatus: number; latencyMs: number; body: unknown; error?: string }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const headers = new Headers();
      headers.set('Accept', 'application/json');
      headers.set(HTTP_HEADERS.CORRELATION_ID, correlationId);
      headers.set(TRACEPARENT_HEADER, createChildTraceparent(parentTraceparent));
      if (extraHeaders) {
        for (const [k, v] of Object.entries(extraHeaders)) {
          headers.set(k, v);
        }
      }

      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);
      const text = await res.text();
      let body: unknown = null;
      try {
        body = text ? (JSON.parse(text) as unknown) : null;
      } catch {
        body = text;
      }
      return {
        ok: res.ok,
        httpStatus: res.status,
        latencyMs,
        body,
      };
    } catch (error) {
      return {
        ok: false,
        httpStatus: 0,
        latencyMs: Math.max(0, Date.now() - startedAt),
        body: null,
        error: error instanceof Error ? error.message : String(error),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  private async fetchJsonGraceful(
    url: string,
    correlationId: string,
    parentTraceparent: string,
  ): Promise<{ ok: boolean; data: Record<string, unknown> }> {
    const probe = await this.singleHttpProbe(url, 2500, correlationId, parentTraceparent, {
      'x-internal-secret': this.config.internalServiceSecret,
      'x-actor-roles': Role.SUPER_ADMIN,
    });
    if (!probe.ok) {
      return { ok: false, data: {} };
    }
    return {
      ok: true,
      data: unwrapDataRecord(probe.body),
    };
  }
}
