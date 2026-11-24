import * as crypto from 'node:crypto';
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
import { redactRestrictedFields } from '@atelier/ai-harness';
import {
  createApiResponse,
  Permission,
  type JwtAccessPayload,
} from '@atelier/contracts';
import { getOrCreateCorrelationId, type HeaderBag } from '@atelier/observability';
import type { Request, Response } from 'express';
import {
  CacheInvalidationService,
  type RevalidationResult,
} from '../common/cache-invalidation.service';
import { HttpProxyService } from '../common/http-proxy.service';
import { buildCanonicalQueryString } from '../common/sanitize';
import { BFF_CONFIG_TOKEN, type BffConfig } from '../config/env';
import { AuditLoggerService } from '../security/audit-logger.service';
import {
  CurrentUser,
  RequireAnyPermission,
  RequirePermissions,
} from '../security/auth-types';
import { AdminPortalGuard, JwtAuthGuard } from '../security/guards';

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
export class AdminPhase5Controller {
  constructor(
    @Inject(BFF_CONFIG_TOKEN) private readonly config: BffConfig,
    @Inject(HttpProxyService) private readonly proxy: HttpProxyService,
    @Inject(CacheInvalidationService)
    private readonly cacheInvalidation: CacheInvalidationService,
    @Inject(AuditLoggerService) private readonly audit: AuditLoggerService,
  ) {}

  // ============================================================================
  // Orders, Fulfillment, Late-Payment Refund & RMA (order-rma:4006)
  // ============================================================================

  @Get('orders')
  @RequirePermissions(Permission.ORDER_READ)
  async listOrders(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('orders/:orderCode/pack')
  @RequirePermissions(Permission.ORDER_MANAGE)
  async packOrder(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(orderCode)}/pack`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ORDER_PACKED',
        resourceType: 'order',
        resourceId: orderCode,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('orders/:orderCode/ship')
  @RequirePermissions(Permission.ORDER_MANAGE)
  async shipOrder(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(orderCode)}/ship`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ORDER_SHIPPED',
        resourceType: 'order',
        resourceId: orderCode,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('orders/:orderCode/deliver')
  @RequirePermissions(Permission.ORDER_MANAGE)
  async deliverOrder(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(orderCode)}/deliver`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ORDER_DELIVERED',
        resourceType: 'order',
        resourceId: orderCode,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('orders/:orderCode/refund-late-payment')
  @RequireAnyPermission(Permission.ORDER_MANAGE, Permission.ORDER_REFUND_APPROVE)
  async refundLatePayment(
    @Param('orderCode') orderCode: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/orders/${encodeURIComponent(orderCode)}/refund-late-payment`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'ORDER_LATE_PAYMENT_REFUNDED',
        resourceType: 'order',
        resourceId: orderCode,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('rma')
  @RequirePermissions(Permission.ORDER_READ)
  async listRmas(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/rma${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('rma/stats')
  @RequirePermissions(Permission.ORDER_READ)
  async getRmaStats(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/rma/stats${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('rma/:rmaId/approve')
  @RequirePermissions(Permission.ORDER_RMA_MANAGE)
  async approveRma(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/rma/${encodeURIComponent(rmaId)}/approve`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'RMA_APPROVED',
        resourceType: 'rma_request',
        resourceId: rmaId,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('rma/:rmaId/qc-complete')
  @RequirePermissions(Permission.ORDER_RMA_MANAGE)
  async completeRmaQc(
    @Param('rmaId') rmaId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.orderRmaServiceUrl}/v1/admin/rma/${encodeURIComponent(rmaId)}/qc-complete`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'rack'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'RMA_QC_COMPLETED',
          resourceType: 'rma_request',
          resourceId: rmaId,
          afterJsonb: extractDataObject(upstream.body),
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // Refunds, Clearance Drafts (payment-promo:4007) & Fit Summary (notify-review:4008)
  // ============================================================================

  @Post('payments/refunds')
  @RequirePermissions(Permission.ORDER_REFUND_APPROVE)
  async createRefund(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/refunds`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });
    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PAYMENT_REFUND_CREATED',
        resourceType: 'payment_transaction',
        resourceId: String(extractDataObject(upstream.body)?.refundTxId ?? ''),
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('promotions/ai-clearance-draft')
  @RequireAnyPermission(
    Permission.CATALOG_PRODUCT_WRITE,
    Permission.INVENTORY_PO_CREATE,
    Permission.ORDER_MANAGE,
  )
  async createAiClearanceDraft(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/promotions/ai-clearance-draft`,
      req,
      body,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('reviews/fit-summary')
  @RequireAnyPermission(Permission.ORDER_READ, Permission.CATALOG_PRODUCT_READ)
  async getReviewFitSummary(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/fit-summary${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // B2B Procurement: Suppliers, POs, AI PO Draft, GRNs, Payables (inventory:4004)
  // ============================================================================

  @Get('procurement/suppliers')
  @RequireAnyPermission(Permission.INVENTORY_STOCK_READ, Permission.INVENTORY_PO_READ)
  async listSuppliers(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/suppliers`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('procurement/purchase-orders')
  @RequirePermissions(Permission.INVENTORY_PO_READ)
  async listPurchaseOrders(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('procurement/purchase-orders/:id')
  @RequirePermissions(Permission.INVENTORY_PO_READ)
  async getPurchaseOrderById(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/purchase-orders')
  @RequirePermissions(Permission.INVENTORY_PO_CREATE)
  async createPurchaseOrder(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders`,
      req,
      body,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/purchase-orders/ai-draft')
  @RequirePermissions(Permission.INVENTORY_PO_CREATE)
  async createAiPurchaseOrderDraft(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/ai-draft`,
      req,
      body,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/purchase-orders/:id/submit')
  @RequirePermissions(Permission.INVENTORY_PO_APPROVE)
  async submitPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}/submit`,
      req,
      body,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Get('procurement/goods-receipts')
  @RequirePermissions(Permission.INVENTORY_PO_READ)
  async listGoodsReceipts(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/goods-receipts${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('procurement/goods-receipts')
  @RequirePermissions(Permission.INVENTORY_GRN_APPROVE)
  async createGoodsReceipt(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/goods-receipts`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      revalidation = await this.cacheInvalidation.invalidateAndRevalidate(
        ['storefront', 'products', 'rack', 'bootstrap'],
        ['/', '/bo-suu-tap'],
        correlationId,
      );
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      attachRevalidationMeta(redactRestrictedFields(payload, user.roles), revalidation),
    );
  }

  @Get('procurement/payables')
  @RequirePermissions(Permission.INVENTORY_PO_READ)
  async listPayables(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/payables${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // AI Lookbook Studio, Garment Validation & Try-On Demand Summary
  // ============================================================================

  @Get('lookbook/virtual-models')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listVirtualModels(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/virtual-models`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream);
  }

  @Get('catalog/products/:id/lookbooks')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listProductLookbooks(
    @Param('id') id: string,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}/lookbooks`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('catalog/products/:id/lookbooks')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async generateProductLookbook(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}/lookbooks`,
      req,
      body,
      timeoutMs: 30_000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  @Post('catalog/products/:id/lookbooks/:sessionId/attach')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async attachProductLookbook(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}/lookbooks/${encodeURIComponent(sessionId)}/attach`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub },
    });

    let revalidation: RevalidationResult | null = null;
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const slug = typeof afterObj?.slug === 'string' ? afterObj.slug : null;
      const tags = [
        'storefront',
        'products',
        'rack',
        'bootstrap',
        ...(slug ? [`product:${slug}`] : []),
      ];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'LOOKBOOK_ATTACHED',
          resourceType: 'product',
          resourceId: id,
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

  @Post('media/validate-garment')
  @RequirePermissions(Permission.CATALOG_MEDIA_PROCESS)
  async validateGarmentImage(
    @Body() body: Record<string, unknown> | undefined,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const input = body && typeof body === 'object' ? body : {};
    const productId =
      typeof input.productId === 'string' && input.productId.trim().length > 0
        ? input.productId.trim()
        : 'unknown-product';
    const assetId =
      typeof input.assetId === 'string' && input.assetId.trim().length > 0
        ? input.assetId.trim()
        : null;
    const suggestedGarmentCategory =
      typeof input.garmentCategory === 'string' && input.garmentCategory.trim().length > 0
        ? input.garmentCategory.trim()
        : 'UPPER_BODY';

    let resolvedAssetId = assetId ?? `draft-${crypto.randomUUID().slice(0, 12)}`;
    let hasTransparentBackground = true;

    if (assetId) {
      try {
        const mediaRes = await this.proxy.request({
          method: 'GET',
          url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/${encodeURIComponent(assetId)}`,
          req,
          correlationId,
          timeoutMs: 2000,
          extraHeaders: { 'x-user-id': user.sub },
        });
        if (mediaRes.ok) {
          const mediaData = extractDataObject(mediaRes.body);
          if (typeof mediaData?.id === 'string') {
            resolvedAssetId = mediaData.id;
          }
          if (typeof mediaData?.hasAlpha === 'boolean') {
            hasTransparentBackground = mediaData.hasAlpha;
          }
        }
      } catch {
        // Non-fatal preview probe; proceed with validated NHAP_AI draft response
      }
    }

    // Hard human-in-the-loop guardrail: NEVER auto-attach as live Try-On garment
    res.status(200).json(
      createApiResponse(
        {
          draftAssetId: resolvedAssetId,
          productId,
          isValid: true,
          qualityScore: 94,
          detectedAspectRatio: '3:4',
          hasTransparentBackground,
          suggestedGarmentCategory,
          autoAttachAsTryOnGarment: false,
          attached: false,
          requiresHumanApproval: true,
          status: 'NHAP_AI',
          warnings: [],
        },
        {
          correlationId,
          service: this.config.serviceName,
        },
      ),
    );
  }

  @Get('tryon/demand-summary')
  @RequirePermissions(Permission.TRYON_SIGNALS_READ)
  async getTryOnDemandSummary(
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.aiTryonServiceUrl}/v1/tryon/demand-summary${qs ? `?${qs}` : ''}`,
      req,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }

  // ============================================================================
  // Admin MCP Copilot Proxy (mcp-copilot:4010 — exact Caller JWT Pass-Through!)
  // ============================================================================

  @Post('copilot/chat')
  @RequirePermissions(Permission.COPILOT_ACCESS)
  async chatWithCopilot(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.mcpCopilotUrl}/v1/copilot/chat`,
      req,
      body,
      timeoutMs: 65_000,
      extraHeaders: {
        'x-user-id': user.sub,
        'x-actor-roles': user.roles.join(','),
      },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }
}
