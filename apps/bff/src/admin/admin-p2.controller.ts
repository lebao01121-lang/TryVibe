import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { canRolesReadCostFields, redactRestrictedFields } from '@atelier/ai-harness';
import {
  canReadCostPrice,
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  Permission,
  Role,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  CacheInvalidationService,
  type RevalidationResult,
} from '../common/cache-invalidation.service';
import { HttpProxyService } from '../common/http-proxy.service';
import { BffRedisService } from '../common/redis.service';
import { buildCanonicalQueryString } from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../security/auth-types';
import { AdminPortalGuard, JwtAuthGuard } from '../security/guards';

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function extractDataObject(body: unknown): Record<string, unknown> | null {
  const rec = asRecord(body);
  if (!rec) return null;
  const inner = asRecord(rec.data);
  return inner ?? rec;
}

function extractDataList(body: unknown): Record<string, unknown>[] {
  if (Array.isArray(body)) {
    return body.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
  }
  const rec = asRecord(body);
  if (!rec) return [];
  const root = rec.data !== undefined ? rec.data : rec;
  if (Array.isArray(root)) {
    return root.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
  }
  const rootObj = asRecord(root);
  if (rootObj) {
    const listCandidate =
      rootObj.items ?? rootObj.transactions ?? rootObj.webhooks ?? rootObj.reviews ?? rootObj.customers ?? rootObj.users;
    if (Array.isArray(listCandidate)) {
      return listCandidate.filter((item): item is Record<string, unknown> => Boolean(asRecord(item)));
    }
  }
  return [];
}

function attachRevalidationMeta(
  body: unknown,
  revalidation: RevalidationResult | null,
): unknown {
  if (!revalidation) return body;
  const rec = asRecord(body);
  if (!rec) return body;
  const existingMeta = asRecord(rec.meta) ?? {};
  return {
    ...rec,
    meta: {
      ...existingMeta,
      revalidation,
    },
  };
}

function sanitizeAuditUserSnapshot(
  snapshot: Record<string, unknown> | null,
): Record<string, unknown> | null {
  if (!snapshot) return null;
  const clone: Record<string, unknown> = { ...snapshot };
  delete clone.password;
  delete clone.passwordHash;
  delete clone.password_hash;
  delete clone.totpSecret;
  delete clone.totp_secret;
  delete clone.totpSecretEncrypted;
  return clone;
}

function toFiniteNumber(value: unknown, fallback = 0): number {
  const num = Number(value);
  return Number.isFinite(num) ? num : fallback;
}

function toYmd(value: unknown): string | null {
  if (value instanceof Date) {
    return value.toISOString().slice(0, 10);
  }
  if (typeof value === 'string' && value.trim().length >= 10) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) {
      return new Date(parsed).toISOString().slice(0, 10);
    }
    return value.trim().slice(0, 10);
  }
  return null;
}

function formatDayLabel(ymd: string): string {
  const parts = ymd.split('-');
  if (parts.length === 3) {
    return `${parts[2]}/${parts[1]}`;
  }
  return ymd;
}

interface CatalogSkuCostMeta {
  skuId: string | null;
  skuCode: string;
  productId: string | null;
  productName: string;
  sizeCode: string | null;
  costPriceVnd: number;
  retailPriceVnd: number;
}

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, AdminPortalGuard)
export class AdminP2Controller {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  // ============================================================================
  // Shared Zero-Trust Security & Snapshot Helpers
  // ============================================================================

  private assertMfaVerified(user: JwtAccessPayload, correlationId: string): void {
    if (user.mfaVerified !== true) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.MFA_REQUIRED,
          'Thao tác nhạy cảm yêu cầu xác thực 2 lớp (2FA) trước khi thực thi.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }
  }

  private assertSuperAdminWithMfa(user: JwtAccessPayload, correlationId: string): void {
    if (!user.roles.includes(Role.SUPER_ADMIN)) {
      throw new HttpException(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Chỉ SUPER_ADMIN mới có quyền thực hiện thao tác bảo mật này.',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
        HttpStatus.FORBIDDEN,
      );
    }
    this.assertMfaVerified(user, correlationId);
  }

  private buildActorHeaders(user: JwtAccessPayload): Record<string, string> {
    return {
      'x-user-id': user.sub,
      'x-user-email': user.email,
      'x-actor-roles': user.roles.join(','),
    };
  }

  private async findByIdFromListEndpoint(
    url: string,
    id: string,
    req: Request,
    correlationId: string,
    user: JwtAccessPayload,
    idKeys: readonly string[] = ['id', 'code', 'slug'],
  ): Promise<Record<string, unknown> | null> {
    try {
      const res = await this.proxy.request({
        method: 'GET',
        url,
        req,
        correlationId,
        timeoutMs: 3000,
        extraHeaders: this.buildActorHeaders(user),
      });
      if (!res.ok) return null;
      const items = extractDataList(res.body);
      const targetLower = id.trim().toLowerCase();
      return (
        items.find((item) =>
          idKeys.some((key) => {
            const v = item[key];
            return typeof v === 'string' && v.trim().toLowerCase() === targetLower;
          }),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private extractBeforeAfter(
    upstreamBody: unknown,
    fallbackBefore: Record<string, unknown> | null,
  ): {
    beforeJsonb: Record<string, unknown> | null;
    afterJsonb: Record<string, unknown> | null;
  } {
    const obj = extractDataObject(upstreamBody);
    const upstreamBefore = asRecord(obj?.before);
    const upstreamAfter = asRecord(obj?.after);
    return {
      beforeJsonb: upstreamBefore ?? fallbackBefore,
      afterJsonb: upstreamAfter ?? obj,
    };
  }

  // ============================================================================
  // 1. Promotions Admin CRUD & HITL Draft Approval (payment-promo:4007)
  // ============================================================================

  @Get('promotions')
  @RequireAnyPermission(Permission.CATALOG_PRODUCT_READ, Permission.ORDER_READ)
  async listAdminPromotions(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/admin${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('promotions')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createPromotion(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const resourceId =
        typeof afterObj?.id === 'string'
          ? afterObj.id
          : typeof afterObj?.code === 'string'
            ? afterObj.code
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidatePromotionsAndRevalidate(correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PROMOTION_CREATED',
          resourceType: 'promotion',
          resourceId,
          beforeJsonb: null,
          afterJsonb: afterObj,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Patch('promotions/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updatePromotion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.paymentPromoServiceUrl}/v1/promotions/admin?limit=200`,
      id,
      req,
      correlationId,
      user,
      ['id', 'code'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidatePromotionsAndRevalidate(correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PROMOTION_UPDATED',
          resourceType: 'promotion',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Delete('promotions/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async archivePromotion(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.paymentPromoServiceUrl}/v1/promotions/admin?limit=200`,
      id,
      req,
      correlationId,
      user,
      ['id', 'code'],
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidatePromotionsAndRevalidate(correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PROMOTION_ARCHIVED',
          resourceType: 'promotion',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Post('promotions/:id/approve-draft')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.CATALOG_AI_APPROVE, Permission.CATALOG_PRODUCT_WRITE)
  async approvePromotionDraft(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    if (user.roles.includes(Role.SUPER_ADMIN)) {
      this.assertMfaVerified(user, correlationId);
    }

    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.paymentPromoServiceUrl}/v1/promotions/admin?limit=200`,
      id,
      req,
      correlationId,
      user,
      ['id', 'code'],
    );

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      approvedBy: user.sub,
      approvedByEmail: user.email,
    };

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/${encodeURIComponent(id)}/approve-draft`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidatePromotionsAndRevalidate(correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PROMOTION_DRAFT_APPROVED',
          resourceType: 'promotion',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  // ============================================================================
  // 2. Payment Ledger & Webhooks Reconciliation (payment-promo:4007)
  // ============================================================================

  @Get('payments/transactions')
  @RequireAnyPermission(Permission.ORDER_READ, Permission.ORDER_REFUND_APPROVE)
  async listPaymentTransactions(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/transactions${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('payments/webhooks')
  @RequireAnyPermission(Permission.ORDER_READ, Permission.ORDER_REFUND_APPROVE)
  async listPaymentWebhooks(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/webhooks${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 3. Editorial CMS — Occasions & 6 Seasons (catalog-lookbook:4002)
  // ============================================================================

  @Get('occasions')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listOccasions(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('occasions')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createOccasion(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.id === 'string'
          ? afterJsonb.id
          : typeof afterJsonb?.slug === 'string'
            ? afterJsonb.slug
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'occasions', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_OCCASION_CREATED',
          resourceType: 'occasion',
          resourceId,
          beforeJsonb: null,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Patch('occasions/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateOccasion(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug', 'key'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'occasions', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_OCCASION_UPDATED',
          resourceType: 'occasion',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Delete('occasions/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async deleteOccasion(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug', 'key'],
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/occasions/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'occasions', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_OCCASION_DELETED',
          resourceType: 'occasion',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Get('seasons')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listSeasons(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('seasons')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createSeason(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.id === 'string'
          ? afterJsonb.id
          : typeof afterJsonb?.slug === 'string'
            ? afterJsonb.slug
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'seasons', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*', 'season:restyle:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SEASON_CREATED',
          resourceType: 'season',
          resourceId,
          beforeJsonb: null,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Patch('seasons/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateSeason(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug', 'code'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'seasons', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*', 'season:restyle:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SEASON_UPDATED',
          resourceType: 'season',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Delete('seasons/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async deleteSeason(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug', 'code'],
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/seasons/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'seasons', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*', 'season:restyle:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SEASON_DELETED',
          resourceType: 'season',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  // ============================================================================
  // 4. Catalog Advanced — Categories, Size Charts, Variants, Archive, Media
  //    (Note: GET /api/v1/admin/categories lives in AdminBffController)
  // ============================================================================

  @Post('categories')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createCategory(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.id === 'string'
          ? afterJsonb.id
          : typeof afterJsonb?.slug === 'string'
            ? afterJsonb.slug
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'categories', 'products', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_CATEGORY_CREATED',
          resourceType: 'category',
          resourceId,
          beforeJsonb: null,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Patch('categories/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateCategory(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'categories', 'products', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_CATEGORY_UPDATED',
          resourceType: 'category',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Delete('categories/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async deleteCategory(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories`,
      id,
      req,
      correlationId,
      user,
      ['id', 'slug'],
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'categories', 'products', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_CATEGORY_DELETED',
          resourceType: 'category',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Get('size-charts')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listSizeCharts(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('size-charts')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createSizeChart(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId = typeof afterJsonb?.id === 'string' ? afterJsonb.id : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'size-charts'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SIZE_CHART_CREATED',
          resourceType: 'size_chart',
          resourceId,
          beforeJsonb: null,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Patch('size-charts/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateSizeChart(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts`,
      id,
      req,
      correlationId,
      user,
      ['id'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'size-charts'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SIZE_CHART_UPDATED',
          resourceType: 'size_chart',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Delete('size-charts/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async deleteSizeChart(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts`,
      id,
      req,
      correlationId,
      user,
      ['id'],
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/size-charts/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'size-charts'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['storefront:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SIZE_CHART_DELETED',
          resourceType: 'size_chart',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  @Post('products/:id/variants')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async addProductVariant(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products/${encodeURIComponent(id)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: this.buildActorHeaders(user),
    });
    const beforeObj = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}/variants`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const slug =
        typeof afterObj?.slug === 'string'
          ? afterObj.slug
          : typeof beforeObj?.slug === 'string'
            ? beforeObj.slug
            : null;
      const tags = ['storefront', 'products', 'rack', ...(slug ? [`product:${slug}`] : [])];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId, [
          'storefront:*',
        ]),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PRODUCT_VARIANT_ADDED',
          resourceType: 'product',
          resourceId: id,
          beforeJsonb: redactRestrictedFields(beforeObj, user.roles),
          afterJsonb: redactRestrictedFields(afterObj, user.roles),
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Delete('products/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async archiveProduct(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.handleArchiveProduct(id, req, res, user);
  }

  @Post('products/:id/archive')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async archiveProductPostAlias(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.handleArchiveProduct(id, req, res, user);
  }

  private async handleArchiveProduct(
    id: string,
    req: Request,
    res: Response,
    user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products/${encodeURIComponent(id)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: this.buildActorHeaders(user),
    });
    const beforeObj = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const slug =
        typeof afterObj?.slug === 'string'
          ? afterObj.slug
          : typeof beforeObj?.slug === 'string'
            ? beforeObj.slug
            : null;
      const tags = ['storefront', 'products', 'rack', 'bootstrap', ...(slug ? [`product:${slug}`] : [])];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId, [
          'storefront:*',
        ]),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PRODUCT_ARCHIVED',
          resourceType: 'product',
          resourceId: id,
          beforeJsonb: redactRestrictedFields(beforeObj, user.roles),
          afterJsonb: redactRestrictedFields(afterObj, user.roles),
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Delete('media/:assetId')
  @RequireAnyPermission(Permission.CATALOG_MEDIA_PROCESS, Permission.CATALOG_PRODUCT_WRITE)
  async deleteMediaAsset(
    @Param('assetId') assetId: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: this.buildActorHeaders(user),
    });
    const beforeJsonb = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_MEDIA_DELETED',
        resourceType: 'media_asset',
        resourceId: assetId,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/:assetId/attach')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.CATALOG_MEDIA_PROCESS, Permission.CATALOG_PRODUCT_WRITE)
  async attachMediaAssetToProduct(
    @Param('assetId') assetId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const bodyObj = asRecord(body) ?? {};
    const productId =
      typeof bodyObj.productId === 'string' && bodyObj.productId.trim()
        ? bodyObj.productId.trim()
        : typeof bodyObj.spuId === 'string' && bodyObj.spuId.trim()
          ? bodyObj.spuId.trim()
          : '';
    const variantId =
      typeof bodyObj.variantId === 'string' && bodyObj.variantId.trim()
        ? bodyObj.variantId.trim()
        : undefined;

    if (!productId) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Thiếu mã sản phẩm productId để gắn ảnh đã hiệu chuẩn.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const [mediaRes, beforeProductRes] = await Promise.all([
      this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}`,
        req,
        correlationId,
        timeoutMs: 3000,
        extraHeaders: this.buildActorHeaders(user),
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products/${encodeURIComponent(productId)}`,
        req,
        correlationId,
        timeoutMs: 3000,
        extraHeaders: this.buildActorHeaders(user),
      }),
    ]);

    const mediaObj = mediaRes.ok ? extractDataObject(mediaRes.body) : null;
    const beforeProduct = beforeProductRes.ok ? extractDataObject(beforeProductRes.body) : null;

    const variantsMap = asRecord(mediaObj?.variants);
    const previewCandidate =
      variantsMap?.preview_url ??
      variantsMap?.['720w'] ??
      variantsMap?.['1024w'] ??
      variantsMap?.cutout_url;
    const derivedVariantUrl =
      typeof previewCandidate === 'string'
        ? previewCandidate
        : asRecord(previewCandidate)?.url
          ? String(asRecord(previewCandidate)?.url)
          : undefined;
    const resolvedPublicUrl =
      (typeof bodyObj.publicUrl === 'string' && bodyObj.publicUrl.trim()) ||
      (typeof bodyObj.url === 'string' && bodyObj.url.trim()) ||
      (typeof mediaObj?.publicUrl === 'string' && mediaObj.publicUrl.trim()) ||
      derivedVariantUrl ||
      undefined;

    const rawAssetType =
      (typeof bodyObj.assetType === 'string' && bodyObj.assetType.trim()) ||
      (typeof bodyObj.role === 'string' && bodyObj.role.trim()) ||
      (typeof mediaObj?.assetType === 'string' && mediaObj.assetType.trim()) ||
      'LOOKBOOK';

    const spatialMetadata =
      asRecord(bodyObj.spatialMetadata) ??
      asRecord(mediaObj?.spatialMetadata) ??
      (mediaObj
        ? {
            ...(typeof mediaObj.hangerAnchorX === 'number'
              ? { hangerAnchorX: mediaObj.hangerAnchorX }
              : {}),
            ...(typeof mediaObj.hangerAnchorY === 'number'
              ? { hangerAnchorY: mediaObj.hangerAnchorY }
              : {}),
            ...(typeof mediaObj.layerZHint === 'number'
              ? { layerZHint: mediaObj.layerZHint }
              : {}),
            ...(mediaObj.boundingBoxJsonb ? { boundingBoxJsonb: mediaObj.boundingBoxJsonb } : {}),
          }
        : undefined);

    const attachPayload: Record<string, unknown> = {
      ...bodyObj,
      assetId,
      productId,
      ...(variantId ? { variantId } : {}),
      assetType: rawAssetType,
      ...(resolvedPublicUrl ? { publicUrl: resolvedPublicUrl, url: resolvedPublicUrl } : {}),
      ...(spatialMetadata && Object.keys(spatialMetadata).length > 0 ? { spatialMetadata } : {}),
    };

    // Primary endpoint in catalog-lookbook: POST /v1/catalog/products/:id/media
    let upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(productId)}/media`,
      req,
      body: attachPayload,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    // Graceful fallback to internal media-processed hook if service exposes only internal endpoint
    if (upstream.status === 404) {
      const normalizedType =
        rawAssetType === 'RACK_CUTOUT_2_3' ||
        rawAssetType === 'TRYON_FLAT_3_4' ||
        rawAssetType === 'LOOKBOOK' ||
        rawAssetType === 'STUDIO_LAYER'
          ? rawAssetType
          : rawAssetType.includes('RACK')
            ? 'RACK_CUTOUT_2_3'
            : rawAssetType.includes('TRYON') || rawAssetType.includes('FLAT')
              ? 'TRYON_FLAT_3_4'
              : 'LOOKBOOK';

      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/internal/media-processed`,
        req,
        body: {
          assetId,
          productId,
          ...(variantId ? { variantId } : {}),
          assetType: normalizedType,
          ...(resolvedPublicUrl ? { publicUrl: resolvedPublicUrl } : {}),
          ...(normalizedType === 'TRYON_FLAT_3_4' && resolvedPublicUrl
            ? { flatAssetUrl: resolvedPublicUrl }
            : {}),
          ...(normalizedType === 'RACK_CUTOUT_2_3' && resolvedPublicUrl
            ? { rackFrontUrl: resolvedPublicUrl }
            : {}),
          ...(spatialMetadata ? { spatialMetadata } : {}),
        },
        correlationId,
        extraHeaders: {
          ...this.buildActorHeaders(user),
          'x-internal-secret': this.config.internalServiceSecret,
        },
      });
    }

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const slug =
        typeof afterObj?.slug === 'string'
          ? afterObj.slug
          : typeof beforeProduct?.slug === 'string'
            ? beforeProduct.slug
            : null;
      const tags = [
        'storefront',
        'products',
        'rack',
        'bootstrap',
        ...(slug ? [`product:${slug}`] : []),
      ];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId, [
          'storefront:*',
        ]),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_MEDIA_ATTACHED',
          resourceType: 'media_asset',
          resourceId: assetId,
          beforeJsonb: redactRestrictedFields(beforeProduct, user.roles),
          afterJsonb: redactRestrictedFields(
            {
              assetId,
              productId,
              variantId: variantId ?? null,
              assetType: rawAssetType,
              publicUrl: resolvedPublicUrl ?? null,
              result: afterObj,
            },
            user.roles,
          ),
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  // ============================================================================
  // 5. Inventory Ops — Adjustments, Transfers, Warehouses, Safety Threshold
  // ============================================================================

  @Post('inventory/adjustments')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.INVENTORY_STOCK_WRITE)
  async createInventoryAdjustment(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      actorId: user.sub,
      actorEmail: user.email,
    };

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/adjustments`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(upstream.body, null);
      const resourceId =
        typeof bodyObj.sku === 'string'
          ? bodyObj.sku
          : typeof bodyObj.skuId === 'string'
            ? bodyObj.skuId
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'rack'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'INVENTORY_STOCK_ADJUSTED',
          resourceType: 'inventory_stock',
          resourceId,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Post('inventory/transfers')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.INVENTORY_STOCK_WRITE)
  async createInventoryTransfer(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      actorId: user.sub,
      actorEmail: user.email,
    };

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/transfers`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterData = extractDataObject(upstream.body);
      const beforeJsonb =
        afterData?.fromBefore || afterData?.toBefore
          ? {
              from: afterData.fromBefore ?? null,
              to: afterData.toBefore ?? null,
            }
          : asRecord(afterData?.before);
      const afterJsonb =
        afterData?.fromAfter || afterData?.toAfter
          ? {
              transferRef: afterData.transferRef ?? null,
              from: afterData.fromAfter ?? null,
              to: afterData.toAfter ?? null,
            }
          : afterData;

      const resourceId =
        typeof afterData?.transferRef === 'string'
          ? afterData.transferRef
          : typeof bodyObj.sku === 'string'
            ? bodyObj.sku
            : null;

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'rack'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'INVENTORY_STOCK_TRANSFERRED',
          resourceType: 'inventory_transfer',
          resourceId,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Post('inventory/warehouses')
  @RequirePermissions(Permission.INVENTORY_STOCK_WRITE)
  async createWarehouse(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/warehouses`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.code === 'string'
          ? afterJsonb.code
          : typeof afterJsonb?.id === 'string'
            ? afterJsonb.id
            : null;
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'INVENTORY_WAREHOUSE_CREATED',
        resourceType: 'warehouse',
        resourceId,
        beforeJsonb: null,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Patch('inventory/warehouses/:code')
  @RequirePermissions(Permission.INVENTORY_STOCK_WRITE)
  async updateWarehouse(
    @Param('code') code: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.inventoryServiceUrl}/v1/inventory/admin/warehouses`,
      code,
      req,
      correlationId,
      user,
      ['code', 'id'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/warehouses/${encodeURIComponent(code)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'INVENTORY_WAREHOUSE_UPDATED',
        resourceType: 'warehouse',
        resourceId: code,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Patch('inventory/stock/:sku/threshold')
  @RequirePermissions(Permission.INVENTORY_STOCK_WRITE)
  async updateStockSafetyThreshold(
    @Param('sku') sku: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/stock/${encodeURIComponent(sku)}/threshold`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(upstream.body, null);
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'INVENTORY_THRESHOLD_UPDATED',
        resourceType: 'inventory_stock',
        resourceId: sku,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 6. B2B Procurement — Suppliers CRUD, Cancel PO, Mark Payable Paid
  //    (Note: GET suppliers, PO CRUD, GRNs, GET payables live in AdminPhase5Controller)
  // ============================================================================

  @Post('procurement/suppliers')
  @RequirePermissions(Permission.INVENTORY_PO_CREATE)
  async createSupplier(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/suppliers`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.id === 'string'
          ? afterJsonb.id
          : typeof afterJsonb?.code === 'string'
            ? afterJsonb.code
            : null;
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_SUPPLIER_CREATED',
        resourceType: 'supplier',
        resourceId,
        beforeJsonb: null,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Patch('procurement/suppliers/:id')
  @RequirePermissions(Permission.INVENTORY_PO_CREATE)
  async updateSupplier(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.inventoryServiceUrl}/v1/procurement/suppliers`,
      id,
      req,
      correlationId,
      user,
      ['id', 'code'],
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/suppliers/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_SUPPLIER_UPDATED',
        resourceType: 'supplier',
        resourceId: id,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/purchase-orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.INVENTORY_PO_APPROVE, Permission.INVENTORY_PO_CREATE)
  async cancelPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: this.buildActorHeaders(user),
    });
    const fallbackBefore = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const bodyObj = asRecord(body) ?? {};
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}/cancel`,
      req,
      body: {
        ...bodyObj,
        actorId: user.sub,
        actorEmail: user.email,
      },
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_PO_CANCELLED',
        resourceType: 'purchase_order',
        resourceId: id,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/payables/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  @RequireAnyPermission(Permission.INVENTORY_PO_APPROVE, Permission.FINANCE_COST_PRICE_READ)
  async markPayablePaid(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.inventoryServiceUrl}/v1/procurement/payables`,
      id,
      req,
      correlationId,
      user,
      ['id'],
    );

    const bodyObj = asRecord(body) ?? {};
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/payables/${encodeURIComponent(id)}/mark-paid`,
      req,
      body: {
        ...bodyObj,
        actorId: user.sub,
        actorEmail: user.email,
      },
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_PAYABLE_MARKED_PAID',
        resourceType: 'supplier_payable',
        resourceId: id,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 7. Orders & RMA Lifecycle — Admin Cancel, Complete, RMA Reject (order-rma:4006)
  // ============================================================================

  @Post('orders/:code/cancel')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_MANAGE)
  async cancelOrderAdmin(
    @Param('code') code: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(code)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: {
        ...this.buildActorHeaders(user),
        'x-internal-secret': this.config.internalServiceSecret,
      },
    });
    const fallbackBefore = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      cancelledBy: user.sub,
      actorId: user.sub,
      actorEmail: user.email,
    };

    // Prefer /v1/admin/orders/:code/cancel if present, gracefully falling back to /v1/orders/:code/cancel
    let upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(code)}/cancel`,
      req,
      body: forwardedBody,
      correlationId,
      timeoutMs: 20_000,
      extraHeaders: {
        ...this.buildActorHeaders(user),
        'x-internal-secret': this.config.internalServiceSecret,
      },
    });

    if (upstream.status === 404) {
      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(code)}/cancel`,
        req,
        body: forwardedBody,
        correlationId,
        timeoutMs: 20_000,
        extraHeaders: {
          ...this.buildActorHeaders(user),
          'x-internal-secret': this.config.internalServiceSecret,
        },
      });
    }

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'rack'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_ORDER_CANCELLED',
          resourceType: 'order',
          resourceId: code,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('orders/:code/complete')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_MANAGE)
  async completeOrderAdmin(
    @Param('code') code: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(code)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: {
        ...this.buildActorHeaders(user),
        'x-internal-secret': this.config.internalServiceSecret,
      },
    });
    const fallbackBefore = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      completedBy: user.sub,
      actorId: user.sub,
      actorEmail: user.email,
    };

    let upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(code)}/complete`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: {
        ...this.buildActorHeaders(user),
        'x-internal-secret': this.config.internalServiceSecret,
      },
    });

    if (upstream.status === 404) {
      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.orderRmaServiceUrl}/v1/orders/${encodeURIComponent(code)}/complete`,
        req,
        body: forwardedBody,
        correlationId,
        extraHeaders: {
          ...this.buildActorHeaders(user),
          'x-internal-secret': this.config.internalServiceSecret,
        },
      });
    }

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_ORDER_COMPLETED',
        resourceType: 'order',
        resourceId: code,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('rma/:id/reject')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ORDER_RMA_MANAGE)
  async rejectRmaAdmin(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const fallbackBefore = await this.findByIdFromListEndpoint(
      `${this.config.orderRmaServiceUrl}/v1/admin/rma?limit=200`,
      id,
      req,
      correlationId,
      user,
      ['id'],
    );

    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      rejectedBy: user.sub,
      actorId: user.sub,
      actorEmail: user.email,
    };

    let upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/rma/${encodeURIComponent(id)}/reject`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: {
        ...this.buildActorHeaders(user),
        'x-internal-secret': this.config.internalServiceSecret,
      },
    });

    if (upstream.status === 404) {
      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.orderRmaServiceUrl}/v1/rma/${encodeURIComponent(id)}/reject`,
        req,
        body: forwardedBody,
        correlationId,
        extraHeaders: {
          ...this.buildActorHeaders(user),
          'x-internal-secret': this.config.internalServiceSecret,
        },
      });
    }

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_RMA_REJECTED',
        resourceType: 'rma_request',
        resourceId: id,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // 8. IAM Advanced — Create User, Soft-Delete User, Reset 2FA (auth-customer:4001)
  // ============================================================================

  @Post('users')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async createUser(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users`,
      req,
      body,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const afterObj = sanitizeAuditUserSnapshot(extractDataObject(upstream.body));
      const resourceId = typeof afterObj?.id === 'string' ? afterObj.id : null;
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_USER_CREATED',
        resourceType: 'user',
        resourceId,
        beforeJsonb: null,
        afterJsonb: afterObj,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Delete('users/:id')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async deleteUser(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertMfaVerified(user, correlationId);

    const fallbackBefore = sanitizeAuditUserSnapshot(
      await this.findByIdFromListEndpoint(
        `${this.config.upstreams.authCustomerUrl}/v1/users`,
        id,
        req,
        correlationId,
        user,
        ['id'],
      ),
    );

    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_USER_DELETED',
        resourceType: 'user',
        resourceId: id,
        beforeJsonb: sanitizeAuditUserSnapshot(beforeJsonb),
        afterJsonb: sanitizeAuditUserSnapshot(afterJsonb),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('users/:id/reset-2fa')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async resetUserTwoFactor(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    this.assertSuperAdminWithMfa(user, correlationId);

    const fallbackBefore = sanitizeAuditUserSnapshot(
      await this.findByIdFromListEndpoint(
        `${this.config.upstreams.authCustomerUrl}/v1/users`,
        id,
        req,
        correlationId,
        user,
        ['id'],
      ),
    );

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users/${encodeURIComponent(id)}/reset-2fa`,
      req,
      body: body ?? {},
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(
        upstream.body,
        fallbackBefore,
      );
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ADMIN_USER_2FA_RESET',
        resourceType: 'user',
        resourceId: id,
        beforeJsonb: sanitizeAuditUserSnapshot(beforeJsonb),
        afterJsonb: sanitizeAuditUserSnapshot(afterJsonb),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  // ============================================================================
  // 9. CRM Customers, Review Moderation, Notification Logs & BI Analytics
  // ============================================================================

  @Get('customers')
  @RequireAnyPermission(
    Permission.ORDER_READ,
    Permission.CATALOG_PRODUCT_READ,
    Permission.ADMIN_AUDIT_READ,
  )
  async listCustomersCrm(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const qs = buildCanonicalQueryString(query);
    const internalHeaders = {
      ...this.buildActorHeaders(user),
      'x-internal-secret': this.config.internalServiceSecret,
    };

    const [customersPrimary, ordersRes, rmaRes] = await Promise.all([
      this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.authCustomerUrl}/v1/customers${qs ? `?${qs}` : ''}`,
        req,
        correlationId,
        timeoutMs: 4000,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.orderRmaServiceUrl}/v1/admin/orders?limit=500`,
        correlationId,
        timeoutMs: 4000,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.orderRmaServiceUrl}/v1/admin/rma?limit=500`,
        correlationId,
        timeoutMs: 4000,
        extraHeaders: internalHeaders,
      }),
    ]);

    let customersRes = customersPrimary;
    if (!customersRes.ok && (customersRes.status === 404 || customersRes.status === 403)) {
      const fallbackQs = buildCanonicalQueryString({
        ...query,
        role: Role.CUSTOMER,
      });
      customersRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.authCustomerUrl}/v1/users${fallbackQs ? `?${fallbackQs}` : ''}`,
        req,
        correlationId,
        timeoutMs: 4000,
        extraHeaders: internalHeaders,
      });
    }

    if (!customersRes.ok) {
      this.proxy.sendProxyResponse(res, customersRes, (payload) =>
        redactRestrictedFields(payload, user.roles),
      );
      return;
    }

    const rawCustomers = extractDataList(customersRes.body);
    const orders = ordersRes.ok ? extractDataList(ordersRes.body) : [];
    const rmas = rmaRes.ok ? extractDataList(rmaRes.body) : [];

    type CustomerOrderAgg = {
      orderCount: number;
      completedOrderCount: number;
      cancelledOrderCount: number;
      totalSpentVnd: number;
      rmaCount: number;
      lastOrderAt: string | null;
      recentOrders: Array<Record<string, unknown>>;
      recentRmas: Array<Record<string, unknown>>;
    };

    const aggByKey = new Map<string, CustomerOrderAgg>();
    const getOrCreateAgg = (key: string): CustomerOrderAgg => {
      const existing = aggByKey.get(key);
      if (existing) return existing;
      const created: CustomerOrderAgg = {
        orderCount: 0,
        completedOrderCount: 0,
        cancelledOrderCount: 0,
        totalSpentVnd: 0,
        rmaCount: 0,
        lastOrderAt: null,
        recentOrders: [],
        recentRmas: [],
      };
      aggByKey.set(key, created);
      return created;
    };

    for (const order of orders) {
      const keys = new Set<string>();
      if (typeof order.userId === 'string' && order.userId.trim()) {
        keys.add(`id:${order.userId.trim()}`);
      }
      if (typeof order.customerId === 'string' && order.customerId.trim()) {
        keys.add(`id:${order.customerId.trim()}`);
      }
      const emailCandidate =
        (typeof order.customerEmail === 'string' && order.customerEmail) ||
        (typeof order.email === 'string' && order.email) ||
        (asRecord(order.shippingAddress)?.email as string | undefined) ||
        '';
      if (emailCandidate.trim()) {
        keys.add(`email:${emailCandidate.trim().toLowerCase()}`);
      }

      const status = String(order.status ?? '').toUpperCase();
      const totalVnd = toFiniteNumber(
        order.totalVnd ?? order.finalTotalVnd ?? order.grandTotalVnd ?? order.subtotalVnd,
        0,
      );
      const createdAt = typeof order.createdAt === 'string' ? order.createdAt : null;

      const orderSummary = {
        id: order.id ?? null,
        orderCode: order.orderCode ?? order.code ?? null,
        status,
        totalVnd,
        createdAt,
      };

      for (const k of keys) {
        const agg = getOrCreateAgg(k);
        agg.orderCount += 1;
        if (status === 'CANCELLED' || status === 'PAYMENT_FAILED' || status === 'EXPIRED') {
          agg.cancelledOrderCount += 1;
        } else {
          agg.totalSpentVnd += totalVnd;
          if (status === 'DELIVERED' || status === 'COMPLETED') {
            agg.completedOrderCount += 1;
          }
        }
        if (createdAt && (!agg.lastOrderAt || createdAt > agg.lastOrderAt)) {
          agg.lastOrderAt = createdAt;
        }
        if (agg.recentOrders.length < 5) {
          agg.recentOrders.push(orderSummary);
        }
      }
    }

    for (const rma of rmas) {
      const keys = new Set<string>();
      if (typeof rma.userId === 'string' && rma.userId.trim()) {
        keys.add(`id:${rma.userId.trim()}`);
      }
      if (typeof rma.customerId === 'string' && rma.customerId.trim()) {
        keys.add(`id:${rma.customerId.trim()}`);
      }
      if (typeof rma.customerEmail === 'string' && rma.customerEmail.trim()) {
        keys.add(`email:${rma.customerEmail.trim().toLowerCase()}`);
      }

      const rmaSummary = {
        id: rma.id ?? null,
        orderCode: rma.orderCode ?? null,
        status: rma.status ?? null,
        rmaType: rma.rmaType ?? null,
        reasonCode: rma.reasonCode ?? null,
        createdAt: rma.createdAt ?? null,
      };

      for (const k of keys) {
        const agg = getOrCreateAgg(k);
        agg.rmaCount += 1;
        if (agg.recentRmas.length < 5) {
          agg.recentRmas.push(rmaSummary);
        }
      }
    }

    const enrichedItems = rawCustomers.map((customer) => {
      const idKey = typeof customer.id === 'string' ? `id:${customer.id.trim()}` : '';
      const emailKey =
        typeof customer.email === 'string'
          ? `email:${customer.email.trim().toLowerCase()}`
          : '';
      const agg =
        (idKey ? aggByKey.get(idKey) : undefined) ??
        (emailKey ? aggByKey.get(emailKey) : undefined) ?? {
          orderCount: 0,
          completedOrderCount: 0,
          cancelledOrderCount: 0,
          totalSpentVnd: 0,
          rmaCount: 0,
          lastOrderAt: null,
          recentOrders: [],
          recentRmas: [],
        };

      return {
        ...customer,
        vipTier: customer.vipTier ?? customer.loyaltyTier ?? 'BRONZE',
        loyaltyTier: customer.loyaltyTier ?? customer.vipTier ?? 'BRONZE',
        orderCount: agg.orderCount,
        completedOrderCount: agg.completedOrderCount,
        cancelledOrderCount: agg.cancelledOrderCount,
        totalSpentVnd: agg.totalSpentVnd,
        rmaCount: agg.rmaCount,
        lastOrderAt: agg.lastOrderAt,
        recentOrders: agg.recentOrders,
        recentRmas: agg.recentRmas,
      };
    });

    const upstreamData = extractDataObject(customersRes.body);
    const upstreamPagination = asRecord(upstreamData?.pagination);
    const page = Math.max(1, toFiniteNumber(query.page ?? upstreamPagination?.page, 1));
    const limit = Math.max(1, toFiniteNumber(query.limit ?? upstreamPagination?.limit, 50));
    const total = toFiniteNumber(upstreamPagination?.total, enrichedItems.length);
    const totalPages = Math.max(
      1,
      toFiniteNumber(upstreamPagination?.totalPages, Math.ceil(total / limit)),
    );

    const responseBody = createApiResponse(
      {
        items: enrichedItems,
        customers: enrichedItems,
        total,
        pagination: {
          page,
          limit,
          total,
          totalPages,
        },
      },
      { correlationId, service: this.config.serviceName },
    );

    res.status(200).json(redactRestrictedFields(responseBody, user.roles));
  }

  @Get('reviews')
  @RequireAnyPermission(
    Permission.ORDER_READ,
    Permission.CATALOG_PRODUCT_READ,
    Permission.ORDER_MANAGE,
    Permission.CATALOG_PRODUCT_WRITE,
  )
  async listAdminReviews(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    let upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/admin${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });

    if (upstream.status === 404) {
      upstream = await this.proxy.request({
        method: 'GET',
        url: `${this.config.notifyReviewServiceUrl}/v1/reviews${qs ? `?${qs}` : ''}`,
        req,
        extraHeaders: this.buildActorHeaders(user),
      });
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Patch('reviews/:id/moderation')
  @RequireAnyPermission(Permission.ORDER_MANAGE, Permission.CATALOG_PRODUCT_WRITE)
  async moderateReview(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const bodyObj = asRecord(body) ?? {};
    const forwardedBody = {
      ...bodyObj,
      moderatedBy: user.sub,
      moderatedByEmail: user.email,
    };

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/${encodeURIComponent(id)}/moderation`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(upstream.body, null);
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'reviews'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['bff:storefront:product:*', 'reviews:*', 'storefront:reviews:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_REVIEW_MODERATED',
          resourceType: 'product_review',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Delete('reviews/:id')
  @RequireAnyPermission(Permission.ORDER_MANAGE, Permission.CATALOG_PRODUCT_WRITE)
  async deleteReview(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'DELETE',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/${encodeURIComponent(id)}`,
      req,
      correlationId,
      extraHeaders: this.buildActorHeaders(user),
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const { beforeJsonb, afterJsonb } = this.extractBeforeAfter(upstream.body, null);
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'reviews'],
          ['/', '/bo-suu-tap'],
          correlationId,
          ['bff:storefront:product:*', 'reviews:*', 'storefront:reviews:*'],
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_REVIEW_DELETED',
          resourceType: 'product_review',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Get('notifications/logs')
  @RequireAnyPermission(
    Permission.ORDER_READ,
    Permission.CATALOG_PRODUCT_READ,
    Permission.ADMIN_AUDIT_READ,
  )
  async listNotificationLogs(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/notifications/logs${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildActorHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  // ============================================================================
  // 10. BI Analytics Aggregator with STRICT Layer 5 Cost/COGS/Margin Redaction
  // ============================================================================

  @Get('analytics/bi')
  @RequireAnyPermission(
    Permission.ORDER_READ,
    Permission.CATALOG_PRODUCT_READ,
    Permission.INVENTORY_STOCK_READ,
    Permission.ADMIN_AUDIT_READ,
  )
  async getBiAnalytics(
    @Query('range') rangeRaw: string | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const normalizedRange = (rangeRaw ?? '30d').trim().toLowerCase();
    const range: '7d' | '30d' | '90d' =
      normalizedRange === '7d' ? '7d' : normalizedRange === '90d' ? '90d' : '30d';
    const rangeDays = range === '7d' ? 7 : range === '90d' ? 90 : 30;

    const now = new Date();
    const cutoffMs = now.getTime() - rangeDays * 24 * 60 * 60 * 1000;
    const cutoffIso = new Date(cutoffMs).toISOString();

    // STRICT Layer 5 permission check: ONLY SUPER_ADMIN & WAREHOUSE_MANAGER (cost-price permission)
    const canReadCosts =
      canReadCostPrice(user.roles) && canRolesReadCostFields(user.roles);

    const internalHeaders = {
      ...this.buildActorHeaders(user),
      'x-internal-secret': this.config.internalServiceSecret,
    };

    const [ordersRes, rmaRes, txRes, stockRes, catalogRes] = await Promise.all([
      this.proxy.request({
        method: 'GET',
        url: `${this.config.orderRmaServiceUrl}/v1/admin/orders?limit=1000`,
        correlationId,
        timeoutMs: 4500,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.orderRmaServiceUrl}/v1/admin/rma?limit=1000`,
        correlationId,
        timeoutMs: 4500,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.paymentPromoServiceUrl}/v1/payments/transactions?limit=1000`,
        correlationId,
        timeoutMs: 4500,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.inventoryServiceUrl}/v1/inventory/admin/stock-levels?limit=1000`,
        correlationId,
        timeoutMs: 4500,
        extraHeaders: internalHeaders,
      }),
      this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products?pageSize=200`,
        correlationId,
        timeoutMs: 4500,
        extraHeaders: internalHeaders,
      }),
    ]);

    const ordersAll = ordersRes.ok ? extractDataList(ordersRes.body) : [];
    const rmasAll = rmaRes.ok ? extractDataList(rmaRes.body) : [];
    const transactionsAll = txRes.ok ? extractDataList(txRes.body) : [];
    const stockLevelsAll = stockRes.ok ? extractDataList(stockRes.body) : [];
    const productsAll = catalogRes.ok ? extractDataList(catalogRes.body) : [];

    // 1. Index Catalog SKU unit costs & names (kept strictly in BFF memory!)
    const skuMetaById = new Map<string, CatalogSkuCostMeta>();
    const skuMetaByCode = new Map<string, CatalogSkuCostMeta>();
    const productAvgCostById = new Map<string, { name: string; avgCostVnd: number }>();

    for (const product of productsAll) {
      const productId = typeof product.id === 'string' ? product.id : null;
      const productName =
        typeof product.name === 'string' && product.name.trim()
          ? product.name.trim()
          : 'Sản phẩm Tầm Xuân';
      const variants = Array.isArray(product.variants) ? product.variants : [];
      let costSum = 0;
      let costCount = 0;

      for (const rawVariant of variants) {
        const variant = asRecord(rawVariant);
        if (!variant) continue;
        const skus = Array.isArray(variant.skus) ? variant.skus : [];
        for (const rawSku of skus) {
          const sku = asRecord(rawSku);
          if (!sku) continue;
          const skuId = typeof sku.id === 'string' ? sku.id : null;
          const skuCode =
            typeof sku.skuCode === 'string'
              ? sku.skuCode.trim()
              : typeof sku.sku === 'string'
                ? sku.sku.trim()
                : skuId ?? 'UNKNOWN-SKU';
          const sizeCode =
            typeof sku.sizeCode === 'string'
              ? sku.sizeCode
              : typeof sku.size === 'string'
                ? sku.size
                : null;
          const retailPriceVnd = toFiniteNumber(
            sku.salePriceVnd ?? sku.basePriceVnd ?? sku.priceVnd,
            0,
          );
          const costPriceVnd = toFiniteNumber(
            sku.costPriceVnd ?? sku.cost_price_vnd ?? sku.costPrice ?? sku.unitCostVnd,
            0,
          );

          const meta: CatalogSkuCostMeta = {
            skuId,
            skuCode,
            productId,
            productName,
            sizeCode,
            costPriceVnd,
            retailPriceVnd,
          };
          if (skuId) skuMetaById.set(skuId, meta);
          if (skuCode) skuMetaByCode.set(skuCode.toUpperCase(), meta);
          if (costPriceVnd > 0) {
            costSum += costPriceVnd;
            costCount += 1;
          }
        }
      }

      if (productId) {
        productAvgCostById.set(productId, {
          name: productName,
          avgCostVnd: costCount > 0 ? Math.round(costSum / costCount) : 0,
        });
      }
    }

    // 2. Index current available stock by skuId & skuCode
    const stockByKey = new Map<string, number>();
    for (const row of stockLevelsAll) {
      const avail = toFiniteNumber(row.availableQty ?? row.available_qty, 0);
      if (typeof row.skuId === 'string' && row.skuId.trim()) {
        const k = row.skuId.trim();
        stockByKey.set(k, (stockByKey.get(k) ?? 0) + avail);
      }
      const code =
        typeof row.skuCode === 'string'
          ? row.skuCode.trim().toUpperCase()
          : typeof row.sku === 'string'
            ? row.sku.trim().toUpperCase()
            : '';
      if (code) {
        stockByKey.set(code, (stockByKey.get(code) ?? 0) + avail);
      }
    }

    // 3. Prepare daily time-series buckets across the requested range
    interface DailyBucket {
      date: string;
      label: string;
      orderCount: number;
      rmaCount: number;
      grossRevenueVnd: number;
      refundedVnd: number;
      cogsAccumulatorVnd: number;
    }

    const bucketMap = new Map<string, DailyBucket>();
    const orderedDates: string[] = [];
    for (let i = rangeDays - 1; i >= 0; i -= 1) {
      const d = new Date(now.getTime() - i * 24 * 60 * 60 * 1000);
      const ymd = d.toISOString().slice(0, 10);
      orderedDates.push(ymd);
      bucketMap.set(ymd, {
        date: ymd,
        label: formatDayLabel(ymd),
        orderCount: 0,
        rmaCount: 0,
        grossRevenueVnd: 0,
        refundedVnd: 0,
        cogsAccumulatorVnd: 0,
      });
    }

    // 4. Filter orders within range & aggregate revenue, COGS, top SKUs
    const excludedStatuses = new Set(['CANCELLED', 'PAYMENT_FAILED', 'EXPIRED']);
    let orderCount = 0;
    let completedOrderCount = 0;
    let cancelledOrderCount = 0;
    let grossRevenueVnd = 0;
    let totalUnitsSold = 0;
    let totalCogsAccumulatorVnd = 0;

    interface SkuSalesAgg {
      skuId: string | null;
      skuCode: string;
      productId: string | null;
      productName: string;
      sizeCode: string | null;
      unitsSold: number;
      revenueVnd: number;
      cogsAccumulatorVnd: number;
    }
    const skuSalesMap = new Map<string, SkuSalesAgg>();

    const inRangeOrderCodes = new Set<string>();
    const orderDateByCode = new Map<string, string>();

    for (const order of ordersAll) {
      const createdAtMs =
        typeof order.createdAt === 'string' ? Date.parse(order.createdAt) : Number.NaN;
      if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
        continue;
      }

      const ymd = toYmd(order.createdAt) ?? orderedDates[orderedDates.length - 1];
      const bucket = bucketMap.get(ymd);
      const status = String(order.status ?? '').toUpperCase();
      const orderCode =
        typeof order.orderCode === 'string'
          ? order.orderCode
          : typeof order.code === 'string'
            ? order.code
            : '';
      if (orderCode) {
        inRangeOrderCodes.add(orderCode);
        orderDateByCode.set(orderCode, ymd);
      }

      orderCount += 1;
      if (excludedStatuses.has(status)) {
        cancelledOrderCount += 1;
        continue;
      }

      if (status === 'DELIVERED' || status === 'COMPLETED') {
        completedOrderCount += 1;
      }

      const orderTotal = toFiniteNumber(
        order.totalVnd ?? order.finalTotalVnd ?? order.grandTotalVnd ?? order.subtotalVnd,
        0,
      );
      grossRevenueVnd += orderTotal;
      if (bucket) {
        bucket.orderCount += 1;
        bucket.grossRevenueVnd += orderTotal;
      }

      const items = Array.isArray(order.items) ? order.items : [];
      for (const rawItem of items) {
        const item = asRecord(rawItem);
        if (!item) continue;
        const qty = Math.max(1, Math.round(toFiniteNumber(item.qty ?? item.quantity, 1)));
        const unitPrice = toFiniteNumber(item.unitPriceVnd ?? item.priceVnd, 0);
        const lineRevenue = toFiniteNumber(
          item.lineTotalVnd ?? item.totalVnd,
          unitPrice * qty,
        );

        const rawSkuId = typeof item.skuId === 'string' ? item.skuId.trim() : null;
        const rawSkuCode =
          typeof item.skuCode === 'string' && item.skuCode.trim()
            ? item.skuCode.trim()
            : typeof item.sku === 'string' && item.sku.trim()
              ? item.sku.trim()
              : null;
        const rawProductId = typeof item.productId === 'string' ? item.productId.trim() : null;

        const catalogMeta =
          (rawSkuId ? skuMetaById.get(rawSkuId) : undefined) ??
          (rawSkuCode ? skuMetaByCode.get(rawSkuCode.toUpperCase()) : undefined);

        const resolvedSkuCode = rawSkuCode ?? catalogMeta?.skuCode ?? rawSkuId ?? 'UNKNOWN-SKU';
        const resolvedProductId = rawProductId ?? catalogMeta?.productId ?? null;
        const resolvedProductName =
          (typeof item.productName === 'string' && item.productName.trim()) ||
          (typeof item.name === 'string' && item.name.trim()) ||
          catalogMeta?.productName ||
          (resolvedProductId ? productAvgCostById.get(resolvedProductId)?.name : undefined) ||
          resolvedSkuCode;
        const resolvedSizeCode =
          (typeof item.sizeCode === 'string' && item.sizeCode.trim()) ||
          (typeof item.size === 'string' && item.size.trim()) ||
          catalogMeta?.sizeCode ||
          null;

        const unitCost =
          catalogMeta && catalogMeta.costPriceVnd > 0
            ? catalogMeta.costPriceVnd
            : resolvedProductId && (productAvgCostById.get(resolvedProductId)?.avgCostVnd ?? 0) > 0
              ? productAvgCostById.get(resolvedProductId)!.avgCostVnd
              : 0;
        const lineCogs = unitCost * qty;

        totalUnitsSold += qty;
        totalCogsAccumulatorVnd += lineCogs;
        if (bucket) {
          bucket.cogsAccumulatorVnd += lineCogs;
        }

        const key = resolvedSkuCode.toUpperCase();
        const existingSku = skuSalesMap.get(key);
        if (existingSku) {
          existingSku.unitsSold += qty;
          existingSku.revenueVnd += lineRevenue;
          existingSku.cogsAccumulatorVnd += lineCogs;
        } else {
          skuSalesMap.set(key, {
            skuId: rawSkuId ?? catalogMeta?.skuId ?? null,
            skuCode: resolvedSkuCode,
            productId: resolvedProductId,
            productName: resolvedProductName,
            sizeCode: resolvedSizeCode,
            unitsSold: qty,
            revenueVnd: lineRevenue,
            cogsAccumulatorVnd: lineCogs,
          });
        }
      }
    }

    // 5. Aggregate refunded amounts from payment transactions within range
    let refundedVnd = 0;
    const seenRefundedOrders = new Set<string>();

    for (const tx of transactionsAll) {
      const txCreatedMs =
        typeof tx.createdAt === 'string' ? Date.parse(tx.createdAt) : Number.NaN;
      const orderCode = typeof tx.orderCode === 'string' ? tx.orderCode : '';
      const inRange =
        (Number.isFinite(txCreatedMs) && txCreatedMs >= cutoffMs) ||
        (orderCode && inRangeOrderCodes.has(orderCode));
      if (!inRange) continue;

      const txType = String(tx.txType ?? tx.type ?? '').toUpperCase();
      const txStatus = String(tx.status ?? '').toUpperCase();
      const ymd =
        toYmd(tx.createdAt) ??
        (orderCode ? orderDateByCode.get(orderCode) : undefined) ??
        orderedDates[orderedDates.length - 1];
      const bucket = bucketMap.get(ymd);

      const nestedRefunded = toFiniteNumber(tx.refundedAmountVnd, 0);
      if (txType !== 'REFUND' && nestedRefunded > 0) {
        refundedVnd += nestedRefunded;
        if (bucket) bucket.refundedVnd += nestedRefunded;
        if (orderCode) seenRefundedOrders.add(orderCode);
      } else if (
        txType === 'REFUND' &&
        (txStatus === 'SUCCEEDED' || txStatus === 'COMPLETED' || txStatus === 'REFUNDED') &&
        (!orderCode || !seenRefundedOrders.has(orderCode))
      ) {
        const amt = toFiniteNumber(tx.amountVnd, 0);
        refundedVnd += amt;
        if (bucket) bucket.refundedVnd += amt;
      }
    }

    // 6. Aggregate RMAs within range & compute High-RMA SKUs
    let rmaCount = 0;
    interface RmaSkuAgg {
      skuId: string | null;
      skuCode: string;
      productId: string | null;
      productName: string;
      sizeCode: string | null;
      rmaCount: number;
      reasons: Record<string, number>;
    }
    const rmaSkuMap = new Map<string, RmaSkuAgg>();

    for (const rma of rmasAll) {
      const createdAtMs =
        typeof rma.createdAt === 'string' ? Date.parse(rma.createdAt) : Number.NaN;
      if (Number.isFinite(createdAtMs) && createdAtMs < cutoffMs) {
        continue;
      }
      rmaCount += 1;
      const rmaYmd = toYmd(rma.createdAt) ?? orderedDates[orderedDates.length - 1];
      const rmaBucket = bucketMap.get(rmaYmd);
      if (rmaBucket) {
        rmaBucket.rmaCount += 1;
      }

      const rawSkuId =
        typeof rma.originalSkuId === 'string'
          ? rma.originalSkuId
          : typeof rma.skuId === 'string'
            ? rma.skuId
            : null;
      const rawSkuCode =
        typeof rma.originalSkuCode === 'string'
          ? rma.originalSkuCode
          : typeof rma.skuCode === 'string'
            ? rma.skuCode
            : null;
      const rawProductId = typeof rma.productId === 'string' ? rma.productId : null;

      const catalogMeta =
        (rawSkuId ? skuMetaById.get(rawSkuId) : undefined) ??
        (rawSkuCode ? skuMetaByCode.get(rawSkuCode.toUpperCase()) : undefined);

      const resolvedSkuCode = rawSkuCode ?? catalogMeta?.skuCode ?? rawSkuId ?? 'UNKNOWN-SKU';
      const resolvedProductId = rawProductId ?? catalogMeta?.productId ?? null;
      const resolvedProductName =
        (typeof rma.productName === 'string' && rma.productName.trim()) ||
        catalogMeta?.productName ||
        (resolvedProductId ? productAvgCostById.get(resolvedProductId)?.name : undefined) ||
        resolvedSkuCode;
      const reason =
        typeof rma.reasonCode === 'string' && rma.reasonCode.trim()
          ? rma.reasonCode.trim()
          : 'OTHER';

      const key = resolvedSkuCode.toUpperCase();
      const existing = rmaSkuMap.get(key);
      if (existing) {
        existing.rmaCount += 1;
        existing.reasons[reason] = (existing.reasons[reason] ?? 0) + 1;
      } else {
        rmaSkuMap.set(key, {
          skuId: rawSkuId ?? catalogMeta?.skuId ?? null,
          skuCode: resolvedSkuCode,
          productId: resolvedProductId,
          productName: resolvedProductName,
          sizeCode: catalogMeta?.sizeCode ?? null,
          rmaCount: 1,
          reasons: { [reason]: 1 },
        });
      }
    }

    // 7. Compute final KPIs & assemble strictly permission-gated response
    const validOrderCount = Math.max(0, orderCount - cancelledOrderCount);
    const netRevenueVnd = Math.max(0, grossRevenueVnd - refundedVnd);
    const averageOrderValueVnd =
      validOrderCount > 0 ? Math.round(netRevenueVnd / validOrderCount) : 0;
    const rmaRatePct =
      validOrderCount > 0
        ? Number(((rmaCount / validOrderCount) * 100).toFixed(2))
        : 0;

    const series = orderedDates.map((ymd) => {
      const b = bucketMap.get(ymd)!;
      const dayNetRevenue = Math.max(0, Math.round(b.grossRevenueVnd - b.refundedVnd));
      const dayRefunded = Math.max(0, Math.round(b.refundedVnd));
      const dayCogs = Math.max(0, Math.round(b.cogsAccumulatorVnd));
      const dayMarginVnd = dayNetRevenue - dayCogs;
      const dayMarginPct =
        dayNetRevenue > 0
          ? Number(((dayMarginVnd / dayNetRevenue) * 100).toFixed(2))
          : 0;
      const basePoint: Record<string, unknown> = {
        date: b.date,
        label: b.label,
        orders: b.orderCount,
        orderCount: b.orderCount,
        rmaCount: b.rmaCount,
        netRevenueVnd: dayNetRevenue,
        refundedVnd: dayRefunded,
      };
      if (canReadCosts) {
        basePoint.cogsVnd = dayCogs;
        basePoint.grossMarginVnd = dayMarginVnd;
        basePoint.grossMarginPct = dayMarginPct;
      }
      return basePoint;
    });

    const topSkus = Array.from(skuSalesMap.values())
      .sort((a, b) => b.revenueVnd - a.revenueVnd || b.unitsSold - a.unitsSold)
      .slice(0, 10)
      .map((sku) => {
        const stockAvailable =
          (sku.skuId ? stockByKey.get(sku.skuId) : undefined) ??
          stockByKey.get(sku.skuCode.toUpperCase()) ??
          0;
        const skuRevenue = Math.max(0, Math.round(sku.revenueVnd));
        const skuCogs = Math.max(0, Math.round(sku.cogsAccumulatorVnd));
        const marginVnd = skuRevenue - skuCogs;
        const marginPct =
          skuRevenue > 0
            ? Number(((marginVnd / skuRevenue) * 100).toFixed(2))
            : 0;
        const entry: Record<string, unknown> = {
          skuId: sku.skuId ?? sku.skuCode,
          skuCode: sku.skuCode,
          productId: sku.productId ?? sku.skuCode,
          productName: sku.productName,
          sizeCode: sku.sizeCode,
          unitsSold: sku.unitsSold,
          quantitySold: sku.unitsSold,
          netRevenueVnd: skuRevenue,
          revenueVnd: skuRevenue,
          stockAvailable,
        };
        if (canReadCosts) {
          entry.cogsVnd = skuCogs;
          entry.grossMarginVnd = marginVnd;
          entry.grossMarginPct = marginPct;
        }
        return entry;
      });

    const highRmaSkus = Array.from(rmaSkuMap.values())
      .map((entry) => {
        const sold = skuSalesMap.get(entry.skuCode.toUpperCase())?.unitsSold ?? 0;
        const denom = Math.max(sold, entry.rmaCount);
        const ratePct =
          denom > 0 ? Number(((entry.rmaCount / denom) * 100).toFixed(2)) : 0;
        const dominantReasonCode =
          Object.entries(entry.reasons).sort((a, b) => b[1] - a[1])[0]?.[0] ?? 'OTHER';
        return {
          skuId: entry.skuId ?? entry.skuCode,
          skuCode: entry.skuCode,
          productId: entry.productId ?? entry.skuCode,
          productName: entry.productName,
          sizeCode: entry.sizeCode,
          rmaCount: entry.rmaCount,
          unitsSold: sold,
          rmaRatePct: ratePct,
          dominantReasonCode,
          topReason: dominantReasonCode,
          reasons: entry.reasons,
        };
      })
      .sort((a, b) => b.rmaCount - a.rmaCount || b.rmaRatePct - a.rmaRatePct)
      .slice(0, 10);

    const roundedNetRevenueVnd = Math.max(0, Math.round(netRevenueVnd));
    const roundedGrossRevenueVnd = Math.max(0, Math.round(grossRevenueVnd));
    const roundedRefundedVnd = Math.max(0, Math.round(refundedVnd));
    const roundedTotalCogsVnd = Math.max(0, Math.round(totalCogsAccumulatorVnd));
    const roundedGrossMarginVnd = roundedNetRevenueVnd - roundedTotalCogsVnd;
    const roundedGrossMarginPct =
      roundedNetRevenueVnd > 0
        ? Number(((roundedGrossMarginVnd / roundedNetRevenueVnd) * 100).toFixed(2))
        : 0;

    const summary: Record<string, unknown> = {
      grossRevenueVnd: roundedGrossRevenueVnd,
      netRevenueVnd: roundedNetRevenueVnd,
      refundedVnd: roundedRefundedVnd,
      orderCount,
      validOrderCount,
      completedOrderCount,
      cancelledOrderCount,
      rmaCount,
      rmaRatePct,
      averageOrderValueVnd,
      totalUnitsSold,
    };

    const biPayload: Record<string, unknown> = {
      range,
      rangeDays,
      from: cutoffIso,
      to: now.toISOString(),
      generatedAt: now.toISOString(),
      costDataRedacted: !canReadCosts,
      ...(!canReadCosts
        ? {
            redactionNotice:
              'Dữ liệu Giá vốn & Biên lợi nhuận được bảo vệ bởi Layer 5 Redaction.',
          }
        : {}),
      grossRevenueVnd: roundedGrossRevenueVnd,
      netRevenueVnd: roundedNetRevenueVnd,
      refundedVnd: roundedRefundedVnd,
      orderCount,
      validOrderCount,
      completedOrderCount,
      cancelledOrderCount,
      rmaCount,
      rmaRatePct,
      averageOrderValueVnd,
      totalUnitsSold,
      summary,
      series,
      topSkus,
      highRmaSkus,
      dataSources: {
        ordersOk: ordersRes.ok,
        rmaOk: rmaRes.ok,
        paymentsOk: txRes.ok,
        inventoryOk: stockRes.ok,
        catalogOk: catalogRes.ok,
      },
    };

    if (canReadCosts) {
      summary.cogsVnd = roundedTotalCogsVnd;
      summary.totalCogsVnd = roundedTotalCogsVnd;
      summary.grossMarginVnd = roundedGrossMarginVnd;
      summary.grossMarginPct = roundedGrossMarginPct;
      biPayload.cogsVnd = roundedTotalCogsVnd;
      biPayload.totalCogsVnd = roundedTotalCogsVnd;
      biPayload.grossMarginVnd = roundedGrossMarginVnd;
      biPayload.grossMarginPct = roundedGrossMarginPct;
    }

    const envelope = createApiResponse(biPayload, {
      correlationId,
      service: this.config.serviceName,
    });

    // Double defense-in-depth: apply Layer 5 recursive redaction over final response
    res.status(200).json(redactRestrictedFields(envelope, user.roles));
  }
}
