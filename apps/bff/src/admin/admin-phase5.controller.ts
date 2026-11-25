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
  createApiErrorResponse,
  createApiResponse,
  ErrorCode,
  Permission,
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
  type ProxyResponseResult,
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
    @Inject(BffRedisService) private readonly redis: BffRedisService,
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
    const bodyObj =
      body && typeof body === 'object' && !Array.isArray(body)
        ? (body as Record<string, unknown>)
        : {};
    const orderCode =
      typeof bodyObj.orderCode === 'string' && bodyObj.orderCode.trim()
        ? bodyObj.orderCode.trim()
        : null;

    let beforeJsonb: Record<string, unknown> | null = null;
    if (orderCode) {
      const beforeRes = await this.proxy.request({
        method: 'GET',
        url: `${this.config.paymentPromoServiceUrl}/v1/payments/transactions/${encodeURIComponent(orderCode)}`,
        req,
        correlationId,
        timeoutMs: 3000,
        extraHeaders: { 'x-user-id': user.sub },
      });
      if (beforeRes.ok) {
        const rawRoot =
          beforeRes.body && typeof beforeRes.body === 'object'
            ? (beforeRes.body as Record<string, unknown>)
            : null;
        const list = Array.isArray(rawRoot?.data) ? rawRoot.data : null;
        beforeJsonb =
          list && list.length > 0
            ? { orderCode, transactions: list }
            : extractDataObject(beforeRes.body);
      }
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.paymentPromoServiceUrl}/v1/payments/refunds`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub, 'x-user-email': user.email },
    });
    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const resolvedBefore =
        afterObj?.before && typeof afterObj.before === 'object' && !Array.isArray(afterObj.before)
          ? (afterObj.before as Record<string, unknown>)
          : beforeJsonb;
      const resolvedAfter =
        afterObj?.after && typeof afterObj.after === 'object' && !Array.isArray(afterObj.after)
          ? (afterObj.after as Record<string, unknown>)
          : afterObj;
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PAYMENT_REFUND_CREATED',
        resourceType: 'payment_transaction',
        resourceId: String(
          afterObj?.refundTxId ?? afterObj?.id ?? orderCode ?? '',
        ),
        beforeJsonb: resolvedBefore,
        afterJsonb: resolvedAfter,
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

  @Get('reviews/ops-summary')
  @RequireAnyPermission(Permission.ORDER_READ, Permission.CATALOG_PRODUCT_READ)
  async getReviewOpsSummary(
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.notifyReviewServiceUrl}/v1/reviews/ops/summary`,
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
    @Query() query: Record<string, unknown>,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const qs = buildCanonicalQueryString(query);
    const upstream = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/suppliers${qs ? `?${qs}` : ''}`,
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
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    if (user.mfaVerified !== true) {
      res.status(403).json(
        createApiErrorResponse(
          ErrorCode.MFA_REQUIRED,
          'Tạo đơn nhập hàng (PO) yêu cầu xác thực 2 lớp (2FA).',
          { roles: user.roles },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub, 'x-user-email': user.email },
    });

    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const resourceId =
        typeof afterObj?.id === 'string'
          ? afterObj.id
          : typeof afterObj?.poCode === 'string'
            ? afterObj.poCode
            : null;
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_PO_CREATED',
        resourceType: 'purchase_order',
        resourceId,
        beforeJsonb: null,
        afterJsonb: afterObj,
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

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
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const beforeRes = await this.proxy.request({
      method: 'GET',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}`,
      req,
      correlationId,
      timeoutMs: 3000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    const beforeJsonb = beforeRes.ok ? extractDataObject(beforeRes.body) : null;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.inventoryServiceUrl}/v1/procurement/purchase-orders/${encodeURIComponent(id)}/submit`,
      req,
      body,
      correlationId,
      extraHeaders: { 'x-user-id': user.sub, 'x-user-email': user.email },
    });

    if (upstream.ok) {
      await this.audit.record({
        actorId: user.sub,
        actorEmail: user.email,
        action: 'PROCUREMENT_PO_SUBMITTED',
        resourceType: 'purchase_order',
        resourceId: id,
        beforeJsonb,
        afterJsonb: extractDataObject(upstream.body),
        correlationId,
        ipAddress: this.proxy.extractClientIp(req),
      });
    }

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
      const afterObj = extractDataObject(upstream.body);
      const resourceId =
        typeof afterObj?.id === 'string'
          ? afterObj.id
          : typeof afterObj?.grnNumber === 'string'
            ? afterObj.grnNumber
            : null;
      const [revalResult] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(
          ['storefront', 'products', 'rack', 'bootstrap'],
          ['/', '/bo-suu-tap'],
          correlationId,
        ),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'PROCUREMENT_GRN_CREATED',
          resourceType: 'goods_receipt',
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

  @Get('catalog/products')
  @RequirePermissions(Permission.CATALOG_PRODUCT_READ)
  async listCatalogProductsAlias(
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
    this.proxy.sendProxyResponse(res, upstream, (payload) => {
      const redacted = redactRestrictedFields(payload, user.roles);
      if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        const rec = redacted as Record<string, unknown>;
        if (Array.isArray(rec.data)) {
          return {
            ...rec,
            data: rec.data.map((entry) => {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry;
              const s = entry as Record<string, unknown>;
              const isAttached =
                Boolean(s.approvedForGallery) || String(s.status ?? '') === 'ATTACHED';
              return {
                ...s,
                autoAttach: false,
                autoAttachAsTryOnGarment: false,
                requiresHumanApproval: !isAttached,
              };
            }),
          };
        }
      }
      return redacted;
    });
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
    // Hard Human-in-the-Loop lock: generated Lookbook drafts ALWAYS default to autoAttach=false
    const sanitizedBody: Record<string, unknown> =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : {};
    sanitizedBody.autoAttach = false;
    sanitizedBody.autoAttachAsTryOnGarment = false;
    sanitizedBody.requiresHumanApproval = true;

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.upstreams.catalogLookbookUrl}/v1/catalog/products/${encodeURIComponent(id)}/lookbooks`,
      req,
      body: sanitizedBody,
      timeoutMs: 30_000,
      extraHeaders: { 'x-user-id': user.sub },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) => {
      const redacted = redactRestrictedFields(payload, user.roles);
      if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        const rec = redacted as Record<string, unknown>;
        if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
          return {
            ...rec,
            data: {
              ...(rec.data as Record<string, unknown>),
              autoAttach: false,
              autoAttachAsTryOnGarment: false,
              requiresHumanApproval: true,
              approvedForGallery: false,
              draftStatus: 'NHAP_AI',
            },
          };
        }
      }
      return redacted;
    });
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
    await this.executeLookbookApproveAndAttach(id, sessionId, body, req, res, user);
  }

  @Post('catalog/products/:id/lookbooks/:sessionId/approve')
  @RequirePermissions(Permission.CATALOG_PRODUCT_WRITE)
  async approveAndAttachProductLookbook(
    @Param('id') id: string,
    @Param('sessionId') sessionId: string,
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    await this.executeLookbookApproveAndAttach(id, sessionId, body, req, res, user);
  }

  private async executeLookbookApproveAndAttach(
    id: string,
    sessionId: string,
    body: unknown,
    req: Request,
    res: Response,
    user: JwtAccessPayload,
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
    let prewarmInfo: {
      cacheSha256: string;
      prewarmCacheKey: string;
      restyleCacheKey: string;
      prewarmed: boolean;
      storefrontPatternFlushed: number;
    } | null = null;

    if (upstream.ok) {
      const afterObj = extractDataObject(upstream.body);
      const sessionObj =
        afterObj?.session && typeof afterObj.session === 'object' && !Array.isArray(afterObj.session)
          ? (afterObj.session as Record<string, unknown>)
          : null;
      const slug =
        typeof afterObj?.productSlug === 'string'
          ? afterObj.productSlug
          : typeof afterObj?.slug === 'string'
            ? afterObj.slug
            : null;
      const attachedImageUrl =
        typeof afterObj?.attachedImageUrl === 'string'
          ? afterObj.attachedImageUrl
          : typeof sessionObj?.resultUrl === 'string'
            ? sessionObj.resultUrl
            : '';
      const variantId =
        typeof sessionObj?.variantId === 'string' ? sessionObj.variantId : 'default';
      const virtualModelCode =
        typeof sessionObj?.virtualModelCode === 'string'
          ? sessionObj.virtualModelCode
          : 'MODEL_VN_FEMALE_01';

      // 1. Pre-warm deterministic SHA-256 Redis cache on :6379 for instant Try-On / Lookbook hits
      const cacheSha256 = crypto
        .createHash('sha256')
        .update(`${id}|${variantId}|${virtualModelCode}|${attachedImageUrl}`)
        .digest('hex');
      const prewarmCacheKey = `tryon:lookbook:sha256:${cacheSha256}`;
      const restyleCacheKey = `lookbook:restyle:${slug ?? id}:${variantId}`;
      const prewarmPayload = JSON.stringify({
        productId: id,
        productSlug: slug,
        variantId,
        sessionId,
        virtualModelCode,
        attachedImageUrl,
        cacheSha256,
        approvedBy: user.sub,
        prewarmedAt: new Date().toISOString(),
      });

      const tags = [
        'storefront',
        'products',
        'rack',
        'bootstrap',
        'seasons',
        ...(slug ? [`product:${slug}`] : []),
      ];
      const paths = ['/', '/bo-suu-tap', ...(slug ? [`/san-pham/${slug}`] : [])];

      const [revalResult, storefrontPatternFlushed, prewarmOk] = await Promise.all([
        this.cacheInvalidation.invalidateAndRevalidate(tags, paths, correlationId),
        this.redis.delByPatternSafe('storefront:*'),
        this.redis
          .setSafe(prewarmCacheKey, prewarmPayload, 86_400)
          .then(async (ok1) => {
            const ok2 = await this.redis.setSafe(restyleCacheKey, prewarmPayload, 86_400);
            return ok1 || ok2;
          }),
        this.audit.record({
          actorId: user.sub,
          actorEmail: user.email,
          action: 'LOOKBOOK_ATTACHED',
          resourceType: 'product',
          resourceId: id,
          afterJsonb: {
            ...(afterObj ?? {}),
            cacheSha256,
            prewarmCacheKey,
            restyleCacheKey,
          },
          correlationId,
          ipAddress: this.proxy.extractClientIp(req),
        }),
      ]);

      revalidation = {
        ...revalResult,
        deletedKeys: revalResult.deletedKeys + storefrontPatternFlushed,
      };
      prewarmInfo = {
        cacheSha256,
        prewarmCacheKey,
        restyleCacheKey,
        prewarmed: prewarmOk,
        storefrontPatternFlushed,
      };
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) => {
      const redacted = redactRestrictedFields(payload, user.roles);
      let enriched = redacted;
      if (prewarmInfo && redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        const rec = redacted as Record<string, unknown>;
        if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
          enriched = {
            ...rec,
            data: {
              ...(rec.data as Record<string, unknown>),
              prewarm: prewarmInfo,
              cacheSha256: prewarmInfo.cacheSha256,
              prewarmCacheKey: prewarmInfo.prewarmCacheKey,
              revalidated: revalidation?.revalidated ?? false,
            },
          };
        }
      }
      return attachRevalidationMeta(enriched, revalidation);
    });
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
    const contentType = String(req.headers['content-type'] ?? 'application/json');
    const lowerContentType = contentType.toLowerCase();
    const isMultipart = lowerContentType.includes('multipart/form-data');
    const isRawBinary =
      lowerContentType.startsWith('image/') ||
      lowerContentType.includes('application/octet-stream');

    const input =
      !isMultipart && !isRawBinary && body && typeof body === 'object' && !Array.isArray(body)
        ? body
        : {};

    const productId =
      typeof input.productId === 'string' && input.productId.trim().length > 0
        ? input.productId.trim()
        : typeof req.query?.productId === 'string' && req.query.productId.trim().length > 0
          ? req.query.productId.trim()
          : 'unknown-product';
    const assetId =
      typeof input.assetId === 'string' && input.assetId.trim().length > 0
        ? input.assetId.trim()
        : null;
    const suggestedGarmentCategory =
      typeof input.garmentCategory === 'string' && input.garmentCategory.trim().length > 0
        ? input.garmentCategory.trim()
        : 'UPPER_BODY';

    let upstream: ProxyResponseResult;
    if (isMultipart || isRawBinary) {
      let rawBody: Buffer;
      try {
        rawBody = await collectRawRequestBody(req, 15 * 1024 * 1024);
      } catch {
        res.status(413).json(
          createApiErrorResponse(
            ErrorCode.VALIDATION_ERROR,
            'Kích thước tệp ảnh trang phục vượt quá giới hạn tối đa 15MB.',
            undefined,
            { correlationId, service: this.config.serviceName },
          ),
        );
        return;
      }

      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/validate-garment`,
        req,
        rawBody,
        contentType,
        correlationId,
        timeoutMs: 30_000,
        extraHeaders: { 'x-user-id': user.sub },
      });
    } else {
      const forwardedBody: Record<string, unknown> = { ...input };
      if (
        typeof forwardedBody.fileBase64 === 'string' &&
        !forwardedBody.imageBase64
      ) {
        forwardedBody.imageBase64 = forwardedBody.fileBase64;
      }
      upstream = await this.proxy.request({
        method: 'POST',
        url: `${this.config.upstreams.mediaPipelineUrl}/v1/media/validate-garment`,
        req,
        body: forwardedBody,
        contentType: 'application/json',
        correlationId,
        timeoutMs: 30_000,
        extraHeaders: { 'x-user-id': user.sub },
      });
    }

    if (!upstream.ok) {
      this.proxy.sendProxyResponse(res, upstream, (payload) =>
        redactRestrictedFields(payload, user.roles),
      );
      return;
    }

    const analysis = extractDataObject(upstream.body) ?? {};
    const metricsObj =
      analysis.metrics && typeof analysis.metrics === 'object' && !Array.isArray(analysis.metrics)
        ? (analysis.metrics as Record<string, unknown>)
        : {};
    const warnings = Array.isArray(analysis.warnings)
      ? analysis.warnings.map((w) => String(w))
      : [];

    // Reject spoofed/non-image Magic Bytes with HTTP 400 INVALID_MAGIC_BYTES when raw bytes were provided
    const isDirectBufferCheck =
      analysis.source === 'buffer' ||
      isMultipart ||
      isRawBinary ||
      typeof input.fileBase64 === 'string' ||
      typeof input.imageBase64 === 'string' ||
      typeof input.dataUrl === 'string';

    if (isDirectBufferCheck && metricsObj.magicBytesValid === false) {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.INVALID_MAGIC_BYTES,
          warnings[0] ||
            'Tệp ảnh 3:4 không đạt kiểm định Magic Bytes (chỉ chấp nhận JPEG, PNG hoặc WebP thực).',
          {
            reason: 'INVALID_MAGIC_BYTES',
            isValid: false,
            qualityScore: 0,
            warnings,
            metrics: metricsObj,
          },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const resolvedAssetId =
      (typeof analysis.resolvedAssetId === 'string' && analysis.resolvedAssetId.trim()) ||
      assetId ||
      `draft-${crypto.randomUUID().slice(0, 12)}`;
    const hasAlpha = Boolean(analysis.hasAlpha);
    const cornerTransparencyRatio = Number(analysis.cornerTransparencyRatio ?? 0);
    const hasTransparentBackground = hasAlpha && cornerTransparencyRatio >= 0.6;

    // Hard human-in-the-loop guardrail (Layer 6): NEVER auto-attach as live Try-On garment
    res.status(200).json(
      createApiResponse(
        {
          draftAssetId: resolvedAssetId,
          productId,
          isValid: Boolean(analysis.isValid),
          qualityScore: Number(analysis.qualityScore ?? 0),
          detectedAspectRatio: String(analysis.detectedAspectRatio ?? 'unknown'),
          width: Number(analysis.width ?? 0),
          height: Number(analysis.height ?? 0),
          aspectRatio: Number(analysis.aspectRatio ?? 0),
          hasAlpha,
          hasTransparentBackground,
          cornerTransparencyRatio,
          sharpnessScore: Number(analysis.sharpnessScore ?? 0),
          contrastScore: Number(analysis.contrastScore ?? 0),
          edgeClipped: Boolean(analysis.edgeClipped),
          suggestedGarmentCategory,
          autoAttach: false,
          autoAttachAsTryOnGarment: false,
          attached: false,
          requiresHumanApproval: true,
          status: 'NHAP_AI',
          warnings,
          metrics: metricsObj,
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
    const [upstream, rawSignalsRes] = await Promise.all([
      this.proxy.request({
        method: 'GET',
        url: `${this.config.aiTryonServiceUrl}/v1/tryon/demand-summary${qs ? `?${qs}` : ''}`,
        req,
        extraHeaders: { 'x-user-id': user.sub },
      }),
      this.proxy
        .request({
          method: 'GET',
          url: `${this.config.aiTryonServiceUrl}/v1/tryon/signals?limit=500`,
          req,
          timeoutMs: 3000,
          extraHeaders: { 'x-user-id': user.sub },
        })
        .catch(() => null),
    ]);

    const signalCounts = {
      MO_PHONG_THU: 0,
      THU_THANH_CONG: 0,
      THEM_GIO_SAU_THU: 0,
      MUA_SAU_THU: 0,
    };

    if (rawSignalsRes?.ok) {
      const rawData = extractDataObject(rawSignalsRes.body);
      const events = Array.isArray(rawData?.items)
        ? (rawData.items as Array<Record<string, unknown>>)
        : [];
      for (const ev of events) {
        const sig = String(ev.signalType ?? ev.eventType ?? '').toUpperCase();
        if (sig === 'MO_PHONG_THU' || sig === 'OPEN_MODAL') {
          signalCounts.MO_PHONG_THU += 1;
        } else if (sig === 'THU_THANH_CONG' || sig === 'TRYON_COMPLETED') {
          signalCounts.THU_THANH_CONG += 1;
        } else if (sig === 'THEM_GIO_SAU_THU' || sig === 'ADD_TO_CART_AFTER_TRYON') {
          signalCounts.THEM_GIO_SAU_THU += 1;
        } else if (sig === 'MUA_SAU_THU' || sig === 'PURCHASE_AFTER_TRYON') {
          signalCounts.MUA_SAU_THU += 1;
        }
      }
    }

    this.proxy.sendProxyResponse(res, upstream, (payload) => {
      const redacted = redactRestrictedFields(payload, user.roles);
      if (redacted && typeof redacted === 'object' && !Array.isArray(redacted)) {
        const rec = redacted as Record<string, unknown>;
        if (rec.data && typeof rec.data === 'object' && !Array.isArray(rec.data)) {
          const dataObj = rec.data as Record<string, unknown>;
          const rawItems = Array.isArray(dataObj.items)
            ? (dataObj.items as Array<Record<string, unknown>>)
            : [];
          const enrichedItems: Array<Record<string, unknown>> = rawItems.map((it) => {
            const sessions = Number(it.tryOnSessions ?? 0) || 0;
            const atc = Number(it.addToCartCount ?? 0) || 0;
            const ratePct =
              typeof it.tryOnToCartRatePct === 'number'
                ? it.tryOnToCartRatePct
                : sessions > 0
                  ? Number(((atc / sessions) * 100).toFixed(2))
                  : 0;
            const rateRatio = Number((ratePct / 100).toFixed(4));
            return {
              ...it,
              tryOnToCartRatePct: ratePct,
              tryOnToCartRate: rateRatio,
            };
          });

          const totalTryOns =
            signalCounts.THU_THANH_CONG ||
            enrichedItems.reduce((acc, it) => acc + (Number(it.tryOnSessions) || 0), 0);
          const totalAtc =
            signalCounts.THEM_GIO_SAU_THU ||
            enrichedItems.reduce((acc, it) => acc + (Number(it.addToCartCount) || 0), 0);
          const overallRatePct =
            totalTryOns > 0 ? Number(((totalAtc / totalTryOns) * 100).toFixed(2)) : 0;

          return {
            ...rec,
            data: {
              ...dataObj,
              items: enrichedItems,
              signalCounts: {
                ...signalCounts,
                THU_THANH_CONG: totalTryOns,
                THEM_GIO_SAU_THU: totalAtc,
              },
              tryOnToCartRate: Number((overallRatePct / 100).toFixed(4)),
              tryOnToCartRatePct: overallRatePct,
            },
          };
        }
      }
      return redacted;
    });
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

  @Post('copilot/feedback')
  @RequirePermissions(Permission.COPILOT_ACCESS)
  async submitCopilotFeedback(
    @Body() body: unknown,
    @Req() req: Request,
    @Res() res: Response,
    @CurrentUser() user: JwtAccessPayload,
  ): Promise<void> {
    const correlationId = getOrCreateCorrelationId(req.headers as HeaderBag);
    const bodyObj =
      body && typeof body === 'object' && !Array.isArray(body)
        ? { ...(body as Record<string, unknown>) }
        : {};

    const normalizedRating =
      typeof bodyObj.rating === 'string' ? bodyObj.rating.trim().toUpperCase() : '';
    if (normalizedRating !== 'UP' && normalizedRating !== 'DOWN') {
      res.status(400).json(
        createApiErrorResponse(
          ErrorCode.VALIDATION_ERROR,
          'Trường rating phải là "UP" hoặc "DOWN".',
          { rating: bodyObj.rating },
          { correlationId, service: this.config.serviceName },
        ),
      );
      return;
    }

    const promptText =
      typeof bodyObj.promptText === 'string'
        ? bodyObj.promptText
        : typeof bodyObj.prompt === 'string'
          ? bodyObj.prompt
          : undefined;
    const responseText =
      typeof bodyObj.responseText === 'string'
        ? bodyObj.responseText
        : typeof bodyObj.response === 'string'
          ? bodyObj.response
          : undefined;
    const portal =
      typeof bodyObj.portal === 'string' && bodyObj.portal.trim().length > 0
        ? bodyObj.portal.trim()
        : 'ADMIN_PORTAL';
    const traceId =
      typeof bodyObj.traceId === 'string' && bodyObj.traceId.trim().length > 0
        ? bodyObj.traceId.trim()
        : correlationId;

    const forwardedBody: Record<string, unknown> = {
      ...bodyObj,
      traceId,
      rating: normalizedRating,
      portal,
      ...(promptText !== undefined ? { promptText, prompt: promptText } : {}),
      ...(responseText !== undefined ? { responseText, response: responseText } : {}),
    };

    const upstream = await this.proxy.request({
      method: 'POST',
      url: `${this.config.mcpCopilotUrl}/v1/copilot/feedback`,
      req,
      body: forwardedBody,
      correlationId,
      timeoutMs: 15_000,
      extraHeaders: {
        'x-user-id': user.sub,
        'x-actor-roles': user.roles.join(','),
        'x-user-email': user.email,
      },
    });
    this.proxy.sendProxyResponse(res, upstream, (payload) =>
      redactRestrictedFields(payload, user.roles),
    );
  }
}
