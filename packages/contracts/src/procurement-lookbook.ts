import { z } from 'zod';

export const SupplierStatus = {
  ACTIVE: 'ACTIVE',
  SUSPENDED: 'SUSPENDED',
} as const;
export type SupplierStatus = (typeof SupplierStatus)[keyof typeof SupplierStatus];
export const SupplierStatusSchema = z.enum([SupplierStatus.ACTIVE, SupplierStatus.SUSPENDED]);

export const SupplierDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  contactName: z.string().nullable().optional(),
  contactEmail: z.string().email(),
  contactPhone: z.string().nullable().optional(),
  address: z.string().nullable().optional(),
  leadTimeDays: z.number().int().positive(),
  paymentTermsDays: z.number().int().nonnegative().optional(),
  defectRatePct: z.number().min(0).max(100),
  status: SupplierStatusSchema,
  isActive: z.boolean().optional(),
});
export type SupplierDTO = z.infer<typeof SupplierDtoSchema>;
export type SupplierDto = SupplierDTO;

export const CreateSupplierDtoSchema = z.object({
  code: z.string().trim().min(2).max(64),
  name: z.string().trim().min(2).max(200),
  contactName: z.string().trim().max(140).optional(),
  contactEmail: z.string().trim().email(),
  contactPhone: z.string().trim().max(32).optional(),
  address: z.string().trim().max(300).optional(),
  leadTimeDays: z.coerce.number().int().positive().max(180).default(7),
  paymentTermsDays: z.coerce.number().int().nonnegative().max(180).default(30),
  isActive: z.boolean().default(true),
  status: SupplierStatusSchema.optional(),
});
export type CreateSupplierDTO = z.infer<typeof CreateSupplierDtoSchema>;
export type CreateSupplierDto = CreateSupplierDTO;

export const UpdateSupplierDtoSchema = CreateSupplierDtoSchema.partial();
export type UpdateSupplierDTO = z.infer<typeof UpdateSupplierDtoSchema>;
export type UpdateSupplierDto = UpdateSupplierDTO;

export const PurchaseOrderStatus = {
  NHAP_AI: 'NHAP_AI',
  CHO_NCC_XAC_NHAN: 'CHO_NCC_XAC_NHAN',
  NCC_DA_XAC_NHAN: 'NCC_DA_XAC_NHAN',
  HOAN_TAT_MOT_PHAN: 'HOAN_TAT_MOT_PHAN',
  HOAN_TAT: 'HOAN_TAT',
  DA_HUY: 'DA_HUY',
  CANCELLED: 'CANCELLED',
  SUPPLIER_REJECTED: 'SUPPLIER_REJECTED',
} as const;
export type PurchaseOrderStatus = (typeof PurchaseOrderStatus)[keyof typeof PurchaseOrderStatus];
export const PurchaseOrderStatusSchema = z.enum([
  PurchaseOrderStatus.NHAP_AI,
  PurchaseOrderStatus.CHO_NCC_XAC_NHAN,
  PurchaseOrderStatus.NCC_DA_XAC_NHAN,
  PurchaseOrderStatus.HOAN_TAT_MOT_PHAN,
  PurchaseOrderStatus.HOAN_TAT,
  PurchaseOrderStatus.DA_HUY,
  PurchaseOrderStatus.CANCELLED,
  PurchaseOrderStatus.SUPPLIER_REJECTED,
]);

export const PurchaseOrderCreatedSource = {
  USER: 'USER',
  AI_COPILOT: 'AI_COPILOT',
} as const;
export type PurchaseOrderCreatedSource =
  (typeof PurchaseOrderCreatedSource)[keyof typeof PurchaseOrderCreatedSource];
export const PurchaseOrderCreatedSourceSchema = z.enum([
  PurchaseOrderCreatedSource.USER,
  PurchaseOrderCreatedSource.AI_COPILOT,
]);

export const CreatePurchaseOrderItemInputSchema = z.object({
  skuId: z.string().min(1),
  skuCode: z.string().min(1).optional(),
  productName: z.string().optional(),
  orderedQty: z.number().int().positive().max(100_000),
  unitCostVnd: z.number().int().nonnegative(),
});
export type CreatePurchaseOrderItemInput = z.infer<typeof CreatePurchaseOrderItemInputSchema>;

export const CreatePurchaseOrderDtoSchema = z.object({
  supplierId: z.string().min(1),
  warehouseCode: z.string().min(1).default('WH_HN_CENTRAL'),
  expectedDeliveryDate: z.string().min(1),
  rationale: z.string().max(600).optional(),
  note: z.string().max(600).optional(),
  createdSource: PurchaseOrderCreatedSourceSchema.default(PurchaseOrderCreatedSource.USER),
  items: z.array(CreatePurchaseOrderItemInputSchema).min(1).max(100),
});
export type CreatePurchaseOrderDTO = z.infer<typeof CreatePurchaseOrderDtoSchema>;
export type CreatePurchaseOrderDto = CreatePurchaseOrderDTO;

export const PurchaseOrderItemDtoSchema = z.object({
  id: z.string().min(1),
  poId: z.string().min(1),
  skuId: z.string().min(1),
  skuCode: z.string().min(1),
  productName: z.string().nullable().optional(),
  orderedQty: z.number().int().positive(),
  receivedQty: z.number().int().nonnegative(),
  acceptedQty: z.number().int().nonnegative(),
  rejectedDefectQty: z.number().int().nonnegative(),
  unitCostVnd: z.number().int().nonnegative().optional(),
  lineCostVnd: z.number().int().nonnegative().optional(),
});
export type PurchaseOrderItemDTO = z.infer<typeof PurchaseOrderItemDtoSchema>;
export type PurchaseOrderItemDto = PurchaseOrderItemDTO;

export const PurchaseOrderDtoSchema = z.object({
  id: z.string().min(1),
  poNumber: z.string().min(1),
  supplierId: z.string().min(1),
  supplierCode: z.string().optional(),
  supplierName: z.string().optional(),
  warehouseCode: z.string().min(1),
  status: PurchaseOrderStatusSchema,
  createdSource: PurchaseOrderCreatedSourceSchema,
  requiresHumanApproval: z.boolean(),
  expectedDeliveryDate: z.string(),
  confirmedDeliveryDate: z.string().nullable(),
  rationale: z.string().nullable(),
  supplierNote: z.string().nullable(),
  totalOrderedQty: z.number().int().nonnegative(),
  totalReceivedQty: z.number().int().nonnegative(),
  totalCostVnd: z.number().int().nonnegative().optional(),
  approvedByUserId: z.string().nullable(),
  approvedAt: z.string().nullable(),
  confirmedBySupplierUserId: z.string().nullable(),
  confirmedAt: z.string().nullable(),
  cancelReason: z.string().nullable().optional(),
  cancelledAt: z.string().nullable().optional(),
  supplierRejectionReason: z.string().nullable().optional(),
  proposedDeliveryDate: z.string().nullable().optional(),
  rejectedAt: z.string().nullable().optional(),
  items: z.array(PurchaseOrderItemDtoSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseOrderDTO = z.infer<typeof PurchaseOrderDtoSchema>;
export type PurchaseOrderDto = PurchaseOrderDTO;

export const ConfirmPurchaseOrderBySupplierDtoSchema = z.object({
  confirmedDeliveryDate: z.string().min(1),
  supplierNote: z.string().max(500).optional(),
});
export type ConfirmPurchaseOrderBySupplierDTO = z.infer<
  typeof ConfirmPurchaseOrderBySupplierDtoSchema
>;
export type ConfirmPurchaseOrderBySupplierDto = ConfirmPurchaseOrderBySupplierDTO;

export const CancelPurchaseOrderDtoSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  actorId: z.string().trim().optional(),
});
export type CancelPurchaseOrderDTO = z.infer<typeof CancelPurchaseOrderDtoSchema>;
export type CancelPurchaseOrderDto = CancelPurchaseOrderDTO;

export const RejectPurchaseOrderBySupplierDtoSchema = z.object({
  supplierId: z.string().trim().min(1).optional(),
  reason: z.string().trim().min(2).max(500),
  proposedDeliveryDate: z.string().trim().max(32).nullable().optional(),
});
export type RejectPurchaseOrderBySupplierDTO = z.infer<
  typeof RejectPurchaseOrderBySupplierDtoSchema
>;
export type RejectPurchaseOrderBySupplierDto = RejectPurchaseOrderBySupplierDTO;

export const CreateGoodsReceiptItemDtoSchema = z.object({
  poItemId: z.string().min(1),
  skuId: z.string().min(1),
  receivedQty: z.number().int().positive(),
  acceptedQty: z.number().int().nonnegative(),
  rejectedDefectQty: z.number().int().nonnegative(),
  batchCode: z.string().trim().min(1).max(64),
});
export type CreateGoodsReceiptItemDTO = z.infer<typeof CreateGoodsReceiptItemDtoSchema>;
export type CreateGoodsReceiptItemDto = CreateGoodsReceiptItemDTO;

export const CreateGoodsReceiptDtoSchema = z.object({
  poId: z.string().min(1),
  warehouseCode: z.string().min(1).default('WH_HN_CENTRAL'),
  note: z.string().max(500).optional(),
  items: z.array(CreateGoodsReceiptItemDtoSchema).min(1).max(100),
});
export type CreateGoodsReceiptDTO = z.infer<typeof CreateGoodsReceiptDtoSchema>;
export type CreateGoodsReceiptDto = CreateGoodsReceiptDTO;

export const GoodsReceiptDtoSchema = z.object({
  id: z.string().min(1),
  grnNumber: z.string().min(1),
  poId: z.string().min(1),
  poNumber: z.string().optional(),
  supplierId: z.string().min(1),
  warehouseCode: z.string().min(1),
  receivedByUserId: z.string().nullable(),
  note: z.string().nullable(),
  totalAcceptedQty: z.number().int().nonnegative(),
  totalRejectedQty: z.number().int().nonnegative(),
  payableId: z.string().nullable(),
  payableAmountVnd: z.number().int().nonnegative().optional(),
  items: z.array(CreateGoodsReceiptItemDtoSchema),
  createdAt: z.string(),
});
export type GoodsReceiptDTO = z.infer<typeof GoodsReceiptDtoSchema>;
export type GoodsReceiptDto = GoodsReceiptDTO;

export const SupplierPayableStatus = {
  UNPAID: 'UNPAID',
  PAID: 'PAID',
} as const;
export type SupplierPayableStatus =
  (typeof SupplierPayableStatus)[keyof typeof SupplierPayableStatus];
export const SupplierPayableStatusSchema = z.enum([
  SupplierPayableStatus.UNPAID,
  SupplierPayableStatus.PAID,
]);

export const SupplierPayableDtoSchema = z.object({
  id: z.string().min(1),
  supplierId: z.string().min(1),
  grnId: z.string().min(1),
  poId: z.string().min(1).nullable().optional(),
  poNumber: z.string().nullable().optional(),
  grnNumber: z.string().nullable().optional(),
  amountPayableVnd: z.number().int().nonnegative(),
  status: SupplierPayableStatusSchema,
  dueDate: z.string(),
  bankReference: z.string().nullable().optional(),
  paymentReference: z.string().nullable().optional(),
  paidAt: z.string().nullable().optional(),
  paidBy: z.string().nullable().optional(),
  settlementNote: z.string().nullable().optional(),
  createdAt: z.string(),
});
export type SupplierPayableDTO = z.infer<typeof SupplierPayableDtoSchema>;
export type SupplierPayableDto = SupplierPayableDTO;

export const MarkPayablePaidDtoSchema = z.object({
  bankReference: z.string().trim().min(2).max(140),
  paidAt: z.string().trim().optional(),
  note: z.string().max(500).optional(),
  actorId: z.string().trim().optional(),
});
export type MarkPayablePaidDTO = z.infer<typeof MarkPayablePaidDtoSchema>;
export type MarkPayablePaidDto = MarkPayablePaidDTO;

// ============================================================================
// AI Studio Lookbook Contracts
// ============================================================================

export const VirtualModelCode = {
  MODEL_VN_FEMALE_01: 'MODEL_VN_FEMALE_01',
  MODEL_VN_FEMALE_02: 'MODEL_VN_FEMALE_02',
  MODEL_VN_MALE_01: 'MODEL_VN_MALE_01',
  MODEL_VN_MALE_02: 'MODEL_VN_MALE_02',
  MODEL_EDITORIAL_UNISEX_01: 'MODEL_EDITORIAL_UNISEX_01',
} as const;
export type VirtualModelCode = (typeof VirtualModelCode)[keyof typeof VirtualModelCode];
export const VirtualModelCodeSchema = z.enum([
  VirtualModelCode.MODEL_VN_FEMALE_01,
  VirtualModelCode.MODEL_VN_FEMALE_02,
  VirtualModelCode.MODEL_VN_MALE_01,
  VirtualModelCode.MODEL_VN_MALE_02,
  VirtualModelCode.MODEL_EDITORIAL_UNISEX_01,
]);

export const LookbookSessionStatus = {
  QUEUED: 'QUEUED',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
} as const;
export type LookbookSessionStatus =
  (typeof LookbookSessionStatus)[keyof typeof LookbookSessionStatus];
export const LookbookSessionStatusSchema = z.enum([
  LookbookSessionStatus.QUEUED,
  LookbookSessionStatus.PROCESSING,
  LookbookSessionStatus.COMPLETED,
  LookbookSessionStatus.FAILED,
]);

export const CreateLookbookSessionDtoSchema = z.object({
  productId: z.string().min(1),
  variantId: z.string().min(1).nullable().optional(),
  virtualModelCode: VirtualModelCodeSchema,
  scenePrompt: z.string().trim().min(3).max(600),
});
export type CreateLookbookSessionDTO = z.infer<typeof CreateLookbookSessionDtoSchema>;
export type CreateLookbookSessionDto = CreateLookbookSessionDTO;

export const LookbookSessionDtoSchema = z.object({
  id: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().nullable(),
  virtualModelCode: VirtualModelCodeSchema,
  scenePrompt: z.string(),
  status: LookbookSessionStatusSchema,
  resultUrl: z.string().nullable(),
  bucket: z.string().nullable(),
  objectKey: z.string().nullable(),
  providerUsed: z.string(),
  width: z.number().int().positive().nullable(),
  height: z.number().int().positive().nullable(),
  approvedForGallery: z.boolean(),
  createdByUserId: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type LookbookSessionDTO = z.infer<typeof LookbookSessionDtoSchema>;
export type LookbookSessionDto = LookbookSessionDTO;
