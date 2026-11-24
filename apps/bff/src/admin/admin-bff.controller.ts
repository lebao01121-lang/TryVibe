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
  createApiResponse,
  Permission,
  Portal,
  type ApiResponse,
  type JwtAccessPayload,
  type Role,
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
import { buildCanonicalQueryString } from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import { CurrentUser, RequirePermissions } from '../security/auth-types';
import { AdminPortalGuard, JwtAuthGuard } from '../security/guards';

export interface AdminLedgerModuleSkeleton {
  key: string;
  label: string;
  boundedContext: string;
  status: 'active' | 'skeleton_ready';
  pendingItems: number;
}

export interface AdminOverviewDto {
  portal: typeof Portal.ADMIN_PORTAL;
  phase: 'phase-3';
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
  ledger: {
    title: string;
    modules: AdminLedgerModuleSkeleton[];
  };
  generatedAt: string;
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

@Controller('api/v1/admin')
@UseGuards(JwtAuthGuard, AdminPortalGuard)
export class AdminBffController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  @Get('overview')
  getOverview(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): ApiResponse<AdminOverviewDto> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);

    const payload: AdminOverviewDto = {
      portal: Portal.ADMIN_PORTAL,
      phase: 'phase-3',
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
      ledger: {
        title: 'Sổ Cái Điều Hành — Fashion Atelier Platform v3.0',
        modules: [
          {
            key: 'iam-rbac-audit',
            label: 'IAM, RBAC 6 vai trò, 2FA & Nhật ký Kiểm toán',
            boundedContext: 'auth-customer',
            status: 'active',
            pendingItems: 0,
          },
          {
            key: 'catalog-lookbook',
            label: 'Danh mục SPU / SKU & Duyệt mẫu Đối tác',
            boundedContext: 'catalog-lookbook',
            status: 'active',
            pendingItems: 0,
          },
          {
            key: 'media-pipeline',
            label: 'Dual Media Studio (2:3 Alpha & 3:4 Flat-Lay) + Anchor Calibrator',
            boundedContext: 'media-pipeline',
            status: 'active',
            pendingItems: 0,
          },
          {
            key: 'homepage-campaign',
            label: 'Chiến dịch Trang chủ & On-Demand ISR',
            boundedContext: 'catalog-lookbook',
            status: 'active',
            pendingItems: 0,
          },
          {
            key: 'inventory-procurement',
            label: 'Tồn kho đa kho & Giữ chỗ 15 phút (Inventory Ledger)',
            boundedContext: 'inventory',
            status: 'active',
            pendingItems: 0,
          },
          {
            key: 'order-rma',
            label: 'Đơn hàng Saga & Đổi Size RMA',
            boundedContext: 'order-rma',
            status: 'skeleton_ready',
            pendingItems: 0,
          },
          {
            key: 'mcp-copilot',
            label: 'AI Copilot (Human-in-the-Loop)',
            boundedContext: 'mcp-copilot',
            status: 'active',
            pendingItems: 0,
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
  async listCategories(@Req() req: Request, @Res() res: Response): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/categories`,
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
    this.proxy.sendProxyResponse(res, upstream);
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
    this.proxy.sendProxyResponse(res, upstream);
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
    this.proxy.sendProxyResponse(res, upstream);
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
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'rack', 'bootstrap'],
          ['/'],
          correlationId,
        ),
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
      revalidation = revalResult;
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(payload, revalidation),
    );
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
