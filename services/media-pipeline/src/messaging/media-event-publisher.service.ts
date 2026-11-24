import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqplib from 'amqplib';
import {
  createEventEnvelope,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type MediaAssetProcessedPayload,
} from '@atelier/contracts';
import { isTcpReachable } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  MEDIA_CONFIG_TOKEN,
  SERVICE_NAME,
  type MediaPipelineConfig,
} from '../config/env';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

function parseAmqpHostPort(rawUrl: string): { host: string; port: number } {
  try {
    const parsed = new URL(rawUrl);
    return {
      host: parsed.hostname || '127.0.0.1',
      port: parsed.port ? Number.parseInt(parsed.port, 10) : 5672,
    };
  } catch {
    return { host: '127.0.0.1', port: 5672 };
  }
}

@Injectable()
export class MediaEventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;

  constructor(@Inject(MEDIA_CONFIG_TOKEN) private readonly config: MediaPipelineConfig) {}

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

  isConnected(): boolean {
    return this.channel !== null && this.connection !== null;
  }

  private async tryConnect(): Promise<AmqpChannel | null> {
    if (this.channel) {
      return this.channel;
    }

    const { host, port } = parseAmqpHostPort(this.config.infra.rabbitmqUrl);
    const reachable = await isTcpReachable(host, port, 750);
    if (!reachable) {
      this.logger.warn(
        { host, port, exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC },
        'RabbitMQ is offline (local harness mode); media.asset.processed publishing will skip gracefully',
      );
      return null;
    }

    try {
      const conn = await amqplib.connect(this.config.infra.rabbitmqUrl, { timeout: 2500 });
      conn.on('error', (err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'RabbitMQ connection error in media-pipeline',
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

  async publishMediaAssetProcessed(
    payload: MediaAssetProcessedPayload,
    correlationId: string,
  ): Promise<boolean> {
    const envelope = createEventEnvelope<MediaAssetProcessedPayload>({
      eventName: EVENT_NAMES.MEDIA_ASSET_PROCESSED,
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey: `media.asset.processed:${payload.assetId}`,
      payload,
    });

    const ch = await this.tryConnect();
    if (!ch) {
      this.logger.warn(
        {
          eventId: envelope.eventId,
          eventName: envelope.eventName,
          assetId: payload.assetId,
          correlationId,
        },
        'RabbitMQ unavailable — skipped publishing media.asset.processed event',
      );
      return false;
    }

    try {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      ch.publish(RABBITMQ_EXCHANGES.DOMAIN_TOPIC, EVENT_NAMES.MEDIA_ASSET_PROCESSED, body, {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.eventId,
        correlationId,
        timestamp: Date.now(),
      });
      this.logger.info(
        {
          eventId: envelope.eventId,
          assetId: payload.assetId,
          bucket: payload.bucket,
          correlationId,
        },
        'Published media.asset.processed domain event',
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          assetId: payload.assetId,
          correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Non-fatal failure publishing media.asset.processed event',
      );
      return false;
    }
  }
}
