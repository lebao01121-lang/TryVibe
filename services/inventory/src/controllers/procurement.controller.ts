import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  CancelPurchaseOrderDtoSchema,
  ConfirmPurchaseOrderBySupplierDtoSchema,
  createApiResponse,
  CreateGoodsReceiptDtoSchema,
  CreateSupplierDtoSchema,
  ErrorCode,
  PurchaseOrderCreatedSource,
  PurchaseOrderCreatedSourceSchema,
  PurchaseOrderStatusSchema,
  RejectPurchaseOrderBySupplierDtoSchema,
  SupplierStatusSchema,
  type ApiResponse,
  type GoodsReceiptDTO,
} from '@atelier/contracts';
import {
  ApiDomainException,
  getCorrelationIdFromRequest,
  getTraceparentFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { SERVICE_NAME } from '../config/env';
import {
  ProcurementService,
  type GoodsReceiptExtendedDto,
  type PurchaseOrderExtendedDto,
  type SupplierExtendedDto,
  type SupplierPayableExtendedDto,
} from '../services/procurement.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FlexiblePoLineItemSchema = z
  .object({
    skuId: z.string().trim().min(1).optional(),
    sku: z.string().trim().min(1).optional(),
    skuCode: z.string().trim().min(1).optional(),
    productName: z.string().max(255).optional(),
    orderedQty: z.coerce.number().int().positive().max(100_000).optional(),
    quantity: z.coerce.number().int().positive().max(100_000).optional(),
    unitCostVnd: z.coerce.number().int().nonnegative(),
  })
  .refine((item) => Boolean(item.skuId || item.sku || item.skuCode), {
    message: 'Mỗi dòng PO cần có sku hoặc skuId.',
  })
  .refine((item) => (item.orderedQty ?? item.quantity ?? 0) > 0, {
    message: 'Mỗi dòng PO cần có số lượng đặt hàng (quantity / orderedQty) > 0.',
  });

const FlexibleCreatePoSchema = z
  .object({
    supplierId: z.string().trim().min(1),
    warehouseCode: z.string().trim().min(1).default('CENTRAL_WH'),
    expectedDeliveryDate: z.string().trim().min(1).optional(),
    rationale: z.string().max(600).optional(),
    note: z.string().max(600).optional(),
    notes: z.string().max(600).optional(),
    status: PurchaseOrderStatusSchema.optional(),
    createdSource: PurchaseOrderCreatedSourceSchema.default(PurchaseOrderCreatedSource.USER),
    items: z.array(FlexiblePoLineItemSchema).min(1).max(100).optional(),
    // 100% backward compatibility for single-SKU callers
    sku: z.string().trim().min(1).optional(),
    skuId: z.string().trim().min(1).optional(),
    skuCode: z.string().trim().min(1).optional(),
    productName: z.string().max(255).optional(),
    quantity: z.coerce.number().int().positive().max(100_000).optional(),
    orderedQty: z.coerce.number().int().positive().max(100_000).optional(),
    unitCostVnd: z.coerce.number().int().nonnegative().optional(),
  })
  .refine(
    (v) =>
      (Array.isArray(v.items) && v.items.length > 0) ||
      Boolean((v.sku || v.skuId || v.skuCode) && (v.quantity || v.orderedQty)),
    {
      message: 'Cần cung cấp danh sách items[] (1..N SKU) hoặc thông tin SKU đơn lẻ (sku, quantity, unitCostVnd).',
    },
  );

const FlexibleUpdateSupplierSchema = z.object({
  code: z.string().trim().min(2).max(64).optional(),
  name: z.string().trim().min(2).max(200).optional(),
  contactName: z.string().trim().max(140).nullable().optional(),
  contactEmail: z.string().trim().email().optional(),
  contactPhone: z.string().trim().max(32).nullable().optional(),
  address: z.string().trim().max(300).nullable().optional(),
  leadTimeDays: z.coerce.number().int().positive().max(180).optional(),
  paymentTermsDays: z.coerce.number().int().nonnegative().max(180).optional(),
  isActive: z.boolean().optional(),
  status: SupplierStatusSchema.optional(),
});

const FlexibleMarkPayablePaidSchema = z
  .object({
    bankReference: z.string().trim().min(2).max(160).optional(),
    paymentReference: z.string().trim().min(2).max(160).optional(),
    paidAt: z.string().trim().optional(),
    note: z.string().max(500).optional(),
    settlementNote: z.string().max(500).optional(),
    actorId: z.string().trim().max(128).optional(),
  })
  .refine((v) => Boolean(v.bankReference || v.paymentReference), {
    message: 'Cần nhập mã giao dịch chuyển khoản (bankReference).',
  });

const FlexibleAiDraftPoSchema = z.object({
  supplierId: z.string().min(1),
  warehouseCode: z.string().min(1).default('CENTRAL_WH'),
  expectedDeliveryDate: z.string().min(1).optional(),
  rationale: z.string().max(600).optional(),
  note: z.string().max(600).optional(),
  notes: z.string().max(600).optional(),
  items: z
    .array(
      z.object({
        skuId: z.string().min(1),
        skuCode: z.string().min(1).optional(),
        productName: z.string().optional(),
        orderedQty: z.number().int().positive().max(100_000),
        unitCostVnd: z.number().int().nonnegative().default(500_000),
      }),
    )
    .min(1)
    .max(100),
});

function readHeader(req: Request, key: string): string | null {
  const raw = req.headers[key.toLowerCase()];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

@Controller('v1/procurement')
export class ProcurementController {
  constructor(private readonly procurementService: ProcurementService) {}

  private requirePartnerSupplierId(req: Request): string {
    const supplierId = readHeader(req, 'x-supplier-id');
    if (!supplierId || !UUID_REGEX.test(supplierId)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thiếu thông tin định danh nhà cung cấp hợp lệ (x-supplier-id).',
      );
    }
    return supplierId;
  }

  // ============================================================================
  // Admin Procurement Endpoints
  // ============================================================================

  @Get('suppliers')
  async listSuppliers(
    @Query('status') status: string | undefined,
    @Query('isActive') isActive: string | undefined,
    @Query('q') q: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<SupplierExtendedDto[]>> {
    const data = await this.procurementService.listSuppliers({
      status,
      isActive:
        isActive === undefined
          ? undefined
          : isActive === 'true' || isActive === '1',
      q,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('suppliers')
  @HttpCode(HttpStatus.CREATED)
  async createSupplier(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<SupplierExtendedDto>> {
    const input = parseWithZod(CreateSupplierDtoSchema, body);
    const data = await this.procurementService.createSupplier(input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Patch('suppliers/:id')
  @HttpCode(HttpStatus.OK)
  async updateSupplier(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<{ before: SupplierExtendedDto; after: SupplierExtendedDto }>> {
    const input = parseWithZod(FlexibleUpdateSupplierSchema, body);
    const data = await this.procurementService.updateSupplier(id, input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('purchase-orders')
  async listPurchaseOrders(
    @Query('status') status: string | undefined,
    @Query('supplierId') supplierId: string | undefined,
    @Query('createdSource') createdSource: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto[]>> {
    const data = await this.procurementService.listPurchaseOrders({
      status,
      supplierId,
      createdSource,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('purchase-orders/:id')
  async getPurchaseOrderById(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const data = await this.procurementService.getPurchaseOrderById(id);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('purchase-orders')
  @HttpCode(HttpStatus.CREATED)
  async createPurchaseOrder(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const input = parseWithZod(FlexibleCreatePoSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = readHeader(req, 'x-user-id') ?? readHeader(req, 'x-actor-id');

    const normalizedItems =
      input.items && input.items.length > 0
        ? input.items.map((item) => ({
            skuId: (item.skuId ?? item.sku ?? item.skuCode)!,
            skuCode: item.skuCode ?? (item.sku && !UUID_REGEX.test(item.sku) ? item.sku : undefined),
            productName: item.productName,
            orderedQty: (item.orderedQty ?? item.quantity)!,
            unitCostVnd: item.unitCostVnd,
          }))
        : [
            {
              skuId: (input.skuId ?? input.sku ?? input.skuCode)!,
              skuCode:
                input.skuCode ??
                (input.sku && !UUID_REGEX.test(input.sku) ? input.sku : undefined),
              productName: input.productName,
              orderedQty: (input.orderedQty ?? input.quantity)!,
              unitCostVnd: input.unitCostVnd ?? 0,
            },
          ];

    const data = await this.procurementService.createPurchaseOrder(
      {
        supplierId: input.supplierId,
        warehouseCode: input.warehouseCode,
        expectedDeliveryDate: input.expectedDeliveryDate ?? '',
        rationale: input.rationale,
        note: input.note ?? input.notes,
        status: input.status,
        createdSource: input.createdSource,
        items: normalizedItems,
      },
      {
        forceAiDraft: false,
        actorId,
        correlationId,
        traceparent: getTraceparentFromRequest(req),
      },
    );

    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('purchase-orders/ai-draft')
  @HttpCode(HttpStatus.CREATED)
  async createAiDraftPurchaseOrder(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const input = parseWithZod(FlexibleAiDraftPoSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = readHeader(req, 'x-user-id') ?? readHeader(req, 'x-actor-id');

    const data = await this.procurementService.createPurchaseOrder(
      {
        supplierId: input.supplierId,
        warehouseCode: input.warehouseCode,
        expectedDeliveryDate: input.expectedDeliveryDate ?? '',
        rationale: input.rationale ?? input.note ?? input.notes,
        note: input.note ?? input.notes,
        createdSource: 'AI_COPILOT',
        items: input.items,
      },
      {
        forceAiDraft: true,
        actorId,
        correlationId,
        traceparent: getTraceparentFromRequest(req),
      },
    );

    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('purchase-orders/:id/submit')
  @HttpCode(HttpStatus.OK)
  async submitPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const correlationId = getCorrelationIdFromRequest(req);
    const bodyApprovedBy =
      body &&
      typeof body === 'object' &&
      'approvedByUserId' in body &&
      typeof (body as { approvedByUserId?: unknown }).approvedByUserId === 'string'
        ? (body as { approvedByUserId: string }).approvedByUserId
        : null;
    const actorId = readHeader(req, 'x-user-id') ?? bodyApprovedBy;

    const data = await this.procurementService.submitPurchaseOrder(id, {
      actorId,
      correlationId,
      traceparent: getTraceparentFromRequest(req),
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('purchase-orders/:id/cancel')
  @HttpCode(HttpStatus.OK)
  async cancelPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<{ before: PurchaseOrderExtendedDto; after: PurchaseOrderExtendedDto }>> {
    const input = parseWithZod(CancelPurchaseOrderDtoSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = input.actorId ?? readHeader(req, 'x-user-id') ?? readHeader(req, 'x-actor-id');

    const data = await this.procurementService.cancelPurchaseOrder(
      id,
      { reason: input.reason, actorId },
      { correlationId, traceparent: getTraceparentFromRequest(req) },
    );
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('purchase-orders/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<{ before: PurchaseOrderExtendedDto; after: PurchaseOrderExtendedDto }>> {
    return this.handleRejectPurchaseOrder(id, body, req);
  }

  @Get('goods-receipts')
  async listGoodsReceipts(
    @Query('supplierId') supplierId: string | undefined,
    @Query('poId') poId: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<GoodsReceiptDTO[]>> {
    const data = await this.procurementService.listGoodsReceipts({ supplierId, poId });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('goods-receipts')
  @HttpCode(HttpStatus.CREATED)
  async createGoodsReceipt(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<GoodsReceiptExtendedDto>> {
    const input = parseWithZod(CreateGoodsReceiptDtoSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = readHeader(req, 'x-user-id') ?? readHeader(req, 'x-actor-id');

    const data = await this.procurementService.createGoodsReceipt(input, {
      actorId,
      correlationId,
      traceparent: getTraceparentFromRequest(req),
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('payables')
  async listPayables(
    @Query('supplierId') supplierId: string | undefined,
    @Query('poId') poId: string | undefined,
    @Query('status') status: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<SupplierPayableExtendedDto[]>> {
    const data = await this.procurementService.listPayables({ supplierId, poId, status });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('payables/:id/mark-paid')
  @HttpCode(HttpStatus.OK)
  async markPayablePaid(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<{ before: SupplierPayableExtendedDto; after: SupplierPayableExtendedDto }>> {
    const input = parseWithZod(FlexibleMarkPayablePaidSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = input.actorId ?? readHeader(req, 'x-user-id') ?? readHeader(req, 'x-actor-id');

    const data = await this.procurementService.markPayablePaid(
      id,
      {
        bankReference: (input.bankReference ?? input.paymentReference)!,
        paidAt: input.paidAt,
        note: input.note ?? input.settlementNote,
        actorId,
      },
      { correlationId, traceparent: getTraceparentFromRequest(req) },
    );
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  // ============================================================================
  // Partner B2B Endpoints (Strict Row-Level supplier_id Isolation)
  // ============================================================================

  @Get('partner/purchase-orders')
  async listPartnerPurchaseOrders(
    @Query('status') status: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto[]>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const data = await this.procurementService.listPartnerPurchaseOrders(supplierId, status);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('partner/purchase-orders/:id')
  async getPartnerPurchaseOrder(
    @Param('id') id: string,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const data = await this.procurementService.getPartnerPurchaseOrder(supplierId, id);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('partner/purchase-orders/:id/confirm')
  @HttpCode(HttpStatus.OK)
  async confirmPartnerPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<PurchaseOrderExtendedDto>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const input = parseWithZod(ConfirmPurchaseOrderBySupplierDtoSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = readHeader(req, 'x-user-id') ?? supplierId;

    const data = await this.procurementService.confirmPartnerPurchaseOrder(supplierId, id, input, {
      actorId,
      correlationId,
    });
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('partner/purchase-orders/:id/reject')
  @HttpCode(HttpStatus.OK)
  async rejectPartnerPurchaseOrder(
    @Param('id') id: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<{ before: PurchaseOrderExtendedDto; after: PurchaseOrderExtendedDto }>> {
    return this.handleRejectPurchaseOrder(id, body, req);
  }

  @Get('partner/goods-receipts')
  async listPartnerGoodsReceipts(@Req() req: Request): Promise<ApiResponse<GoodsReceiptDTO[]>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const data = await this.procurementService.listGoodsReceipts({ supplierId });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('partner/payables')
  async listPartnerPayables(@Req() req: Request): Promise<ApiResponse<SupplierPayableExtendedDto[]>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const data = await this.procurementService.listPayables({ supplierId });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  private async handleRejectPurchaseOrder(
    id: string,
    body: unknown,
    req: Request,
  ): Promise<ApiResponse<{ before: PurchaseOrderExtendedDto; after: PurchaseOrderExtendedDto }>> {
    const input = parseWithZod(RejectPurchaseOrderBySupplierDtoSchema, body);
    const headerSupplierId = readHeader(req, 'x-supplier-id');
    const bodySupplierId = input.supplierId?.trim() || null;

    if (headerSupplierId && bodySupplierId && headerSupplierId !== bodySupplierId) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thông tin định danh nhà cung cấp (supplierId) không khớp với phiên đăng nhập.',
      );
    }

    const effectiveSupplierId = headerSupplierId ?? bodySupplierId;
    if (!effectiveSupplierId || !UUID_REGEX.test(effectiveSupplierId)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thiếu thông tin định danh nhà cung cấp hợp lệ (supplierId / x-supplier-id).',
      );
    }

    const correlationId = getCorrelationIdFromRequest(req);
    const actorId = readHeader(req, 'x-user-id') ?? effectiveSupplierId;

    const data = await this.procurementService.rejectPartnerPurchaseOrder(
      effectiveSupplierId,
      id,
      {
        reason: input.reason,
        proposedDeliveryDate: input.proposedDeliveryDate ?? null,
      },
      {
        actorId,
        correlationId,
        traceparent: getTraceparentFromRequest(req),
      },
    );

    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }
}
