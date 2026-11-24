import * as crypto from 'node:crypto';
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
} from '@nestjs/common';
import type { Request } from 'express';
import { z } from 'zod';
import {
  BatchAvailabilityRequestSchema,
  createApiResponse,
  ErrorCode,
  InventoryLedgerReason,
  ReserveStockRequestSchema,
  type ApiResponse,
  type BatchAvailabilityResponse,
  type ReserveStockResponse,
  type StockReservationAdminDto,
} from '@atelier/contracts';
import {
  ApiDomainException,
  getCorrelationIdFromRequest,
  getTraceparentFromRequest,
  parseWithZod,
} from '../common/api-exception';
import { INVENTORY_CONFIG_TOKEN, SERVICE_NAME, type InventoryConfig } from '../config/env';
import {
  InventoryService,
  type ExpireSweepResult,
  type InventoryOpsSummaryDto,
  type LedgerAdminViewDto,
  type RmaRestockResult,
  type StockLevelAdminExtendedDto,
  type SyncCatalogSkusResult,
  type WarehouseAdminViewDto,
} from '../services/inventory.service';

const OptionalCommitBodySchema = z
  .object({
    reservationId: z.string().min(1).optional(),
    referenceId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .optional();

const OptionalReleaseBodySchema = z
  .object({
    reservationId: z.string().min(1).optional(),
    referenceId: z.string().min(1).optional(),
    reason: z
      .enum([InventoryLedgerReason.RELEASE_EXPIRED, InventoryLedgerReason.CANCEL_RELEASE])
      .default(InventoryLedgerReason.CANCEL_RELEASE),
  })
  .optional();

const TestSetStockSchema = z.object({
  skuId: z.string().trim().min(1),
  availableQty: z.number().int().nonnegative(),
  reservedQty: z.number().int().nonnegative().optional(),
  committedQty: z.number().int().nonnegative().optional(),
  warehouseCode: z.string().trim().min(1).optional(),
  productId: z.string().trim().min(1).optional(),
});

const TestExpireReservationSchema = z
  .object({
    referenceId: z.string().trim().min(1).optional(),
    reservationId: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.referenceId || v.reservationId), {
    message: 'Either referenceId or reservationId is required',
  });

const SyncCatalogSkusSchema = z.object({
  skus: z
    .array(
      z.object({
        skuId: z.string().trim().min(1),
        skuCode: z.string().trim().min(1).optional(),
        productId: z.string().trim().min(1),
        sizeCode: z.string().trim().optional(),
        defaultQty: z.number().int().nonnegative().optional(),
      }),
    )
    .max(1000),
});

const RmaRestockSchema = z.object({
  skuId: z.string().trim().min(1),
  qty: z.number().int().positive().default(1),
  restockable: z.boolean().default(true),
  warehouseCode: z.string().trim().min(1).optional(),
  referenceId: z.string().trim().min(1).optional(),
  note: z.string().max(400).optional(),
});

function timingSafeSecretEquals(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) {
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

@Controller('v1/inventory')
export class InventoryApiController {
  constructor(
    @Inject(INVENTORY_CONFIG_TOKEN) private readonly config: InventoryConfig,
    private readonly inventoryService: InventoryService,
  ) {}

  private assertInternalSecret(req: Request): void {
    const raw = req.headers['x-internal-secret'];
    const candidate = (Array.isArray(raw) ? raw[0] : raw)?.trim() ?? '';
    if (!candidate || !timingSafeSecretEquals(candidate, this.config.internalServiceSecret)) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Thiếu hoặc sai mã xác thực nội bộ (x-internal-secret).',
      );
    }
  }

  @Post('availability/batch')
  @HttpCode(HttpStatus.OK)
  async getBatchAvailability(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<BatchAvailabilityResponse>> {
    const input = parseWithZod(BatchAvailabilityRequestSchema, body);
    const data = await this.inventoryService.getBatchAvailability(input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('reservations')
  @HttpCode(HttpStatus.CREATED)
  async reserveStock(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<ReserveStockResponse>> {
    const correlationId = getCorrelationIdFromRequest(req);
    const rawHeaderKey = req.headers['idempotency-key'];
    const headerKey = Array.isArray(rawHeaderKey) ? rawHeaderKey[0] : rawHeaderKey;

    const mergedBody =
      body && typeof body === 'object' && !Array.isArray(body)
        ? {
            ...(headerKey && !('idempotencyKey' in body) ? { idempotencyKey: headerKey } : {}),
            ...(body as Record<string, unknown>),
          }
        : body;

    const input = parseWithZod(ReserveStockRequestSchema, mergedBody);
    const data = await this.inventoryService.reserveStock(input, correlationId);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('reservations/:referenceId/commit')
  @HttpCode(HttpStatus.OK)
  async commitReservation(
    @Param('referenceId') referenceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<ReserveStockResponse>> {
    const parsedBody =
      body && typeof body === 'object' && Object.keys(body as Record<string, unknown>).length > 0
        ? parseWithZod(OptionalCommitBodySchema, body)
        : undefined;
    const data = await this.inventoryService.commitReservation(referenceId, parsedBody);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('reservations/:referenceId/release')
  @HttpCode(HttpStatus.OK)
  async releaseReservation(
    @Param('referenceId') referenceId: string,
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<ReserveStockResponse>> {
    const correlationId = getCorrelationIdFromRequest(req);
    const parsedBody =
      body && typeof body === 'object' && Object.keys(body as Record<string, unknown>).length > 0
        ? parseWithZod(OptionalReleaseBodySchema, body)
        : undefined;
    const data = await this.inventoryService.releaseReservation(
      referenceId,
      parsedBody,
      correlationId,
    );
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('internal/run-expire')
  @HttpCode(HttpStatus.OK)
  async runExpireSweep(@Req() req: Request): Promise<ApiResponse<ExpireSweepResult>> {
    const correlationId = getCorrelationIdFromRequest(req);
    const data = await this.inventoryService.runExpireSweep(correlationId);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Post('internal/test-set-stock')
  @HttpCode(HttpStatus.OK)
  async testSetStock(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<
    ApiResponse<{
      skuId: string;
      availableQty: number;
      reservedQty: number;
      redisSyncedQty: number;
    }>
  > {
    const input = parseWithZod(TestSetStockSchema, body);
    const data = await this.inventoryService.testSetStock(input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('internal/test-expire-reservation')
  @HttpCode(HttpStatus.OK)
  async testExpireReservation(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<
    ApiResponse<{
      updatedCount: number;
      reservationId: string;
      referenceId: string;
      expiresAt: string;
    }>
  > {
    const input = parseWithZod(TestExpireReservationSchema, body);
    const data = await this.inventoryService.testExpireReservation(input);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('internal/sync-catalog-skus')
  @HttpCode(HttpStatus.OK)
  async syncCatalogSkus(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<SyncCatalogSkusResult>> {
    this.assertInternalSecret(req);
    const input = parseWithZod(SyncCatalogSkusSchema, body);
    const data = await this.inventoryService.syncCatalogSkus(input.skus);
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('ops/summary')
  async getOpsSummary(@Req() req: Request): Promise<ApiResponse<InventoryOpsSummaryDto>> {
    const data = await this.inventoryService.getOpsSummary();
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Post('rma-restock')
  @HttpCode(HttpStatus.OK)
  async rmaRestock(
    @Body() body: unknown,
    @Req() req: Request,
  ): Promise<ApiResponse<RmaRestockResult>> {
    this.assertInternalSecret(req);
    const input = parseWithZod(RmaRestockSchema, body);
    const correlationId = getCorrelationIdFromRequest(req);
    const traceparent = getTraceparentFromRequest(req);
    const data = await this.inventoryService.rmaRestock(input, correlationId, traceparent);
    return createApiResponse(data, {
      correlationId,
      service: SERVICE_NAME,
    });
  }

  @Get('admin/warehouses')
  async listAdminWarehouses(@Req() req: Request): Promise<ApiResponse<WarehouseAdminViewDto[]>> {
    const data = await this.inventoryService.listAdminWarehouses();
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('admin/stock-levels')
  async listAdminStockLevels(
    @Query('warehouseCode') warehouseCode: string | undefined,
    @Query('lowStockOnly') lowStockOnly: string | undefined,
    @Query('outOfStockOnly') outOfStockOnly: string | undefined,
    @Query('q') q: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<StockLevelAdminExtendedDto[]>> {
    const data = await this.inventoryService.listAdminStockLevels({
      warehouseCode,
      lowStockOnly: lowStockOnly === 'true' || lowStockOnly === '1',
      outOfStockOnly: outOfStockOnly === 'true' || outOfStockOnly === '1',
      q,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('admin/reservations')
  async listAdminReservations(
    @Query('status') status: string | undefined,
    @Query('referenceId') referenceId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<StockReservationAdminDto[]>> {
    const data = await this.inventoryService.listAdminReservations({
      status,
      referenceId,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }

  @Get('admin/ledger')
  async listAdminLedger(
    @Query('skuId') skuId: string | undefined,
    @Query('warehouseCode') warehouseCode: string | undefined,
    @Query('reason') reason: string | undefined,
    @Query('referenceId') referenceId: string | undefined,
    @Query('limit') limit: string | undefined,
    @Req() req: Request,
  ): Promise<ApiResponse<LedgerAdminViewDto[]>> {
    const data = await this.inventoryService.listAdminLedger({
      skuId,
      warehouseCode,
      reason,
      referenceId,
      limit: limit ? Number.parseInt(limit, 10) : undefined,
    });
    return createApiResponse(data, {
      correlationId: getCorrelationIdFromRequest(req),
      service: SERVICE_NAME,
    });
  }
}
