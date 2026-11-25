import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Portal, type DependencyCheck } from '@atelier/contracts';
import {
  buildHealthPayload,
  buildReadinessPayload,
  getPrometheusMetricsPayload,
  type StandardHealthPayload,
  type StandardReadinessPayload,
} from '@atelier/observability';
import { BffRedisService } from '../common/redis.service';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { RealtimeGateway } from '../realtime/realtime.gateway';

@Controller()
export class HealthController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(RealtimeGateway) private readonly realtimeGateway: RealtimeGateway,
  ) {}

  @Get('health')
  getHealth(): StandardHealthPayload {
    const startedAtMs = Date.now();
    const socketIoRedisAdapter = this.realtimeGateway.isRedisAdapterActive();
    return buildHealthPayload(this.config.serviceName, this.config.port, {
      version: '3.0.0',
      startedAtMs,
      metadata: {
        role: 'zero-trust-api-gateway-fashion-bff-socket-hub',
        portals: [Portal.STOREFRONT, Portal.ADMIN_PORTAL, Portal.PARTNER_PORTAL],
        realtimeNamespace: '/realtime',
        socketIoRedisAdapter,
        realtimeReplayBackend: this.redis.isConnected() ? 'redis' : 'memory-fallback',
      },
    });
  }

  @Get('metrics')
  async getMetrics(@Res() res: Response): Promise<void> {
    const payload = await getPrometheusMetricsPayload();
    res.setHeader('Content-Type', payload.contentType);
    res.setHeader('Cache-Control', 'no-store');
    res.status(200).send(payload.body);
  }

  @Get('ready')
  async getReadiness(): Promise<StandardReadinessPayload> {
    const startedAtMs = Date.now();

    const redisStart = Date.now();
    const redisAlive = await this.redis.ping();
    const redisLatencyMs = Math.max(0, Date.now() - redisStart);
    const socketIoRedisAdapter = this.realtimeGateway.isRedisAdapterActive();

    const mqProbe = await this.probeRabbitMqMgmt();

    const checks: DependencyCheck[] = [
      {
        name: 'bff-runtime',
        status: 'up',
        latencyMs: 0,
        detail: `Listening on port ${this.config.port} with ${this.config.corsAllowedOrigins.length} CORS origins`,
      },
      {
        name: 'realtime-socket-hub',
        status: 'up',
        latencyMs: 0,
        detail: socketIoRedisAdapter
          ? 'Socket.io namespaces /realtime and / active with @socket.io/redis-adapter & Redis 60s replay buffer'
          : 'Socket.io namespaces /realtime and / active (in-memory adapter fallback)',
      },
      {
        name: 'redis-cache-and-revocation',
        status: redisAlive ? 'up' : 'skipped',
        latencyMs: redisLatencyMs,
        detail: redisAlive
          ? 'Redis connected for Storefront Cache-Aside, rate-limiting, Socket.io replay & instant permissionVersion revocation'
          : 'Redis unreachable (degraded in-memory fallback mode)',
      },
      {
        name: 'rabbitmq-mgmt',
        status: mqProbe.ok ? 'up' : 'skipped',
        latencyMs: mqProbe.latencyMs,
        detail: mqProbe.ok
          ? `RabbitMQ Management API reachable at ${this.config.rabbitmqMgmtUrl}`
          : mqProbe.detail,
      },
    ];

    return buildReadinessPayload(this.config.serviceName, checks, {
      port: this.config.port,
      version: '3.0.0',
      startedAtMs,
      metadata: {
        phase: 'phase-6',
        vtonProvider: this.config.vtonProvider,
        socketIoRedisAdapter,
        realtimeReplayBackend: redisAlive ? 'redis' : 'memory-fallback',
        upstreamCount: Object.keys(this.config.upstreams).length,
      },
    });
  }

  private async probeRabbitMqMgmt(): Promise<{
    ok: boolean;
    latencyMs: number;
    detail: string;
  }> {
    const startedAt = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 800);
    try {
      const authHeader = `Basic ${Buffer.from(
        `${this.config.rabbitmqUser}:${this.config.rabbitmqPassword}`,
        'utf8',
      ).toString('base64')}`;
      const res = await fetch(`${this.config.rabbitmqMgmtUrl}/api/overview`, {
        method: 'GET',
        headers: {
          Authorization: authHeader,
          Accept: 'application/json',
        },
        signal: controller.signal,
      });
      const latencyMs = Math.max(0, Date.now() - startedAt);
      if (res.ok) {
        return { ok: true, latencyMs, detail: 'RabbitMQ Management API healthy' };
      }
      return {
        ok: false,
        latencyMs,
        detail: `RabbitMQ Management API returned HTTP ${res.status}`,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Math.max(0, Date.now() - startedAt),
        detail:
          error instanceof Error
            ? `RabbitMQ Management API unreachable: ${error.message}`
            : 'RabbitMQ Management API unreachable',
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
