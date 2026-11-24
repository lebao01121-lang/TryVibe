import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import * as amqplib from 'amqplib';
import {
  createEventEnvelope,
  EVENT_NAMES,
  RABBITMQ_EXCHANGES,
  type PaymentLateDetectedPayload,
  type PaymentSucceededPayload,
} from '@atelier/contracts';
import { isTcpReachable } from '@atelier/db-client';
import { createLogger } from '@atelier/observability';
import {
  PAYMENT_CONFIG_TOKEN,
  SERVICE_NAME,
  type PaymentPromoConfig,
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
export class PaymentEventPublisherService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(SERVICE_NAME);
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;

  constructor(@Inject(PAYMENT_CONFIG_TOKEN) private readonly config: PaymentPromoConfig) {}

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
        'RabbitMQ offline (local harness mode); payment domain events will skip broker gracefully',
      );
      return null;
    }

    try {
      const conn = await amqplib.connect(this.config.infra.rabbitmqUrl, { timeout: 2500 });
      conn.on('error', () => {
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
      return ch;
    } catch (error: unknown) {
      this.logger.warn(
        { host, port, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal failure connecting payment-promo to RabbitMQ',
      );
      this.channel = null;
      this.connection = null;
      return null;
    }
  }

  async publishPaymentSucceeded(
    payload: PaymentSucceededPayload,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<boolean> {
    const envelope = createEventEnvelope<PaymentSucceededPayload>({
      eventName: EVENT_NAMES.PAYMENT_SUCCEEDED,
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey: idempotencyKey ?? `payment.succeeded:${payload.paymentId}`,
      payload,
    });
    return this.publishRaw(EVENT_NAMES.PAYMENT_SUCCEEDED, envelope, correlationId);
  }

  async publishPaymentLateDetected(
    payload: PaymentLateDetectedPayload,
    correlationId: string,
  ): Promise<boolean> {
    const envelope = createEventEnvelope<PaymentLateDetectedPayload>({
      eventName: EVENT_NAMES.PAYMENT_LATE_DETECTED,
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey: `payment.late.detected:${payload.paymentId}`,
      payload,
    });
    return this.publishRaw(EVENT_NAMES.PAYMENT_LATE_DETECTED, envelope, correlationId);
  }

  private async publishRaw(
    routingKey: string,
    envelope: { eventId: string },
    correlationId: string,
  ): Promise<boolean> {
    const ch = await this.tryConnect();
    if (!ch) {
      return false;
    }
    try {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      ch.publish(RABBITMQ_EXCHANGES.DOMAIN_TOPIC, routingKey, body, {
        persistent: true,
        contentType: 'application/json',
        messageId: envelope.eventId,
        correlationId,
        timestamp: Date.now(),
      });
      return true;
    } catch (error: unknown) {
      this.logger.warn(
        { routingKey, err: error instanceof Error ? error.message : String(error) },
        'Non-fatal failure publishing payment event to RabbitMQ',
      );
      return false;
    }
  }
}
