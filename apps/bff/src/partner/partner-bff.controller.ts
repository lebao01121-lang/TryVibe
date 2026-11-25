import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  hasPermission,
  PARTNER_PORTAL_ROLES,
  Permission,
  Portal,
  type ApiResponse,
  type JwtAccessPayload,
  type Role,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  collectRawRequestBody,
  HttpProxyService,
} from '../common/http-proxy.service';
import { buildCanonicalQueryString } from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import { CurrentUser } from '../security/auth-types';
import { JwtAuthGuard, PartnerPortalGuard } from '../security/guards';

export interface PartnerOverviewDto {
  portal: typeof Portal.PARTNER_PORTAL;
  phase: 'v3.1.0 / Production Ready';
  supplierId: string;
  actor: {
    id: string;
    email: string;
    mfaVerified: boolean;
  };
  rbac: {
    allowedRoles: readonly Role[];
    blockedRoles: readonly string[];
    twoFactorRequired: boolean;
  };
  tenantIsolation: {
    scopeField: 'supplier_id';
    boundSupplierId: string;
    crossSupplierQueryAllowed: false;
    poApprovalRule: 'ONLY_ADMIN_APPROVED_POS_VISIBLE';
  };
  b2bSummary: {
    submissionsTotal: number;
    purchaseOrdersAwaitingConfirmation: number;
    scheduledGrnDeliveries: number;
    activeFabricLots: number;
    onTimeFulfillmentSlaPct: number;
  };
  generatedAt: string;
}

function extractPartnerDataList(body: unknown): Record<string, unknown>[] {
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

function toYmdDate(raw: unknown): string | null {
  if (typeof raw !== 'string') {
    return null;
  }
  const trimmed = raw.trim();
  if (trimmed.length < 10) {
    return null;
  }
  return trimmed.slice(0, 10);
}

@Controller('api/v1/partner')
@UseGuards(JwtAuthGuard, PartnerPortalGuard)
export class PartnerBffController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  @Get('overview')
  async getOverview(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<PartnerOverviewDto>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const supplierId = user.supplierId as string;
    const tenantHeaders = this.buildTenantHeaders(user);

    const safeGet = async (url: string) => {
      try {
        return await this.proxy.request({
          method: 'GET',
          url,
          req,
          correlationId,
          timeoutMs: 2500,
          extraHeaders: tenantHeaders,
        });
      } catch {
        return null;
      }
    };

    const [subRes, poRes, grnRes] = await Promise.all([
      safeGet(`${this.config.upstreams.catalogLookbookUrl}/v1/catalog/partner/submissions`),
      safeGet(`${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders`),
      safeGet(`${this.config.inventoryServiceUrl}/v1/procurement/partner/goods-receipts`),
    ]);

    const submissions = subRes?.ok ? extractPartnerDataList(subRes.body) : [];
    const purchaseOrders = poRes?.ok ? extractPartnerDataList(poRes.body) : [];
    const goodsReceipts = grnRes?.ok ? extractPartnerDataList(grnRes.body) : [];

    const submissionsTotal = submissions.length;

    const poById = new Map<string, Record<string, unknown>>();
    let purchaseOrdersAwaitingConfirmation = 0;
    let scheduledGrnDeliveries = 0;

    for (const po of purchaseOrders) {
      if (typeof po.id === 'string' && po.id.trim()) {
        poById.set(po.id.trim(), po);
      }
      const status = String(po.status ?? '').toUpperCase();
      if (status === 'CHO_NCC_XAC_NHAN') {
        purchaseOrdersAwaitingConfirmation += 1;
      } else if (status === 'NCC_DA_XAC_NHAN' || status === 'HOAN_TAT_MOT_PHAN') {
        scheduledGrnDeliveries += 1;
      }
    }

    const activeBatchCodes = new Set<string>();
    const todayYmd = new Date().toISOString().slice(0, 10);
    let evaluatedDeliveries = 0;
    let onTimeDeliveries = 0;

    for (const grn of goodsReceipts) {
      const items = Array.isArray(grn.items)
        ? (grn.items as Array<Record<string, unknown>>)
        : [];
      for (const item of items) {
        if (typeof item?.batchCode === 'string' && item.batchCode.trim().length > 0) {
          activeBatchCodes.add(item.batchCode.trim());
        }
      }

      const grnPoId = typeof grn.poId === 'string' ? grn.poId.trim() : '';
      const linkedPo = grnPoId ? poById.get(grnPoId) : undefined;
      const deadlineYmd =
        toYmdDate(linkedPo?.confirmedDeliveryDate) ??
        toYmdDate(linkedPo?.expectedDeliveryDate);
      const deliveredYmd = toYmdDate(grn.createdAt);

      evaluatedDeliveries += 1;
      if (!deadlineYmd || !deliveredYmd || deliveredYmd <= deadlineYmd) {
        onTimeDeliveries += 1;
      }
    }

    // Factor in open confirmed/partial POs whose promised delivery date has already passed
    for (const po of purchaseOrders) {
      const status = String(po.status ?? '').toUpperCase();
      if (status !== 'NCC_DA_XAC_NHAN' && status !== 'HOAN_TAT_MOT_PHAN') {
        continue;
      }
      const deadlineYmd =
        toYmdDate(po.confirmedDeliveryDate) ?? toYmdDate(po.expectedDeliveryDate);
      if (deadlineYmd && deadlineYmd < todayYmd) {
        evaluatedDeliveries += 1;
      }
    }

    const activeFabricLots = activeBatchCodes.size;
    const onTimeFulfillmentSlaPct =
      evaluatedDeliveries > 0
        ? Math.round((onTimeDeliveries / evaluatedDeliveries) * 1000) / 10
        : 100;

    const payload: PartnerOverviewDto = {
      portal: Portal.PARTNER_PORTAL,
      phase: 'v3.1.0 / Production Ready',
      supplierId,
      actor: {
        id: user.sub,
        email: user.email,
        mfaVerified: user.mfaVerified,
      },
      rbac: {
        allowedRoles: [...PARTNER_PORTAL_ROLES],
        blockedRoles: [
          'CUSTOMER',
          'SUPER_ADMIN',
          'CATALOG_AI_OPERATOR',
          'WAREHOUSE_MANAGER',
          'ORDER_STAFF',
        ],
        twoFactorRequired: true,
      },
      tenantIsolation: {
        scopeField: 'supplier_id',
        boundSupplierId: supplierId,
        crossSupplierQueryAllowed: false,
        poApprovalRule: 'ONLY_ADMIN_APPROVED_POS_VISIBLE',
      },
      b2bSummary: {
        submissionsTotal,
        purchaseOrdersAwaitingConfirmation,
        scheduledGrnDeliveries,
        activeFabricLots,
        onTimeFulfillmentSlaPct,
      },
      generatedAt: new Date().toISOString(),
    };

    return createApiResponse(payload, {
      correlationId,
      service: this.config.serviceName,
    });
  }

  @Get('submissions')
  async listSubmissions(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/partner/submissions${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('submissions/:id')
  async getSubmissionById(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/partner/submissions/${encodeURIComponent(id)}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('submissions')
  async createSubmission(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/partner/submissions`,
      req,
      body,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('media')
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
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/presign')
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
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/upload')
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
        extraHeaders: this.buildTenantHeaders(user),
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
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('media/:assetId/finalize')
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
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  // ============================================================================
  // B2B Procurement: POs, Confirm, GRNs, Payables (strict JWT supplierId scope)
  // ============================================================================

  @Get('purchase-orders')
  async listPartnerPurchaseOrders(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('purchase-orders/:id')
  async getPartnerPurchaseOrderById(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders/${encodeURIComponent(id)}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('purchase-orders/:id/confirm')
  async confirmPartnerPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders/${encodeURIComponent(id)}/confirm`,
      req,
      body,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Post('purchase-orders/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectPartnerPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const verifiedSupplierId = user.supplierId?.trim();
    const hasPoConfirmPerm =
      user.permissions.includes(Permission.SUPPLIER_PO_CONFIRM) ||
      hasPermission(user.roles, Permission.SUPPLIER_PO_CONFIRM);

    if (!verifiedSupplierId || !hasPoConfirmPerm) {
      res.status(403).json(
        createApiErrorResponse(
          ErrorCode.FORBIDDEN,
          'Tài khoản đối tác thiếu quyền SUPPLIER_PO_CONFIRM hoặc thiếu định danh supplierId.',
          undefined,
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const tenantHeaders = this.buildTenantHeaders(user);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders/${encodeURIComponent(id)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: tenantHeaders,
    });
    const beforeRoot =
      beforeRes.ok && beforeRes.body && typeof beforeRes.body === 'object'
        ? (beforeRes.body as Record<string, unknown>)
        : null;
    const fallbackBefore =
      beforeRoot?.data && typeof beforeRoot.data === 'object' && !Array.isArray(beforeRoot.data)
        ? (beforeRoot.data as Record<string, unknown>)
        : beforeRoot;

    const bodyObj =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    // Strictly inject verified supplierId from RS256 JWT (never trust client-supplied supplierId)
    const forwardedBody = {
      ...bodyObj,
      supplierId: verifiedSupplierId,
      actorId: user.sub,
      actorEmail: user.email,
    };

    let upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}/reject`,
      req,
      body: forwardedBody,
      correlationId,
      extraHeaders: tenantHeaders,
    });

    if (upstream.status === 404) {
      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/purchase-orders/${encodeURIComponent(id)}/reject`,
        req,
        body: forwardedBody,
        correlationId,
        extraHeaders: tenantHeaders,
      });
    }

    if (upstream.ok) {
      const upRoot =
        upstream.body && typeof upstream.body === 'object' && !Array.isArray(upstream.body)
          ? (upstream.body as Record<string, unknown>)
          : null;
      const upData =
        upRoot?.data && typeof upRoot.data === 'object' && !Array.isArray(upRoot.data)
          ? (upRoot.data as Record<string, unknown>)
          : upRoot;
      const beforeJsonb =
        upData?.before && typeof upData.before === 'object' && !Array.isArray(upData.before)
          ? (upData.before as Record<string, unknown>)
          : fallbackBefore;
      const afterJsonb =
        upData?.after && typeof upData.after === 'object' && !Array.isArray(upData.after)
          ? (upData.after as Record<string, unknown>)
          : upData;

      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PARTNER_PO_REJECTED',
        resourceType: 'purchase_order',
        resourceId: id,
        beforeJsonb,
        afterJsonb,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
        extraMetadata: { supplierId: verifiedSupplierId },
      });
    }

    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('goods-receipts')
  async listPartnerGoodsReceipts(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/goods-receipts${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('payables')
  async listPartnerPayables(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/partner/payables${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: this.buildTenantHeaders(user),
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  private buildTenantHeaders(user: JwtAccessPayload): Record<string, string> {
    // Always inject supplierId exclusively from verified RS256 JWT (never from client headers)
    return {
      'x-supplier-id': user.supplierId as string,
      'x-user-id': user.sub,
    };
  }
}
