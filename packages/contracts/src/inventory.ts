import { z } from 'zod';

export const WarehouseType = {
  CENTRAL: 'CENTRAL',
  SHOWROOM: 'SHOWROOM',
} as const;
export type WarehouseType = (typeof WarehouseType)[keyof typeof WarehouseType];
export const WarehouseTypeSchema = z.enum([WarehouseType.CENTRAL, WarehouseType.SHOWROOM]);

export const ReservationType = {
  CHECKOUT: 'CHECKOUT',
  SIZE_EXCHANGE: 'SIZE_EXCHANGE',
} as const;
export type ReservationType = (typeof ReservationType)[keyof typeof ReservationType];
export const ReservationTypeSchema = z.enum([
  ReservationType.CHECKOUT,
  ReservationType.SIZE_EXCHANGE,
]);

export const ReservationStatus = {
  ACTIVE: 'ACTIVE',
  COMMITTED: 'COMMITTED',
  RELEASED: 'RELEASED',
  EXPIRED: 'EXPIRED',
} as const;
export type ReservationStatus = (typeof ReservationStatus)[keyof typeof ReservationStatus];
export const ReservationStatusSchema = z.enum([
  ReservationStatus.ACTIVE,
  ReservationStatus.COMMITTED,
  ReservationStatus.RELEASED,
  ReservationStatus.EXPIRED,
]);

export const InventoryLedgerReason = {
  INITIAL_SEED: 'INITIAL_SEED',
  RESERVE: 'RESERVE',
  COMMIT: 'COMMIT',
  RELEASE_EXPIRED: 'RELEASE_EXPIRED',
  CANCEL_RELEASE: 'CANCEL_RELEASE',
  GRN_INBOUND: 'GRN_INBOUND',
  RMA_RESTOCK: 'RMA_RESTOCK',
  ADJUSTMENT: 'ADJUSTMENT',
} as const;
export type InventoryLedgerReason =
  (typeof InventoryLedgerReason)[keyof typeof InventoryLedgerReason];
export const InventoryLedgerReasonSchema = z.enum([
  InventoryLedgerReason.INITIAL_SEED,
  InventoryLedgerReason.RESERVE,
  InventoryLedgerReason.COMMIT,
  InventoryLedgerReason.RELEASE_EXPIRED,
  InventoryLedgerReason.CANCEL_RELEASE,
  InventoryLedgerReason.GRN_INBOUND,
  InventoryLedgerReason.RMA_RESTOCK,
  InventoryLedgerReason.ADJUSTMENT,
]);

export const BatchAvailabilityRequestSchema = z.object({
  skuIds: z.array(z.string().min(1)).min(1).max(200),
  warehouseCode: z.string().min(1).optional(),
});
export type BatchAvailabilityRequest = z.infer<typeof BatchAvailabilityRequestSchema>;

export const WarehouseStockBreakdownSchema = z.object({
  warehouseId: z.string().min(1),
  warehouseCode: z.string().min(1),
  warehouseName: z.string().min(1),
  warehouseType: WarehouseTypeSchema,
  availableQty: z.number().int().nonnegative(),
  reservedQty: z.number().int().nonnegative(),
  committedQty: z.number().int().nonnegative(),
});
export type WarehouseStockBreakdown = z.infer<typeof WarehouseStockBreakdownSchema>;

export const SkuAvailabilityDtoSchema = z.object({
  skuId: z.string().min(1),
  productId: z.string().min(1),
  availableQty: z.number().int().nonnegative(),
  reservedQty: z.number().int().nonnegative(),
  committedQty: z.number().int().nonnegative(),
  inStock: z.boolean(),
  lowStockWarning: z.boolean(),
  safetyThreshold: z.number().int().nonnegative(),
  warehouses: z.array(WarehouseStockBreakdownSchema),
});
export type SkuAvailabilityDto = z.infer<typeof SkuAvailabilityDtoSchema>;

export const BatchAvailabilityResponseSchema = z.object({
  items: z.record(SkuAvailabilityDtoSchema),
  list: z.array(SkuAvailabilityDtoSchema),
});
export type BatchAvailabilityResponse = z.infer<typeof BatchAvailabilityResponseSchema>;

export const ReserveStockItemSchema = z.object({
  skuId: z.string().min(1),
  qty: z.number().int().positive(),
});
export type ReserveStockItem = z.infer<typeof ReserveStockItemSchema>;

export const ReserveStockRequestSchema = z.object({
  referenceId: z.string().min(1),
  reservationType: ReservationTypeSchema.default(ReservationType.CHECKOUT),
  items: z.array(ReserveStockItemSchema).min(1).max(100),
  preferredWarehouseCode: z.string().min(1).optional(),
  ttlSeconds: z.number().int().positive().max(86400).default(900),
  idempotencyKey: z.string().min(1),
});
export type ReserveStockRequest = z.infer<typeof ReserveStockRequestSchema>;

export const ReservedStockLineSchema = z.object({
  skuId: z.string().min(1),
  qty: z.number().int().positive(),
  warehouseId: z.string().min(1),
  warehouseCode: z.string().min(1),
});
export type ReservedStockLine = z.infer<typeof ReservedStockLineSchema>;

export const ReserveStockResponseSchema = z.object({
  reservationId: z.string().min(1),
  referenceId: z.string().min(1),
  status: ReservationStatusSchema,
  expiresAt: z.string(),
  idempotentReplay: z.boolean(),
  items: z.array(ReservedStockLineSchema),
});
export type ReserveStockResponse = z.infer<typeof ReserveStockResponseSchema>;

export const InsufficientStockDetailSchema = z.object({
  skuId: z.string().min(1),
  requestedQty: z.number().int().positive(),
  availableQty: z.number().int().nonnegative(),
});
export type InsufficientStockDetail = z.infer<typeof InsufficientStockDetailSchema>;

export const CommitReservationRequestSchema = z
  .object({
    reservationId: z.string().min(1).optional(),
    referenceId: z.string().min(1).optional(),
    orderId: z.string().min(1).optional(),
    idempotencyKey: z.string().min(1).optional(),
  })
  .refine((v) => Boolean(v.reservationId || v.referenceId), {
    message: 'Either reservationId or referenceId is required',
  });
export type CommitReservationRequest = z.infer<typeof CommitReservationRequestSchema>;

export const ReleaseReservationRequestSchema = z
  .object({
    reservationId: z.string().min(1).optional(),
    referenceId: z.string().min(1).optional(),
    reason: z
      .enum([InventoryLedgerReason.RELEASE_EXPIRED, InventoryLedgerReason.CANCEL_RELEASE])
      .default(InventoryLedgerReason.CANCEL_RELEASE),
  })
  .refine((v) => Boolean(v.reservationId || v.referenceId), {
    message: 'Either reservationId or referenceId is required',
  });
export type ReleaseReservationRequest = z.infer<typeof ReleaseReservationRequestSchema>;

export const WarehouseDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  warehouseType: WarehouseTypeSchema,
  city: z.string().min(1),
  address: z.string().nullable().optional(),
  isActive: z.boolean(),
  priority: z.number().int(),
  createdAt: z.string().optional(),
});
export type WarehouseDto = z.infer<typeof WarehouseDtoSchema>;

export const StockLevelAdminDtoSchema = z.object({
  id: z.string().min(1),
  skuId: z.string().min(1),
  skuCode: z.string().optional(),
  productId: z.string().min(1),
  warehouseId: z.string().min(1),
  warehouseCode: z.string().min(1),
  warehouseName: z.string().min(1),
  availableQty: z.number().int().nonnegative(),
  reservedQty: z.number().int().nonnegative(),
  committedQty: z.number().int().nonnegative(),
  safetyThreshold: z.number().int().nonnegative(),
  lowStockWarning: z.boolean(),
  updatedAt: z.string(),
});
export type StockLevelAdminDto = z.infer<typeof StockLevelAdminDtoSchema>;

export const StockReservationAdminDtoSchema = z.object({
  id: z.string().min(1),
  referenceId: z.string().min(1),
  reservationType: ReservationTypeSchema,
  status: ReservationStatusSchema,
  idempotencyKey: z.string().min(1),
  warehouseId: z.string().min(1).nullable().optional(),
  warehouseCode: z.string().nullable().optional(),
  items: z.array(ReservedStockLineSchema),
  expiresAt: z.string(),
  committedAt: z.string().nullable().optional(),
  releasedAt: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type StockReservationAdminDto = z.infer<typeof StockReservationAdminDtoSchema>;

export const InventoryLedgerEntryDtoSchema = z.object({
  id: z.string().min(1),
  skuId: z.string().min(1),
  warehouseId: z.string().min(1),
  warehouseCode: z.string().optional(),
  deltaAvailable: z.number().int(),
  deltaReserved: z.number().int(),
  deltaCommitted: z.number().int(),
  balanceAvailable: z.number().int().nonnegative(),
  reason: InventoryLedgerReasonSchema,
  referenceId: z.string().nullable(),
  actorId: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type InventoryLedgerEntryDto = z.infer<typeof InventoryLedgerEntryDtoSchema>;
