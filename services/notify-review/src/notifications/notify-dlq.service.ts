import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqplib from 'amqplib';
import { isTcpReachable } from '@atelier/db-client';
import { createLogger, TRACEPARENT_HEADER } from '@atelier/observability';
import {
  NOTIFY_CONFIG_TOKEN,
  SERVICE_NAME,
  type NotifyReviewConfig,
} from '../config/env';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

export const NOTIFY_DLX_EXCHANGE = 'atelier.notify.dlx';
export const NOTIFY_DLQ_QUEUE = 'atelier.notify.dlq';
export const NOTIFY_DLQ_ROUTING_KEY = 'atelier.notify.dlq';
export const NOTIFY_REPLAY_QUEUE = 'atelier.notify';

export interface NotifyDlqEnvelope {
  eventId: string;
  notificationLogId: string | null;
  channel: 'ZALO_ZNS' | 'EMAIL' | 'SMS';
  recipient: string;
  templateCode: string;
  templateId: string;
  subject: string;
  formattedPayload: Record<string, unknown>;
  originalPayload: Record<string, unknown>;
  errorCode: string | null;
  errorMessage: string | null;
  retryCount: number;
  deliveryMode: string;
  correlationId: string;
  traceparent?: string;
  failedAt: string;
}

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
export class NotifyDlqService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:notify-dlq`);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private topologyDeclared = false;

  constructor(
    @Inject(NOTIFY_CONFIG_TOKEN)
    private readonly config: NotifyReviewConfig,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.ensureChannel();
  }

  async onModuleDestroy(): Promise<void> {
    const ch = this.channel;
    const conn = this.connection;
    this.channel = null;
    this.connection = null;
    this.topologyDeclared = false;

    if (ch) {
      await ch.close().catch(() => undefined);
    }
    if (conn) {
      await conn.close().catch(() => undefined);
    }
  }

  public isConnected(): boolean {
    return this.channel !== null && this.connection !== null && this.topologyDeclared;
  }

  public getTopology(): {
    dlxExchange: string;
    dlqQueue: string;
    dlqRoutingKey: string;
    replayQueue: string;
    connected: boolean;
  } {
    return {
      dlxExchange: NOTIFY_DLX_EXCHANGE,
      dlqQueue: NOTIFY_DLQ_QUEUE,
      dlqRoutingKey: NOTIFY_DLQ_ROUTING_KEY,
      replayQueue: NOTIFY_REPLAY_QUEUE,
      connected: this.isConnected(),
    };
  }

  private async ensureChannel(): Promise<AmqpChannel | null> {
    if (this.channel && this.topologyDeclared) {
      return this.channel;
    }

    const { host, port } = parseHostPort(this.config.infra.rabbitmqUrl, 5672);
    const reachable = await isTcpReachable(host, port, 750);
    if (!reachable) {
      this.logger.warn(
        { host, port, dlqQueue: NOTIFY_DLQ_QUEUE },
        'RabbitMQ is offline — atelier.notify.dlq topology will be initialized on reconnect',
      );
      return null;
    }

    try {
      const conn = await amqplib.connect(this.config.infra.rabbitmqUrl, { timeout: 2500 });
      conn.on('error', (err: unknown) => {
        this.logger.warn(
          { err: err instanceof Error ? err.message : String(err) },
          'RabbitMQ DLQ connection error in notify-review',
        );
        this.channel = null;
        this.connection = null;
        this.topologyDeclared = false;
      });
      conn.on('close', () => {
        this.channel = null;
        this.connection = null;
        this.topologyDeclared = false;
      });

      const ch = await conn.createChannel();
      ch.on('error', () => {
        this.channel = null;
        this.topologyDeclared = false;
      });
      ch.on('close', () => {
        this.channel = null;
        this.topologyDeclared = false;
      });

      // Declare durable DLX + DLQ (`atelier.notify.dlx` -> `atelier.notify.dlq`)
      await ch.assertExchange(NOTIFY_DLX_EXCHANGE, 'direct', { durable: true });
      await ch.assertQueue(NOTIFY_DLQ_QUEUE, { durable: true });
      await ch.bindQueue(NOTIFY_DLQ_QUEUE, NOTIFY_DLX_EXCHANGE, NOTIFY_DLQ_ROUTING_KEY);
      await ch.bindQueue(NOTIFY_DLQ_QUEUE, NOTIFY_DLX_EXCHANGE, 'notify.zns.failed');

      // Also declare replay target queue (`atelier.notify`) so Admin Ops DLQ Replay routes cleanly
      try {
        await ch.assertQueue(NOTIFY_REPLAY_QUEUE, {
          durable: true,
          arguments: {
            'x-dead-letter-exchange': NOTIFY_DLX_EXCHANGE,
            'x-dead-letter-routing-key': NOTIFY_DLQ_ROUTING_KEY,
          },
        });
      } catch (replayErr: unknown) {
        this.logger.warn(
          { err: replayErr instanceof Error ? replayErr.message : String(replayErr) },
          'Replay queue atelier.notify already exists with different arguments; keeping DLQ channel active',
        );
        // Re-open channel if RabbitMQ closed it on precondition failed
        const recoveryCh = await conn.createChannel();
        recoveryCh.on('error', () => {
          this.channel = null;
          this.topologyDeclared = false;
        });
        recoveryCh.on('close', () => {
          this.channel = null;
          this.topologyDeclared = false;
        });
        await recoveryCh.assertExchange(NOTIFY_DLX_EXCHANGE, 'direct', { durable: true });
        await recoveryCh.assertQueue(NOTIFY_DLQ_QUEUE, { durable: true });
        await recoveryCh.bindQueue(NOTIFY_DLQ_QUEUE, NOTIFY_DLX_EXCHANGE, NOTIFY_DLQ_ROUTING_KEY);
        this.connection = conn;
        this.channel = recoveryCh;
        this.topologyDeclared = true;
        return recoveryCh;
      }

      this.connection = conn;
      this.channel = ch;
      this.topologyDeclared = true;

      this.logger.info(
        {
          host,
          port,
          dlxExchange: NOTIFY_DLX_EXCHANGE,
          dlqQueue: NOTIFY_DLQ_QUEUE,
          replayQueue: NOTIFY_REPLAY_QUEUE,
        },
        'Declared durable RabbitMQ notification DLQ topology (atelier.notify.dlq)',
      );
      return ch;
    } catch (error: unknown) {
      this.logger.warn(
        { host, port, err: error instanceof Error ? error.message : String(error) },
        'Failed to initialize atelier.notify.dlq RabbitMQ channel (non-fatal)',
      );
      this.channel = null;
      this.connection = null;
      this.topologyDeclared = false;
      return null;
    }
  }

  private async publishViaRabbitMgmtHttp(envelope: NotifyDlqEnvelope, failureReason: string): Promise<boolean> {
    const mgmtUrl = (process.env.RABBITMQ_MGMT_URL?.trim() || 'http://127.0.0.1:15672').replace(/\/+$/, '');
    const user = process.env.RABBITMQ_USER?.trim() || process.env.RABBITMQ_DEFAULT_USER?.trim() || 'atelier_mq';
    const pass = process.env.RABBITMQ_PASSWORD?.trim() || process.env.RABBITMQ_DEFAULT_PASS?.trim() || 'Atelier_Mq2026!';
    const authHeader = `Basic ${Buffer.from(`${user}:${pass}`, 'utf8').toString('base64')}`;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await fetch(
        `${mgmtUrl}/api/exchanges/%2F/${encodeURIComponent(NOTIFY_DLX_EXCHANGE)}/publish`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: authHeader,
            'x-correlation-id': envelope.correlationId,
          },
          body: JSON.stringify({
            routing_key: NOTIFY_DLQ_ROUTING_KEY,
            payload: JSON.stringify(envelope),
            payload_encoding: 'string',
            properties: {
              delivery_mode: 2,
              content_type: 'application/json',
              message_id: envelope.notificationLogId ?? envelope.eventId,
              correlation_id: envelope.correlationId,
              timestamp: Math.floor(Date.now() / 1000),
              headers: {
                'x-correlation-id': envelope.correlationId,
                ...(envelope.traceparent ? { [TRACEPARENT_HEADER]: envelope.traceparent } : {}),
                'x-retry-count': envelope.retryCount,
                'x-failure-reason': failureReason || 'ZALO_ZNS_DELIVERY_FAILED',
                'x-channel': envelope.channel,
                'x-event-id': envelope.eventId,
                'x-origin-queue': NOTIFY_REPLAY_QUEUE,
              },
            },
          }),
          signal: controller.signal,
        },
      );
      if (res.ok) {
        this.logger.warn(
          {
            eventId: envelope.eventId,
            dlqQueue: NOTIFY_DLQ_QUEUE,
            transport: 'rabbitmq-mgmt-http-fallback',
            retryCount: envelope.retryCount,
            errorCode: envelope.errorCode,
            correlationId: envelope.correlationId,
          },
          'Published failed Zalo ZNS message to atelier.notify.dlq via RabbitMQ Management HTTP fallback',
        );
        return true;
      }
      return false;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  public async publishFailedZnsToDlq(envelope: NotifyDlqEnvelope): Promise<boolean> {
    const failureReason = [envelope.errorCode, envelope.errorMessage]
      .filter(Boolean)
      .join(': ')
      .slice(0, 300);

    const ch = await this.ensureChannel();
    if (!ch) {
      const mgmtPublished = await this.publishViaRabbitMgmtHttp(envelope, failureReason);
      if (mgmtPublished) {
        return true;
      }
      this.logger.warn(
        { eventId: envelope.eventId, correlationId: envelope.correlationId },
        'RabbitMQ AMQP & Management HTTP unavailable — unable to publish failed ZNS notification to atelier.notify.dlq',
      );
      return false;
    }

    try {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');

      ch.publish(NOTIFY_DLX_EXCHANGE, NOTIFY_DLQ_ROUTING_KEY, body, {
        persistent: true,
        deliveryMode: 2,
        contentType: 'application/json',
        messageId: envelope.notificationLogId ?? envelope.eventId,
        correlationId: envelope.correlationId,
        timestamp: Date.now(),
        headers: {
          'x-correlation-id': envelope.correlationId,
          ...(envelope.traceparent ? { [TRACEPARENT_HEADER]: envelope.traceparent } : {}),
          'x-retry-count': envelope.retryCount,
          'x-failure-reason': failureReason || 'ZALO_ZNS_DELIVERY_FAILED',
          'x-channel': envelope.channel,
          'x-event-id': envelope.eventId,
          'x-origin-queue': NOTIFY_REPLAY_QUEUE,
        },
      });

      this.logger.warn(
        {
          eventId: envelope.eventId,
          dlqQueue: NOTIFY_DLQ_QUEUE,
          retryCount: envelope.retryCount,
          errorCode: envelope.errorCode,
          correlationId: envelope.correlationId,
        },
        'Published failed Zalo ZNS message to RabbitMQ Dead-Letter Queue (atelier.notify.dlq)',
      );
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        {
          eventId: envelope.eventId,
          correlationId: envelope.correlationId,
          err: error instanceof Error ? error.message : String(error),
        },
        'Failed publishing ZNS failure envelope to atelier.notify.dlq',
      );
      this.channel = null;
      this.topologyDeclared = false;
      return false;
    }
  }
}
