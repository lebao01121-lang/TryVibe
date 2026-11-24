import { Inject, Injectable, OnModuleDestroy } from '@nestjs/common';
import amqplib from 'amqplib';
import { RABBITMQ_EXCHANGES } from '@atelier/contracts';
import { createLogger } from '@atelier/observability';
import { INVENTORY_CONFIG_TOKEN, type InventoryConfig } from '../config/env';

type AmqpConnection = Awaited<ReturnType<typeof amqplib.connect>>;
type AmqpChannel = Awaited<ReturnType<AmqpConnection['createChannel']>>;

@Injectable()
export class InventoryRabbitMqService implements OnModuleDestroy {
  private readonly logger = createLogger('@atelier/inventory:rabbitmq');
  private connection: AmqpConnection | null = null;
  private channel: AmqpChannel | null = null;
  private lastFailedAttemptAt = 0;

  constructor(@Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig) {}

  async onModuleDestroy(): Promise<void> {
    try {
      if (this.channel) {
        await this.channel.close();
      }
    } catch {
      // Ignore close error
    } finally {
      this.channel = null;
    }

    try {
      if (this.connection) {
        await this.connection.close();
      }
    } catch {
      // Ignore close error
    } finally {
      this.connection = null;
    }
  }

  isConnected(): boolean {
    return this.channel !== null;
  }

  private async ensureChannel(): Promise<AmqpChannel | null> {
    if (this.channel) {
      return this.channel;
    }
    if (!this.config.rabbitmq.configured) {
      return null;
    }
    // Avoid hammering an offline broker during local dev harness runs
    if (Date.now() - this.lastFailedAttemptAt < 15_000) {
      return null;
    }

    try {
      const conn = await amqplib.connect(this.config.rabbitmq.url, { timeout: 1500 });
      conn.on('error', () => {
        this.channel = null;
        this.connection = null;
      });
      conn.on('close', () => {
        this.channel = null;
        this.connection = null;
      });
      const ch = await conn.createChannel();
      await ch.assertExchange(RABBITMQ_EXCHANGES.DOMAIN_TOPIC, 'topic', { durable: true });
      this.connection = conn;
      this.channel = ch;
      return ch;
    } catch {
      this.lastFailedAttemptAt = Date.now();
      return null;
    }
  }

  async publishDomainEvent(routingKey: string, envelope: Record<string, unknown>): Promise<boolean> {
    const ch = await this.ensureChannel();
    if (!ch) {
      return false;
    }
    try {
      const body = Buffer.from(JSON.stringify(envelope), 'utf8');
      return ch.publish(RABBITMQ_EXCHANGES.DOMAIN_TOPIC, routingKey, body, {
        persistent: true,
        contentType: 'application/json',
      });
    } catch (error) {
      this.logger.warn({ err: error, routingKey }, 'Failed to publish RabbitMQ domain event');
      this.channel = null;
      return false;
    }
  }
}
