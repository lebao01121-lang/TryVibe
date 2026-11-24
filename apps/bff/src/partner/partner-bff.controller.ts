import {
  Body,
  Controller,
  Get,
  Inject,
  Param,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import {
  createApiResponse,
  PARTNER_PORTAL_ROLES,
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
import { CurrentUser } from '../security/auth-types';
import { JwtAuthGuard, PartnerPortalGuard } from '../security/guards';

export interface PartnerOverviewDto {
  portal: typeof Portal.PARTNER_PORTAL;
  phase: 'phase-1';
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

@Controller('api/v1/partner')
@UseGuards(JwtAuthGuard, PartnerPortalGuard)
export class PartnerBffController {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
  ) {}

  @Get('overview')
  async getOverview(
    @Req() req: Request,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<ApiResponse<PartnerOverviewDto>> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const supplierId = user.supplierId as string;

    let submissionsTotal = 0;
    try {
      const subRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/partner/submissions`,
        req,
        correlationId,
        timeoutMs: 2500,
        extraHeaders: this.buildTenantHeaders(user),
      });
      if (subRes.ok && subRes.body && typeof subRes.body === 'object') {
        const data = (subRes.body as Record<string, unknown>).data;
        if (Array.isArray(data)) {
          submissionsTotal = data.length;
        }
      }
    } catch {
      // Graceful fallback
    }

    const payload: PartnerOverviewDto = {
      portal: Portal.PARTNER_PORTAL,
      phase: 'phase-1',
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
        purchaseOrdersAwaitingConfirmation: 0,
        scheduledGrnDeliveries: 0,
        activeFabricLots: 0,
        onTimeFulfillmentSlaPct: 100,
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
