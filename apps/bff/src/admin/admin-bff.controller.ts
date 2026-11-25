import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import { redactRestrictedFields } from '@atelier/ai-harness';
import {
  ADMIN_PORTAL_ROLES,
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  Permission,
  Portal,
  Role,
  type ApiResponse,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  CacheInvalidationService,
  type RevalidationResult,
} from '../common/cache-invalidation.service';
import {
  collectRawRequestBody,
  HttpProxyService,
} from '../common/http-proxy.service';
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

export interface AdminLedgerModuleSkeleton {
  key: string;
  label: string;
  boundedContext: string;
  status: 'active' | 'degraded';
  pendingItems: number;
}

export interface AdminOverviewLiveMetrics {
  pendingSubmissions: number;
  lowStockSkus: number;
  outOfStockSkus: number;
  activeReservations: number;
  pendingAiDraftPos: number;
  totalOrders: number;
  pendingOrders: number;
  latePaymentAlerts: number;
  pendingRmas: number;
  totalRevenueVnd: number;
}

export interface AdminOverviewDto {
  portal: typeof Portal.ADMIN_PORTAL;
  phase: 'v3.1.0 / Production Ready';
  actor: {
    id: string;
    email: string;
    roles: readonly Role[];
    mfaVerified: boolean;
  };
  rbac: {
    allowedRoles: readonly Role[];
    blockedRoles: readonly string[];
    twoFactorRequired: boolean;
    costPricePermissionRequired: readonly string[];
  };
  aiGovernance: {
    draftStatusLock: 'NHAP_AI';
    autoAttachAsTryOnGarment: false;
    requiresHumanApproval: true;
  };
  liveMetrics: AdminOverviewLiveMetrics;
  ledger: {
    title: string;
    modules: AdminLedgerModuleSkeleton[];
  };
  generatedAt: string;
}

function extractDataArray(body: unknown): Record<string, unknown>[] {
  if (!body || typeof body !== 'object') {
    return [];
  }
  const rec = body as Record<string, unknown>;
  const root = rec.data !== undefined ? rec.data : body;
  if (Array.isArray(root)) {
    return root.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
  }
  if (root && typeof root === 'object') {
    const items = (root as Record<string, unknown>).items;
    if (Array.isArray(items)) {
      return items.filter((item): item is Record<string, unknown> => Boolean(item && typeof item === 'object'));
    }
  }
  return [];
}

function toSafeInt(value: unknown): number {
  const num = Number(value);
  return Number.isFinite(num) && num >= 0 ? Math.round(num) : 0;
}

function extractDataObject(body: unknown): Record<string, unknown> | null {
  if (!body || typeof body !== 'object') {
    return null;
  }
  const rec = body as Record<string, unknown>;
  if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
    return rec.data as Record<string, unknown>;
  }
  return Array.isArray(body) ? null : rec;
}

function attachRevalidationMeta(
  body: unknown,
  revalidation: RevalidationResult | null,
): unknown {
  if (!revalidation || !body || typeof body !== 'object' || Array.isArray(body)) {
    return body;
  }
  const rec = body as Record<string, unknown>;
  const existingMeta =
    rec.meta && typeof rec.meta === 'object' && !Array.isArray(rec.meta)
      ? (rec.meta as Record<string, unknown>)
      : {};
  return {
    ...rec,
    meta: {
      ...existingMeta,
      revalidation,
    },
  };
}

const ADMIN_UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function enrichAdminReviewSentimentEnvelope(payload: unknown): unknown {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return payload;
  }
  const root = payload as Record<string, unknown>;
  const dataRec =
    root.data && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : null;
  const target = dataRec ?? root;
  if (!Array.isArray(target.reviews)) {
    return payload;
  }

  let positiveCount = 0;
  let neutralCount = 0;
  let negativeCount = 0;
  let scoreSum = 0;
  let totalScored = 0;

  const reviews = target.reviews.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      return entry;
    }
    const rec = entry as Record<string, unknown>;
    const rawScore = rec.sentimentScore ?? rec.diemCamXucNlp;
    const numericScore =
      rawScore !== null && rawScore !== undefined && Number.isFinite(Number(rawScore))
        ? Number(rawScore)
        : null;

    let sentimentLabel: 'POSITIVE' | 'NEUTRAL' | 'NEGATIVE' = 'NEUTRAL';
    if (typeof rec.sentimentLabel === 'string') {
      const upper = rec.sentimentLabel.trim().toUpperCase();
      if (upper === 'POSITIVE' || upper === 'NEUTRAL' || upper === 'NEGATIVE') {
        sentimentLabel = upper;
      }
    } else if (numericScore !== null) {
      sentimentLabel =
        numericScore >= 0.2 ? 'POSITIVE' : numericScore <= -0.2 ? 'NEGATIVE' : 'NEUTRAL';
    }

    if (sentimentLabel === 'POSITIVE') positiveCount += 1;
    else if (sentimentLabel === 'NEGATIVE') negativeCount += 1;
    else neutralCount += 1;

    if (numericScore !== null) {
      scoreSum += numericScore;
      totalScored += 1;
    }

    return {
      ...rec,
      sentimentScore: numericScore,
      diemCamXucNlp: numericScore,
      sentimentLabel,
    };
  });

  const total = reviews.length;
  const positivePct = total > 0 ? Math.round((positiveCount / total) * 100) : 0;
  const negativePct = total > 0 ? Math.round((negativeCount / total) * 100) : 0;
  const neutralPct = total > 0 ? Math.max(0, 100 - positivePct - negativePct) : 0;
  const averageSentimentScore =
    totalScored > 0 ? Math.round((scoreSum / totalScored) * 1000) / 1000 : 0;

  const existingSummary =
    target.sentimentSummary &&
    typeof target.sentimentSummary === 'object' &&
    !Array.isArray(target.sentimentSummary)
      ? (target.sentimentSummary as Record<string, unknown>)
      : null;

  const sentimentSummary = {
    positiveCount,
    neutralCount,
    negativeCount,
    positivePct,
    neutralPct,
    negativePct,
    averageSentimentScore,
    totalScored,
    ...(existingSummary ?? {}),
  };

  if (dataRec) {
    return {
      ...root,
      data: {
        ...dataRec,
        reviews,
        sentimentSummary,
      },
    };
  }

  return {
    ...root,
    reviews,
    sentimentSummary,
  };
}

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, AdminPortalGuard)
export class AdminBffController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(BffRedisService) private readonly redis: BffRedisService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  @Get('overview')
  async getOverview(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<AdminOverviewDto>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const overviewTimeoutMs = 2000;
    const isSuperAdmin = user.roles.includes(Role.SUPER_ADMIN);
    const actorHeaders = { 'x-user-id': user.sub };

    const safeGet = async (url: string, forwardReq = false) => {
      try {
        return await this.proxy.request({
          method: 'GET',
          url,
          req: forwardReq ? req : undefined,
          correlationId,
          timeoutMs: overviewTimeoutMs,
          extraHeaders: actorHeaders,
        });
      } catch {
        return null;
      }
    };

    const [
      submissionsRes,
      inventoryOpsRes,
      orderMetricsRes,
      ordersListRes,
      rmaListRes,
      mediaListRes,
      campaignRes,
      usersRes,
    ] = await Promise.all([
      safeGet(
        `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/submissions?status=PENDING_REVIEW`,
      ),
      safeGet(`${this.config.inventoryServiceUrl}/v1/inventory/ops/summary`),
      safeGet(`${this.config.orderRmaServiceUrl}/v1/admin/orders/ops-metrics`),
      safeGet(`${this.config.orderRmaServiceUrl}/v1/admin/orders?limit=200`),
      safeGet(`${this.config.orderRmaServiceUrl}/v1/admin/rma?limit=200`),
      safeGet(`${this.config.upstreams.mediaPipelineUrl}/v1/media?limit=100`),
      safeGet(`${this.config.upstreams.catalogLookbookUrl}/v1/catalog/homepage-campaign`),
      isSuperAdmin
        ? safeGet(`${this.config.upstreams.authCustomerUrl}/v1/users?limit=100`, true)
        : Promise.resolve(null),
    ]);

    const catalogOk = Boolean(submissionsRes?.ok);
    const pendingSubmissions = catalogOk ? extractDataArray(submissionsRes?.body).length : 0;

    const inventoryOk = Boolean(inventoryOpsRes?.ok);
    const invSummary = inventoryOk ? extractDataObject(inventoryOpsRes?.body) : null;
    const lowStockSkus = toSafeInt(invSummary?.lowStockCount);
    const outOfStockSkus = toSafeInt(invSummary?.outOfStockCount);
    const activeReservations = toSafeInt(invSummary?.activeReservationsCount);
    const pendingAiDraftPos = toSafeInt(invSummary?.pendingAiDraftPosCount);

    const orderMetricsOk = Boolean(orderMetricsRes?.ok);
    const orderMetrics = orderMetricsOk ? extractDataObject(orderMetricsRes?.body) : null;
    const totalOrders = toSafeInt(orderMetrics?.totalOrders);
    const latePaymentAlerts = toSafeInt(orderMetrics?.latePaymentAlertsCount);
    const totalRevenueVnd = toSafeInt(orderMetrics?.totalRevenueVnd);

    const ordersListOk = Boolean(ordersListRes?.ok);
    const ordersList = ordersListOk ? extractDataArray(ordersListRes?.body) : [];
    const actionableOrderStatuses = new Set([
      'AWAITING_PAYMENT',
      'CONFIRMED',
      'PACKING',
      'LATE_PAYMENT_NEEDS_REFUND',
    ]);
    const pendingOrders = ordersListOk
      ? ordersList.filter((ord) =>
          actionableOrderStatuses.has(String(ord.status ?? '').toUpperCase()),
        ).length
      : latePaymentAlerts;

    const rmaListOk = Boolean(rmaListRes?.ok);
    const rmaList = rmaListOk ? extractDataArray(rmaListRes?.body) : [];
    const closedRmaStatuses = new Set(['COMPLETED', 'REJECTED', 'CANCELLED', 'REFUNDED']);
    const pendingRmas = rmaListOk
      ? rmaList.filter((rma) => !closedRmaStatuses.has(String(rma.status ?? '').toUpperCase()))
          .length
      : 0;

    const orderRmaOk = orderMetricsOk || ordersListOk || rmaListOk;

    const mediaOk = Boolean(mediaListRes?.ok);
    const mediaList = mediaOk ? extractDataArray(mediaListRes?.body) : [];
    const pendingMediaAssets = mediaOk
      ? mediaList.filter((asset) => {
          const st = String(asset.status ?? '').toUpperCase();
          return st === 'PENDING' || st === 'PROCESSING' || st === 'UPLOADING';
        }).length
      : 0;

    const campaignOk = Boolean(campaignRes?.ok);
    const campaignObj = campaignOk ? extractDataObject(campaignRes?.body) : null;
    const campaignPending = campaignOk && campaignObj ? 0 : 1;

    const iamUsers = usersRes?.ok ? extractDataArray(usersRes.body) : [];
    const lockedOrPendingUsers = iamUsers.filter((u) => {
      const st = String(u.status ?? '').toUpperCase();
      return st === 'LOCKED' || st === 'PENDING';
    }).length;

    const payload: AdminOverviewDto = {
      portal: Portal.ADMIN_PORTAL,
      phase: 'v3.1.0 / Production Ready',
      actor: {
        id: user.sub,
        email: user.email,
        roles: user.roles,
        mfaVerified: user.mfaVerified,
      },
      rbac: {
        allowedRoles: [...ADMIN_PORTAL_ROLES],
        blockedRoles: ['CUSTOMER', 'SUPPLIER'],
        twoFactorRequired: true,
        costPricePermissionRequired: [
          Permission.FINANCE_COST_PRICE_READ,
          Permission.PROCUREMENT_COST_PRICE_READ,
        ],
      },
      aiGovernance: {
        draftStatusLock: 'NHAP_AI',
        autoAttachAsTryOnGarment: false,
        requiresHumanApproval: true,
      },
      liveMetrics: {
        pendingSubmissions,
        lowStockSkus,
        outOfStockSkus,
        activeReservations,
        pendingAiDraftPos,
        totalOrders,
        pendingOrders,
        latePaymentAlerts,
        pendingRmas,
        totalRevenueVnd,
      },
      ledger: {
        title: 'Sổ Cái Điều Hành — Fashion Atelier Platform v3.1.0',
        modules: [
          {
            key: 'iam-rbac-audit',
            label: 'IAM, RBAC 6 vai trò, 2FA & Nhật ký Kiểm toán',
            boundedContext: 'auth-customer',
            status: 'active',
            pendingItems: lockedOrPendingUsers,
          },
          {
            key: 'catalog-lookbook',
            label: 'Danh mục SPU / SKU & Duyệt mẫu Đối tác',
            boundedContext: 'catalog-lookbook',
            status: catalogOk ? 'active' : 'degraded',
            pendingItems: pendingSubmissions,
          },
          {
            key: 'media-pipeline',
            label: 'Dual Media Studio (2:3 Alpha & 3:4 Flat-Lay) + Anchor Calibrator',
            boundedContext: 'media-pipeline',
            status: mediaOk ? 'active' : 'degraded',
            pendingItems: pendingMediaAssets,
          },
          {
            key: 'homepage-campaign',
            label: 'Chiến dịch Trang chủ & On-Demand ISR',
            boundedContext: 'catalog-lookbook',
            status: campaignOk ? 'active' : 'degraded',
            pendingItems: campaignPending,
          },
          {
            key: 'inventory-procurement',
            label: 'Tồn kho đa kho & Giữ chỗ 15 phút (Inventory Ledger)',
            boundedContext: 'inventory',
            status: inventoryOk ? 'active' : 'degraded',
            pendingItems: lowStockSkus + outOfStockSkus + pendingAiDraftPos,
          },
          {
            key: 'order-rma',
            label: 'Đơn hàng Saga & Đổi Size RMA',
            boundedContext: 'order-rma',
            status: orderRmaOk ? 'active' : 'degraded',
            pendingItems: pendingOrders + pendingRmas,
          },
          {
            key: 'mcp-copilot',
            label: 'AI Copilot (Human-in-the-Loop)',
            boundedContext: 'mcp-copilot',
            status: inventoryOk ? 'active' : 'degraded',
            pendingItems: pendingAiDraftPos,
          },
        ],
      },
      generatedAt: new Date().toISOString(),
    };

    return createApiResponse(payload, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  // ============================================================================
  // IAM, RBAC & Audit Logs (proxied to auth-customer)
  // ============================================================================

  @Get('users')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async listUsers(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users${qs ? `?${qs}` : ''}`,
      req,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Patch('users/:id/roles')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async updateUserRoles(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users/${encodeURIComponent(id)}/roles`,
      req,
      body,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Patch('users/:id/status')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async updateUserStatus(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.authCustomerUrl}/v1/users/${encodeURIComponent(id)}/status`,
      req,
      body,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('roles')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async listRoles(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.authCustomerUrl}/v1/roles`,
      req,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Put('roles/:id/permissions')
  @RequirePermissions(Permission.ADMIN_RBAC_MANAGE)
  async updateRolePermissions(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'PUT',
      url: `${this.config.upstreams.authCustomerUrl}/v1/roles/${encodeURIComponent(id)}/permissions`,
      req,
      body,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('audit-logs')
  @RequirePermissions(Permission.ADMIN_AUDIT_READ)
  async listAuditLogs(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.authCustomerUrl}/v1/audit-logs${qs ? `?${qs}` : ''}`,
      req,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  // ============================================================================
  // Homepage Campaign CMS (SUPER_ADMIN & CATALOG_AI_OPERATOR)
  // ============================================================================

  @Get('homepage-campaign')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async getHomepageCampaign(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/homepage-campaign`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Put('homepage-campaign')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateHomepageCampaign(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);

    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/homepage-campaign`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    const beforeJsonb = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'PUT',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/homepage-campaign`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const resourceId =
        typeof afterJsonb?.id === 'string'
          ? afterJsonb.id
          : typeof beforeJsonb?.id === 'string'
            ? beforeJsonb.id
            : 'homepage_campaign_active';

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'bootstrap'],
          ['/'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'HOMEPAGE_CAMPAIGN_UPDATED',
          resourceType: 'homepage_campaign',
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
      attachRevalidationMeta(payload, revalidation),
    );
  }

  // ============================================================================
  // Catalog SPU / SKU Matrix & Partner Submissions (with Layer 5 Redaction)
  // ============================================================================

  @Get('categories')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listCategories(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories${qs ? `?${qs}` : ''}`,
      req,
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('products')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listProducts(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('products/:productId/reviews')
  @RequireAnyPermission(Permission.CATALOG_PRODUCT_READ, Permission.ORDER_READ)
  async listProductReviews(
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.proxyAdminProductReviews(productId, query, req, res, user);
  }

  @Get('catalog/products/:productId/reviews')
  @RequireAnyPermission(Permission.CATALOG_PRODUCT_READ, Permission.ORDER_READ)
  async listCatalogProductReviewsAlias(
    @Param('productId') productId: string,
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.proxyAdminProductReviews(productId, query, req, res, user);
  }

  private async proxyAdminProductReviews(
    productIdOrSlug: string,
    query: Record<string, unknown>,
    req: Request,
    res: Response,
    user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const trimmed = (productIdOrSlug || '').trim();
    if (!trimmed) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Thiếu mã hoặc slug sản phẩm.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    let resolvedId = trimmed;
    if (!ADMIN_UUID_REGEX.test(trimmed)) {
      const prodRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(trimmed)}`,
        req,
        correlationId,
        timeoutMs: 3000,
        extraHeaders: { 'x-user-id': user.sub },
      });
      const prodObj = prodRes.ok ? extractDataObject(prodRes.body) : null;
      if (!prodObj || typeof prodObj.id !== 'string' || !ADMIN_UUID_REGEX.test(prodObj.id)) {
        res.status(404).json(
          createApiErrorResponse(
            ErrorCode.NOT_FOUND,
            `Không tìm thấy sản phẩm "${trimmed}".`,
            undefined,
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }
      resolvedId = prodObj.id;
    }

    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/products/${encodeURIComponent(resolvedId)}${qs ? `?${qs}` : ''}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: { 'x-user-id': user.sub },
    });

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(enrichAdminReviewSentimentEnvelope(payload), user.roles),
    );
  }

  @Get('products/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async getProductById(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products/${encodeURIComponent(id)}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('products')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async createProduct(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const resourceId = typeof afterObj?.id === 'string' ? afterObj.id : null;
      const slug = typeof afterObj?.slug === 'string' ? afterObj.slug : null;
      const tags = ['storefront', 'products', 'rack', ...(slug ? [`product:${slug}`] : [])];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PRODUCT_CREATED',
          resourceType: 'product',
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

  @Patch('products/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateProduct(
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
      extraHeaders: { 'x-user-id': user.sub },
    });
    const beforeJsonb = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const slug =
        typeof afterJsonb?.slug === 'string'
          ? afterJsonb.slug
          : typeof beforeJsonb?.slug === 'string'
            ? beforeJsonb.slug
            : null;
      const tags = ['storefront', 'products', 'rack', ...(slug ? [`product:${slug}`] : [])];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_PRODUCT_UPDATED',
          resourceType: 'product',
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

  @Patch('skus/:id')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async updateSku(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const { sku: beforeJsonb, productSlug } = await this.findSkuBeforeSnapshot(
      id,
      req,
      correlationId,
      user.sub,
    );

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/skus/${encodeURIComponent(id)}`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const tags = [
        'storefront',
        'products',
        'rack',
        ...(productSlug ? [`product:${productSlug}`] : []),
      ];
      const paths = ['/', '/bo-suu-tap', ...(productSlug ? [`/san-pham/${productSlug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SKU_UPDATED',
          resourceType: 'sku',
          resourceId: id,
          beforeJsonb,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
          extraMetadata: {
            requestedPatch:
              body && typeof body === 'object' ? (body as Record<string, unknown>) : {},
          },
        }),
      ]);
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Get('submissions')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listSubmissions(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/submissions${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Patch('submissions/:id/review')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async reviewSubmission(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/submissions/${encodeURIComponent(id)}/review`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'ADMIN_SUBMISSION_REVIEWED',
          resourceType: 'supplier_product_submission',
          resourceId: id,
          beforeJsonb: null,
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
  // Multi-Warehouse Inventory Ledger (WAREHOUSE_MANAGER & SUPER_ADMIN)
  // ============================================================================

  @Get('inventory/warehouses')
  @RequirePermissions(Permission.INVENTORY_STOCK_READ)
  async listWarehouses(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/admin/warehouses`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('inventory/stock-levels')
  @RequirePermissions(Permission.INVENTORY_STOCK_READ)
  async listStockLevels(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/admin/stock-levels${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('inventory/reservations')
  @RequirePermissions(Permission.INVENTORY_STOCK_READ)
  async listInventoryReservations(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/admin/reservations${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('inventory/ledger')
  @RequirePermissions(Permission.INVENTORY_STOCK_READ)
  async listInventoryLedger(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/inventory/admin/ledger${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // Dual Media Studio & Visual Anchor Calibrator (proxied to media-pipeline)
  // ============================================================================

  @Get('media')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listMedia(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('media/:assetId')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async getMediaById(
    @Param('assetId') assetId: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/presign')
  @RequirePermissions(Permission.CATALOG_MEDIA_PROCESS)
  async presignMedia(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/presign`,
      req,
      body,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/upload')
  @RequirePermissions(Permission.CATALOG_MEDIA_PROCESS)
  async uploadMedia(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const contentType = req.headers['content-type'] ?? 'application/json';
    const isMultipart = contentType.toLowerCase().includes('multipart/form-data');

    if (isMultipart) {
      const rawBody = await collectRawRequestBody(req);
      const upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/upload`,
        req,
        rawBody,
        contentType,
        timeoutMs: 30_000,
        extraHeaders: { 'x-user-id': user.sub },
      });
      this.proxy.sendProxyResponse(res, upstream);
      return;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/upload`,
      req,
      body: req.body,
      contentType: 'application/json',
      timeoutMs: 30_000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/:assetId/finalize')
  @RequirePermissions(Permission.CATALOG_MEDIA_PROCESS)
  async finalizeMedia(
    @Param('assetId') assetId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}/finalize`,
      req,
      body,
      timeoutMs: 30_000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Patch('media/:assetId/spatial-metadata')
  @RequirePermissions(Permission.CATALOG_MEDIA_PROCESS)
  async updateSpatialMetadata(
    @Param('assetId') assetId: string,
    @Body() body: unknown,
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
      extraHeaders: { 'x-user-id': user.sub },
    });
    const beforeData = beforeRes.ok ? extractDataObject(beforeRes.body) : null;
    const beforeSpatial =
      beforeData?.spatialMetadata && typeof beforeData.spatialMetadata === 'object'
        ? (beforeData.spatialMetadata as Record<string, unknown>)
        : beforeData;

    const upstream = await this.proxy.request({
      method: 'PATCH',
      url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}/spatial-metadata`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterJsonb = extractDataObject(upstream.body);
      const bodyObj =
        body && typeof body === 'object' && !Array.isArray(body)
          ? (body as Record<string, unknown>)
          : {};
      const spatialPayload: Record<string, unknown> = {
        hangerAnchorX:
          typeof afterJsonb?.hangerAnchorX === 'number'
            ? afterJsonb.hangerAnchorX
            : typeof bodyObj.hangerAnchorX === 'number'
              ? bodyObj.hangerAnchorX
              : 0.5,
        hangerAnchorY:
          typeof afterJsonb?.hangerAnchorY === 'number'
            ? afterJsonb.hangerAnchorY
            : typeof bodyObj.hangerAnchorY === 'number'
              ? bodyObj.hangerAnchorY
              : 0.06,
        ...(typeof afterJsonb?.layerZHint === 'number'
          ? { layerZHint: afterJsonb.layerZHint }
          : typeof bodyObj.layerZHint === 'number'
            ? { layerZHint: bodyObj.layerZHint }
            : {}),
      };

      // Sync spatial coordinates to catalog-lookbook:4002 layer_spec_jsonb when linked to a variant/product
      const syncCatalogSpatial = async (): Promise<void> => {
        try {
          let targetProductId =
            typeof bodyObj.productId === 'string' && bodyObj.productId.trim()
              ? bodyObj.productId.trim()
              : undefined;
          let targetVariantId =
            typeof bodyObj.variantId === 'string' && bodyObj.variantId.trim()
              ? bodyObj.variantId.trim()
              : undefined;

          if (!targetVariantId) {
            const matched = await this.findVariantByRackAssetId(
              assetId,
              req,
              correlationId,
              user.sub,
            );
            targetProductId = targetProductId ?? matched.productId ?? undefined;
            targetVariantId = matched.variantId ?? undefined;
          }

          if (targetVariantId || targetProductId) {
            await this.proxy.request({
              method: 'POST',
              url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/internal/media-processed`,
              req,
              body: {
                assetId,
                ...(targetProductId ? { productId: targetProductId } : {}),
                ...(targetVariantId ? { variantId: targetVariantId } : {}),
                assetType: 'RACK_CUTOUT_2_3',
                spatialMetadata: spatialPayload,
              },
              correlationId,
              timeoutMs: 2500,
              extraHeaders: {
                'x-user-id': user.sub,
                'x-internal-secret': this.config.internalServiceSecret,
              },
            });
          }
        } catch {
          // Non-fatal: catalog-lookbook also pulls live spatial map from media-pipeline on rack-showcase
        }
      };

      const [revalResult, storefrontPatternFlushed] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'rack', 'bootstrap', 'products'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.redis.delByPatternSafe('storefront:*'),
        syncCatalogSpatial(),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'MEDIA_SPATIAL_UPDATED',
          resourceType: 'media_asset',
          resourceId: assetId,
          beforeJsonb: beforeSpatial,
          afterJsonb,
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
      revalidation = {
        ...revalResult,
        deletedKeys: revalResult.deletedKeys + storefrontPatternFlushed,
      };
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
  }

  private async findVariantByRackAssetId(
    assetId: string,
    req: Request,
    correlationId: string,
    userId: string,
  ): Promise<{ productId: string | null; variantId: string | null }> {
    try {
      const listRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products?pageSize=100`,
        req,
        correlationId,
        timeoutMs: 2500,
        extraHeaders: { 'x-user-id': userId },
      });
      if (!listRes.ok || !listRes.body || typeof listRes.body !== 'object') {
        return { productId: null, variantId: null };
      }
      const root = listRes.body as Record<string, unknown>;
      const items = Array.isArray(root.data)
        ? root.data
        : Array.isArray((root.data as Record<string, unknown> | undefined)?.items)
          ? ((root.data as Record<string, unknown>).items as unknown[])
          : [];
      for (const product of items) {
        const prodRec = product as Record<string, unknown>;
        const productId = typeof prodRec.id === 'string' ? prodRec.id : null;
        const variants = Array.isArray(prodRec?.variants)
          ? (prodRec.variants as Array<Record<string, unknown>>)
          : [];
        for (const variant of variants) {
          if (variant.rackFrontAssetId === assetId && typeof variant.id === 'string') {
            return { productId, variantId: variant.id };
          }
        }
      }
    } catch {
      // Non-fatal lookup
    }
    return { productId: null, variantId: null };
  }

  private async findSkuBeforeSnapshot(
    skuId: string,
    req: Request,
    correlationId: string,
    userId: string,
  ): Promise<{ sku: Record<string, unknown> | null; productSlug: string | null }> {
    try {
      const listRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/admin/products`,
        req,
        correlationId,
        timeoutMs: 2500,
        extraHeaders: { 'x-user-id': userId },
      });
      if (!listRes.ok || !listRes.body || typeof listRes.body !== 'object') {
        return { sku: null, productSlug: null };
      }
      const root = listRes.body as Record<string, unknown>;
      const items = Array.isArray(root.data)
        ? root.data
        : Array.isArray((root.data as Record<string, unknown> | undefined)?.items)
          ? ((root.data as Record<string, unknown>).items as unknown[])
          : [];
      for (const product of items) {
        const prodRec = product as Record<string, unknown>;
        const productSlug = typeof prodRec.slug === 'string' ? prodRec.slug : null;
        const variants = Array.isArray(prodRec?.variants)
          ? (prodRec.variants as Array<Record<string, unknown>>)
          : [];
        for (const variant of variants) {
          const skus = Array.isArray(variant.skus)
            ? (variant.skus as Array<Record<string, unknown>>)
            : [];
          const found = skus.find((sku) => sku.id === skuId);
          if (found) {
            return { sku: found, productSlug };
          }
        }
      }
    } catch {
      // Non-fatal snapshot lookup
    }
    return { sku: null, productSlug: null };
  }
}
