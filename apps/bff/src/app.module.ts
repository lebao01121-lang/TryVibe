import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { AdminBffController } from './admin/admin-bff.controller';
import { AdminOpsController } from './admin/admin-ops.controller';
import { AdminPhase5Controller } from './admin/admin-phase5.controller';
import {
  ApiAuthBffController,
  AuthProxyService,
  CustomerBffController,
  CustomerProfileApiController,
  StorefrontAuthBffController,
} from './auth/auth-bff.controller';
import { CacheInvalidationService } from './common/cache-invalidation.service';
import { HttpProxyService } from './common/http-proxy.service';
import { BffRedisService } from './common/redis.service';
import { BFF_CONFIG_TOKEN, loadBffConfig } from './config/env';
import { HealthController } from './health/health.controller';
import { PartnerBffController } from './partner/partner-bff.controller';
import { InternalRealtimeController } from './realtime/internal-realtime.controller';
import { RealtimeGateway, RootRealtimeGateway } from './realtime/realtime.gateway';
import { AuditLoggerService } from './security/audit-logger.service';
import {
  AdminPortalGuard,
  CsrfOriginGuard,
  JwtAuthGuard,
  PartnerPortalGuard,
} from './security/guards';
import { JwtVerifierService } from './security/jwt-verifier.service';
import { TieredRateLimitMiddleware } from './security/rate-limit.middleware';
import {
  StorefrontAliasBffController,
  StorefrontBffController,
  StorefrontBffService,
} from './storefront/storefront-bff.controller';
import { StorefrontCheckoutController } from './storefront/storefront-checkout.controller';
import { StorefrontCommerceTryOnController } from './storefront/storefront-commerce-tryon.controller';

@Module({
  controllers: [
    HealthController,
    StorefrontAuthBffController,
    ApiAuthBffController,
    CustomerBffController,
    CustomerProfileApiController,
    StorefrontBffController,
    StorefrontAliasBffController,
    StorefrontCommerceTryOnController,
    StorefrontCheckoutController,
    AdminBffController,
    AdminPhase5Controller,
    AdminOpsController,
    PartnerBffController,
    InternalRealtimeController,
  ],
  providers: [
    {
      provide: BFF_CONFIG_TOKEN,
      useFactory: () => loadBffConfig(),
    },
    BffRedisService,
    HttpProxyService,
    CacheInvalidationService,
    JwtVerifierService,
    AuditLoggerService,
    AuthProxyService,
    StorefrontBffService,
    TieredRateLimitMiddleware,
    JwtAuthGuard,
    CsrfOriginGuard,
    AdminPortalGuard,
    PartnerPortalGuard,
    RealtimeGateway,
    RootRealtimeGateway,
  ],
})
export class AppModule implements NestModule {
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(TieredRateLimitMiddleware).forRoutes('*');
  }
}
