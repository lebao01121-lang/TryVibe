import { Controller, Get, Header, Headers, Inject } from '@nestjs/common';
import {
  ALL_ROLES,
  createApiResponse,
  MFA_REQUIRED_ROLES,
  Portal,
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
import { AUTH_CONFIG_TOKEN, type AuthCustomerConfig } from './config/env';
import { JwksService, type JwksDocument } from './crypto/jwks.service';
import { DatabaseService } from './infra/database.service';
import { AuthRedisService } from './infra/redis.service';

@Controller()
export class AuthCustomerController {
  constructor(
    @Inject(AUTH_CONFIG_TOKEN) private readonly config: AuthCustomerConfig,
    private readonly db: DatabaseService,
    private readonly redis: AuthRedisService,
    private readonly jwks: JwksService,
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
        jwksKid: this.jwks.getKid(),
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
        name: 'isolated-auth-db',
        status: dbUp ? 'up' : 'down',
        latencyMs: dbLatency,
        detail: `${this.config.database.envVar} -> ${this.config.database.targetDatabase} (mode=${this.db.mode})`,
      },
      {
        name: 'redis-session-rbac-store',
        status: redisUp ? 'up' : 'skipped',
        latencyMs: redisLatency,
        detail: redisUp
          ? 'Redis connected (permissionVersion, lock, denylist, email OTP)'
          : 'Redis unreachable (lazy retry active)',
      },
      {
        name: 'rs256-jwks',
        status: 'up',
        latencyMs: 0,
        detail: `RS256 2048-bit key loaded (kid=${this.jwks.getKid()})`,
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

  @Get('.well-known/jwks.json')
  @Header('Cache-Control', 'public, max-age=300')
  getJwks(): JwksDocument {
    return this.jwks.getJwks();
  }

  @Get('api/v1/auth/meta')
  getMeta(@Headers() headers: HeaderBag): ApiResponse<Record<string, unknown>> {
    const correlationId = getOrCreateCorrelationId(headers);

    return createApiResponse(
      {
        service: this.config.serviceName,
        boundedContext: this.config.boundedContext,
        port: this.config.port,
        phase: 'phase-1',
        databaseIsolation: {
          envVar: this.config.database.envVar,
          targetDatabase: this.config.database.targetDatabase,
          configured: this.config.database.configured,
          mode: this.db.mode,
        },
        jwks: {
          endpoint: '/.well-known/jwks.json',
          alg: 'RS256',
          kid: this.jwks.getKid(),
        },
        aggregates: [
          'users',
          'roles',
          'permissions',
          'role_permissions',
          'user_roles',
          'auth_sessions',
          'two_factor_auth',
          'customer_addresses',
          'customer_body_profiles',
          'tryon_quotas',
          'audit_logs',
        ],
        rbac: {
          roles: [...ALL_ROLES],
          portals: [Portal.STOREFRONT, Portal.ADMIN_PORTAL, Portal.PARTNER_PORTAL],
          mfaRequiredRoles: [...MFA_REQUIRED_ROLES],
          twoFactorRequiredPortals: [Portal.ADMIN_PORTAL, Portal.PARTNER_PORTAL],
        },
        messaging: {
          exchange: RABBITMQ_EXCHANGES.DOMAIN_TOPIC,
          publishes: ['customer.registered', 'customer.body_profile.updated'],
          consumes: ['order.delivered', 'order.delivery_failed_cod'],
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
