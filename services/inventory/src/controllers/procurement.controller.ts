import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  ConfirmPurchaseOrderBySupplierDtoSchema,
  createApiResponse,
  CreateGoodsReceiptDtoSchema,
  CreatePurchaseOrderDtoSchema,
  ErrorCode,
  PurchaseOrderStatusSchema,
  type ApiResponse,
  type GoodsReceiptDTO,
  type SupplierDTO,
  type SupplierPayableDTO,
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
} from '../services/procurement.service';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const FlexibleCreatePoSchema = CreatePurchaseOrderDtoSchema.extend({
  status: PurchaseOrderStatusSchema.optional(),
  expectedDeliveryDate: z.string().min(1).optional(),
  notes: z.string().max(600).optional(),
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
  async listSuppliers(@Req() req: Request): Promise<ApiResponse<SupplierDTO[]>> {
    const data = await this.procurementService.listSuppliers();
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

    const data = await this.procurementService.createPurchaseOrder(
      {
        ...input,
        expectedDeliveryDate: input.expectedDeliveryDate ?? '',
        note: input.note ?? input.notes,
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
  ): Promise<ApiResponse<SupplierPayableDTO[]>> {
    const data = await this.procurementService.listPayables({ supplierId, poId, status });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
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
  async listPartnerPayables(@Req() req: Request): Promise<ApiResponse<SupplierPayableDTO[]>> {
    const supplierId = this.requirePartnerSupplierId(req);
    const data = await this.procurementService.listPayables({ supplierId });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }
}
