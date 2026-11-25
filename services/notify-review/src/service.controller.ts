import { Controller, Get, Headers, Inject } from '@nestjs/common';
import {
  createApiResponse,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type ApiResponse,
  type DependencyCheck,
} from '@atelier/contracts';
import { isTcpReachable } from '@atelier/db-client';
import {
  buildHealthPayload,
  buildReadinessPayload,
  getOrCreateCorrelationId,
  type HeaderBag,
  type StandardHealthPayload,
  type StandardReadinessPayload,
} from '@atelier/observability';
import { NOTIFY_CONFIG_TOKEN, type NotifyReviewConfig } from './config/env';
import { NotifyDbService } from './db/notify-db.service';
import { ReviewEventPublisherService } from './messaging/review-event-publisher.service';
import { NotifyDlqService } from './notifications/notify-dlq.service';
import { ZaloZnsClient } from './notifications/zalo-zns.client';
import { ReviewsService } from './reviews/reviews.service';

@Controller()
export class NotifyReviewController {
  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN) private readonly config: NotifyReviewConfig,
    @Inject(NotifyDbService) private readonly db: NotifyDbService,
    @Inject(ReviewEventPublisherService)
    private readonly eventPublisher: ReviewEventPublisherService,
    @Inject(ZaloZnsClient) private readonly zaloZnsClient: ZaloZnsClient,
    @Inject(NotifyDlqService) private readonly notifyDlq: NotifyDlqService,
    @Inject(ReviewsService) private readonly reviewsService: ReviewsService,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    const seedSummary = this.reviewsService.getLastSeedSummary();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      version: '3.0.0',
      startedAtMs,
      metadata: {
        boundedContext: this.config.boundedContext,
        isolatedDatabase: this.config.database.targetDatabase,
        dbMode: this.db.getMode(),
        seededReviews: seedSummary?.totalReviews ?? 0,
      },
    });
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();
    const mailpitProbeStart = Date.now();

    const normalizedSmtpHost = this.config.infra.smtpHost.trim().toLowerCase();
    const isLocalSmtpHost =
      normalizedSmtpHost === '127.0.0.1' ||
      normalizedSmtpHost === 'localhost' ||
      normalizedSmtpHost === '::1';
    const smtpProbeTimeoutMs = isLocalSmtpHost ? 400 : 2000;

    const [dbPing, mailpitReachable] = await Promise.all([
      this.db.ping(),
      isTcpReachable(
        this.config.infra.smtpHost,
        this.config.infra.smtpPort,
        smtpProbeTimeoutMs,
      ).catch(() => false),
    ]);
    const mailpitLatencyMs = Date.now() - mailpitProbeStart;

    const checks: DependencyCheck[] = [
      {
        name: 'isolated-notify-db',
        status: dbPing.ok ? 'up' : 'down',
        latencyMs: dbPing.latencyMs,
        detail: `${this.config.database.envVar} -> ${dbPing.detail}`,
      },
      {
        name: 'mailpit-smtp',
        status: mailpitReachable ? 'up' : 'skipped',
        latencyMs: mailpitLatencyMs,
        detail: mailpitReachable
          ? `Mailpit SMTP ${this.config.infra.smtpHost}:${this.config.infra.smtpPort} reachable`
          : `Mailpit SMTP ${this.config.infra.smtpHost}:${this.config.infra.smtpPort} unreachable (non-fatal)`,
      },
      {
        name: 'rabbitmq-event-bus',
        status: this.eventPublisher.isConnected() ? 'up' : 'skipped',
        detail: this.eventPublisher.isConnected()
          ? `Connected to ${RABBITMQ_EXCHANGES.DOMAIN_TOPIC}`
          : `Exchange ${RABBITMQ_EXCHANGES.DOMAIN_TOPIC} offline (HTTP catalog sync fallback active)`,
      },
      {
        name: 'rabbitmq-notify-dlq',
        status: this.notifyDlq.isConnected() ? 'up' : 'skipped',
        detail: this.notifyDlq.isConnected()
          ? 'Connected to atelier.notify.dlx -> atelier.notify.dlq'
          : 'atelier.notify.dlq offline (non-fatal local mode)',
      },
      {
        name: 'zalo-zns-adapter',
        status: 'up',
        detail: this.zaloZnsClient.isLiveConfigured()
          ? 'Zalo OA/ZNS LIVE mode active'
          : 'Zalo OA/ZNS LOCAL_SANDBOX_DRYRUN mode (no live credentials configured)',
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
        seedSummary: this.reviewsService.getLastSeedSummary(),
      },
    });
  }

  @Get('api/v1/notify/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'v3.1-ollama',
        ollamaNlp: {
          baseUrl: this.config.ollama.baseUrl,
          fastModel: this.config.ollama.fastModel,
          keepAlive: this.config.ollama.keepAlive,
          endpoint: 'POST /v1/reviews/analyze-sentiment',
        },
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          configured: this.config.database.configured,
          activeMode: this.db.getMode(),
        },
        aggregates: ['notification_logs', 'product_reviews'],
        seedSummary: this.reviewsService.getLastSeedSummary(),
        channels: ['ZALO_ZNS', 'EMAIL_SMTP_MAILPIT', 'SMS'],
        mailpit: {
          smtpHost: this.config.infra.smtpHost,
          smtpPort: this.config.infra.smtpPort,
          uiPort: this.config.infra.mailpitUiPort,
          from: this.config.infra.smtpFrom,
        },
        zaloZns: this.zaloZnsClient.getStatus(),
        dlqTopology: this.notifyDlq.getTopology(),
        integrations: {
          catalogFitStatsWebhook: `${this.config.infra.catalogServiceUrl}/v1/catalog/internal/fit-stats-updated`,
          orderDeliveredCheckUrl: `${this.config.infra.orderRmaServiceUrl}/internal/orders/delivered-check`,
        },
        internalEndpoints: [
          'POST /internal/notify/order-confirmed',
          'POST /internal/notify/order-packed',
          'POST /internal/notify/po-submitted',
          'POST /internal/notify/rma-rejected',
          'POST /internal/notify/zns',
        ],
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          connected: this.eventPublisher.isConnected(),
          publishes: [EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED],
          consumes: [
            EVENT_NAMES.ORDER_CREATED,
            EVENT_NAMES.PAYMENT_SUCCEEDED,
            EVENT_NAMES.PAYMENT_LATE_DETECTED,
            EVENT_NAMES.RMA_REQUESTED,
            EVENT_NAMES.RMA_QC_PASSED,
            EVENT_NAMES.PROCUREMENT_PO_SUBMITTED,
          ],
        },
      },
      {
        correlationId,
        service: this.config.serviceName,
      },
    );
  }
}
