import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqplib from 'amqplib';
import {
  createEventEnvelope,
  EVENT_NAMES,
  HTTP_HEADERS,
  RABBITMQ_EXCHANGES,
  type ProductFitStatsDto,
  type ReviewFitStatsAggregatedPayload,
} from '@atelier/contracts';
import { isTcpReachable } from '@atelier/db-client';
import {
  createChildTraceparent,
  createLogger,
  TRACEPARENT_HEADER,
} from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

function parseHostPort(rawUrl: string, defaultPort: number): { host: string; port: number } {
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number.parseInt(parsed.port, 10) : defaultPort,
    };
  } catch {
    return { host: '127.0.0.1', port: defaultPort };
  }
}

@Injectable()
export class ReviewEventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:events`);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN)
    private readonly config: NotifyReviewConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.tryConnect();
  }

  async onModuleDestroy(): Promise<void> {
    const ch = this.channel;
    const conn = this.connection;
    this.channel = null;
    this.connection = null;

    if (ch) {
      await ch.close().catch(() => undefined);
    }
    if (conn) {
      await conn.close().catch(() => undefined);
    }
  }

  public isConnected(): boolean {
    return this.channel !== null && this.connection !== null;
  }

  private async tryConnect(): Promise<AmqpChannel | null> {
    if (this.channel) {
      return this.channel;
    }

    const { host, port } = parseHostPort(this.config.infra.rabbitmqUrl, 5672);
    const reachable = await isTcpReachable(host, port, 750);
    if (!reachable) {
      this.logger.warn(
        { host, port, exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC },
        'RabbitMQ is offline (local harness mode); review.fit_stats.aggregated publishing will skip gracefully',
      );
      return null;
    }

    try {
      const conn = await amqplib.connect(this.config.infra.rabbitmqUrl, { timeout: 2500 });
      conn.on('error', (err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'RabbitMQ connection error in notify-review',
        );
        this.channel = null;
        this.connection = null;
      });
      conn.on('close', () => {
        this.channel = null;
        this.connection = null;
      });

      const ch = await conn.createChannel();
      ch.on('error', () => {
        this.channel = null;
      });
      ch.on('close', () => {
        this.channel = null;
      });

      await ch.assertExchange(RABBITMQ_EXCHANGES.DOMAIN_TOPIC, 'topic', { durable: true });

      this.connection = conn;
      this.channel = ch;
      this.logger.info(
        { host, port, exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC },
        'Connected to RabbitMQ domain topic exchange',
      );
      return ch;
    } catch (error: unknown) {
      this.logger.warn(
        {
          host,
          port,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed to connect to RabbitMQ (non-fatal; continuing without broker)',
      );
      this.channel = null;
      this.connection = null;
      return null;
    }
  }

  /**
   * Publishes `review.fit_stats.aggregated` on RabbitMQ (non-fatal if offline)
   * AND dispatches a non-blocking HTTP POST to `catalog-lookbook` so fit stats
   * stay synchronized even in local harness mode without RabbitMQ.
   */
  public dispatchFitStatsUpdated(
    fitStats: ProductFitStatsDto,
    correlationId: string,
    traceparent?: string,
  ): void {
    const childTraceparent = createChildTraceparent(traceparent);

    void this.publishToRabbitMq(fitStats, correlationId, childTraceparent).catch(
      (error: unknown) => {
        this.logger.warn(
          {
            productId: fitStats.productId,
            correlationId,
            traceparent: childTraceparent,
            err: error instanceof Error ? error.message : String(error),
          },
          'Non-fatal RabbitMQ dispatch error for review.fit_stats.aggregated',
        );
      },
    );

    void this.notifyCatalogService(fitStats, correlationId, childTraceparent).catch(
      (error: unknown) => {
        this.logger.warn(
          {
            productId: fitStats.productId,
            correlationId,
            traceparent: childTraceparent,
            err: error instanceof Error ? error.message : String(error),
          },
          'Non-fatal HTTP catalog sync error for fit-stats-updated',
        );
      },
    );
  }

  private async publishToRabbitMq(
    fitStats: ProductFitStatsDto,
    correlationId: string,
    traceparent: string,
  ): Promise<boolean> {
    const payload: ReviewFitStatsAggregatedPayload = {
      productId: fitStats.productId,
      totalVerifiedReviews: fitStats.totalReviews,
      averageRating: fitStats.averageRating,
      fitDistribution: {
        runsSmallPct: fitStats.runsSmallPct,
        trueToSizePct: fitStats.trueToSizePct,
        runsLargePct: fitStats.runsLargePct,
      },
      aggregatedAt: new Date().toISOString(),
    };

    const envelope = createEventEnvelope<ReviewFitStatsAggregatedPayload>({
      eventName: EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED,
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey: `review.fit_stats.aggregated:${fitStats.productId}:${fitStats.totalReviews}`,
      payload,
    });

    const ch = await this.tryConnect();
    if (!ch) {
      this.logger.warn(
        {
          eventId: envelope.eventId,
          productId: fitStats.productId,
          correlationId,
          traceparent,
        },
        'RabbitMQ unavailable — skipped publishing review.fit_stats.aggregated',
      );
      return false;
    }

    try {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      ch.publish(
        RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
        EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED,
        body,
        {
          persistent: true,
          contentType: 'application/json',
          messageId: envelope.eventId,
          correlationId,
          headers: {
            [TRACEPARENT_HEADER]: traceparent,
            'x-correlation-id': correlationId,
          },
          timestamp: Date.now(),
        },
      );
      this.logger.info(
        {
          eventId: envelope.eventId,
          productId: fitStats.productId,
          totalReviews: fitStats.totalReviews,
          runsSmallPct: fitStats.runsSmallPct,
          correlationId,
          traceparent,
        },
        'Published review.fit_stats.aggregated domain event',
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          productId: fitStats.productId,
          correlationId,
          traceparent,
          err: error instanceof Error ? error.message : String(error),
        },
        'Non-fatal failure publishing review.fit_stats.aggregated event',
      );
      return false;
    }
  }

  private async notifyCatalogService(
    fitStats: ProductFitStatsDto,
    correlationId: string,
    traceparent: string,
  ): Promise<boolean> {
    const endpoint = `${this.config.infra.catalogServiceUrl}/v1/catalog/internal/fit-stats-updated`;
    const { host, port } = parseHostPort(endpoint, 4002);
    const reachable = await isTcpReachable(host, port, 400);
    if (!reachable) {
      return false;
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    try {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          [HTTP_HEADERS.CORRELATION_ID]: correlationId,
          [TRACEPARENT_HEADER]: traceparent,
        },
        body: JSON.stringify({
          productId: fitStats.productId,
          fitStats,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        this.logger.warn(
          {
            endpoint,
            status: response.status,
            productId: fitStats.productId,
            correlationId,
          },
          'Catalog internal fit-stats-updated returned non-2xx status (non-fatal)',
        );
        return false;
      }

      this.logger.info(
        {
          endpoint,
          productId: fitStats.productId,
          totalReviews: fitStats.totalReviews,
          runsSmallPct: fitStats.runsSmallPct,
          correlationId,
        },
        'Synced fit stats to catalog-lookbook internal endpoint',
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          endpoint,
          productId: fitStats.productId,
          correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Non-fatal error calling catalog-lookbook fit-stats-updated',
      );
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}
