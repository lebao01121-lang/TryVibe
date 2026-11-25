import { z } from 'zod';
import { PaymentIntentResponseDtoSchema } from './payment-promo';

export const ShippingMethod = {
  GHN: 'GHN',
  GHTK: 'GHTK',
  AHAMOVE_2H: 'AHAMOVE_2H',
  PICKUP: 'PICKUP',
} as const;
export type ShippingMethod = (typeof ShippingMethod)[keyof typeof ShippingMethod];
export const ShippingMethodSchema = z.enum([
  ShippingMethod.GHN,
  ShippingMethod.GHTK,
  ShippingMethod.AHAMOVE_2H,
  ShippingMethod.PICKUP,
]);

export const PaymentMethod = {
  VIETQR: 'VIETQR',
  VNPAY: 'VNPAY',
  MOMO: 'MOMO',
  COD: 'COD',
} as const;
export type PaymentMethod = (typeof PaymentMethod)[keyof typeof PaymentMethod];
export const PaymentMethodSchema = z.enum([
  PaymentMethod.VIETQR,
  PaymentMethod.VNPAY,
  PaymentMethod.MOMO,
  PaymentMethod.COD,
]);

export const OrderStatus = {
  PENDING_RESERVATION: 'PENDING_RESERVATION',
  FAILED_OUT_OF_STOCK: 'FAILED_OUT_OF_STOCK',
  AWAITING_PAYMENT: 'AWAITING_PAYMENT',
  CONFIRMED: 'CONFIRMED',
  PACKING: 'PACKING',
  SHIPPED: 'SHIPPED',
  DELIVERED: 'DELIVERED',
  COMPLETED: 'COMPLETED',
  CANCELLED: 'CANCELLED',
  LATE_PAYMENT_NEEDS_REFUND: 'LATE_PAYMENT_NEEDS_REFUND',
} as const;
export type OrderStatus = (typeof OrderStatus)[keyof typeof OrderStatus];
export const OrderStatusSchema = z.enum([
  OrderStatus.PENDING_RESERVATION,
  OrderStatus.FAILED_OUT_OF_STOCK,
  OrderStatus.AWAITING_PAYMENT,
  OrderStatus.CONFIRMED,
  OrderStatus.PACKING,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
  OrderStatus.COMPLETED,
  OrderStatus.CANCELLED,
  OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
]);

export const ShipmentStatus = {
  READY_TO_PICK: 'READY_TO_PICK',
  PICKED: 'PICKED',
  IN_TRANSIT: 'IN_TRANSIT',
  DELIVERED: 'DELIVERED',
  DELIVERY_FAILED: 'DELIVERY_FAILED',
} as const;
export type ShipmentStatus = (typeof ShipmentStatus)[keyof typeof ShipmentStatus];
export const ShipmentStatusSchema = z.enum([
  ShipmentStatus.READY_TO_PICK,
  ShipmentStatus.PICKED,
  ShipmentStatus.IN_TRANSIT,
  ShipmentStatus.DELIVERED,
  ShipmentStatus.DELIVERY_FAILED,
]);

export const ShippingAddressSnapshotSchema = z.object({
  recipientName: z.string().trim().min(1).max(120),
  phone: z.string().trim().min(8).max(20),
  provinceName: z.string().trim().min(1).max(120),
  districtName: z.string().trim().min(1).max(120),
  wardName: z.string().trim().min(1).max(120),
  streetLine: z.string().trim().min(1).max(255),
  provinceCode: z.string().trim().max(32).optional(),
  districtCode: z.string().trim().max(32).optional(),
  wardCode: z.string().trim().max(32).optional(),
});
export type ShippingAddressSnapshot = z.infer<typeof ShippingAddressSnapshotSchema>;

export const CheckoutItemInputSchema = z.object({
  skuId: z.string().min(1),
  qty: z.number().int().positive().max(99),
  bundleGroupId: z.string().min(1).nullable().optional(),
  fromAiTryon: z.boolean().optional(),
});
export type CheckoutItemInput = z.infer<typeof CheckoutItemInputSchema>;

/**
 * Checkout payload intentionally accepts ZERO price fields from client;
 * order-rma always resolves authoritative prices from catalog-lookbook.
 */
export const CheckoutSubmitDtoSchema = z.object({
  shippingAddress: ShippingAddressSnapshotSchema,
  shippingMethod: ShippingMethodSchema,
  deliveryDate: z.string().max(32).nullable().optional(),
  deliverySlot: z.string().max(64).nullable().optional(),
  paymentMethod: PaymentMethodSchema,
  voucherCode: z.string().trim().max(64).nullable().optional(),
  packagingOptionId: z.string().min(1).nullable().optional(),
  giftNote: z.string().max(140).nullable().optional(),
  customerEmail: z.string().trim().email().nullable().optional(),
  items: z.array(CheckoutItemInputSchema).min(1).max(50).optional(),
});
export type CheckoutSubmitDTO = z.infer<typeof CheckoutSubmitDtoSchema>;
export type CheckoutSubmitDto = CheckoutSubmitDTO;

export const OrderItemDtoSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  skuId: z.string().min(1),
  skuCode: z.string().min(1),
  productName: z.string().min(1),
  colorName: z.string().min(1),
  sizeCode: z.string().min(1),
  imageUrl: z.string().nullable(),
  unitPriceVnd: z.number().int().nonnegative(),
  allocatedDiscountVnd: z.number().int().nonnegative(),
  netRefundableUnitVnd: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
  bundleGroupId: z.string().nullable(),
  isReturnable: z.boolean(),
  supplierBatchCode: z.string().nullable(),
});
export type OrderItemDTO = z.infer<typeof OrderItemDtoSchema>;
export type OrderItemDto = OrderItemDTO;

export const ShipmentDtoSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  warehouseCode: z.string().min(1),
  carrier: z.string().min(1),
  trackingCode: z.string().min(1),
  status: ShipmentStatusSchema,
  packPhotoUrl: z.string().nullable(),
  codCollectVnd: z.number().int().nonnegative(),
  updatedAt: z.string(),
});
export type ShipmentDTO = z.infer<typeof ShipmentDtoSchema>;
export type ShipmentDto = ShipmentDTO;

export const OrderDtoSchema = z.object({
  id: z.string().min(1),
  orderCode: z.string().min(1),
  userId: z.string().nullable(),
  guestSessionId: z.string().nullable(),
  customerEmail: z.string().nullable(),
  status: OrderStatusSchema,
  paymentMethod: PaymentMethodSchema,
  shippingMethod: ShippingMethodSchema,
  shippingAddress: ShippingAddressSnapshotSchema,
  deliveryDate: z.string().nullable(),
  deliverySlot: z.string().nullable(),
  packagingOptionId: z.string().nullable(),
  packagingPriceVnd: z.number().int().nonnegative(),
  giftNote: z.string().max(140).nullable(),
  voucherCode: z.string().nullable(),
  subtotalVnd: z.number().int().nonnegative(),
  comboDiscountVnd: z.number().int().nonnegative(),
  voucherDiscountVnd: z.number().int().nonnegative(),
  shippingFeeVnd: z.number().int().nonnegative(),
  totalAmountVnd: z.number().int().nonnegative(),
  codDepositRequiredVnd: z.number().int().nonnegative().optional(),
  reservationId: z.string().nullable(),
  reservationExpiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  deliveredAt: z.string().nullable(),
  completedAt: z.string().nullable().optional(),
  completedBy: z.string().nullable().optional(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  cancelledBy: z.string().nullable().optional(),
  totalVnd: z.number().int().nonnegative().optional(),
  items: z.array(OrderItemDtoSchema),
  shipment: ShipmentDtoSchema.nullable(),
  paymentIntent: PaymentIntentResponseDtoSchema.nullable().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type OrderDTO = z.infer<typeof OrderDtoSchema>;
export type OrderDto = OrderDTO;

export const AdminCancelOrderDtoSchema = z.object({
  reason: z.string().trim().min(1).max(500).optional(),
  cancelledBy: z.string().trim().max(140).optional(),
});
export type AdminCancelOrderDTO = z.infer<typeof AdminCancelOrderDtoSchema>;
export type AdminCancelOrderDto = AdminCancelOrderDTO;

export const CompleteOrderDtoSchema = z
  .object({
    completedBy: z.string().trim().max(140).optional(),
    note: z.string().max(500).optional(),
  })
  .optional();
export type CompleteOrderDTO = z.infer<typeof CompleteOrderDtoSchema>;
export type CompleteOrderDto = CompleteOrderDTO;

// ============================================================================
// RMA & Size Exchange Contracts
// ============================================================================

export const RmaType = {
  SIZE_EXCHANGE: 'SIZE_EXCHANGE',
  COLOR_EXCHANGE: 'COLOR_EXCHANGE',
  RETURN_REFUND: 'RETURN_REFUND',
} as const;
export type RmaType = (typeof RmaType)[keyof typeof RmaType];
export const RmaTypeSchema = z.enum([
  RmaType.SIZE_EXCHANGE,
  RmaType.COLOR_EXCHANGE,
  RmaType.RETURN_REFUND,
]);

export const RmaExchangeMode = {
  INSTANT_2WAY: 'INSTANT_2WAY',
  STANDARD_QC: 'STANDARD_QC',
} as const;
export type RmaExchangeMode = (typeof RmaExchangeMode)[keyof typeof RmaExchangeMode];
export const RmaExchangeModeSchema = z.enum([
  RmaExchangeMode.INSTANT_2WAY,
  RmaExchangeMode.STANDARD_QC,
]);

export const RmaReasonCode = {
  SAI_KICH_CO_CHAT: 'SAI_KICH_CO_CHAT',
  SAI_KICH_CO_RONG: 'SAI_KICH_CO_RONG',
  SAI_MAU_MO_TA: 'SAI_MAU_MO_TA',
  LOI_SAN_XUAT: 'LOI_SAN_XUAT',
  KHAC: 'KHAC',
} as const;
export type RmaReasonCode = (typeof RmaReasonCode)[keyof typeof RmaReasonCode];
export const RmaReasonCodeSchema = z.enum([
  RmaReasonCode.SAI_KICH_CO_CHAT,
  RmaReasonCode.SAI_KICH_CO_RONG,
  RmaReasonCode.SAI_MAU_MO_TA,
  RmaReasonCode.LOI_SAN_XUAT,
  RmaReasonCode.KHAC,
]);

export const RmaStatus = {
  RMA_REQUESTED: 'RMA_REQUESTED',
  RMA_APPROVED: 'RMA_APPROVED',
  RMA_REJECTED: 'RMA_REJECTED',
  EXCHANGE_RESERVED: 'EXCHANGE_RESERVED',
  INSTANT_2WAY_DISPATCHED: 'INSTANT_2WAY_DISPATCHED',
  RETURN_IN_TRANSIT: 'RETURN_IN_TRANSIT',
  QC_INSPECTING: 'QC_INSPECTING',
  QC_PASSED: 'QC_PASSED',
  QC_FAILED: 'QC_FAILED',
  EXCHANGE_SHIPPED: 'EXCHANGE_SHIPPED',
  REFUND_PROCESSING: 'REFUND_PROCESSING',
  RMA_COMPLETED: 'RMA_COMPLETED',
} as const;
export type RmaStatus = (typeof RmaStatus)[keyof typeof RmaStatus];
export const RmaStatusSchema = z.enum([
  RmaStatus.RMA_REQUESTED,
  RmaStatus.RMA_APPROVED,
  RmaStatus.RMA_REJECTED,
  RmaStatus.EXCHANGE_RESERVED,
  RmaStatus.INSTANT_2WAY_DISPATCHED,
  RmaStatus.RETURN_IN_TRANSIT,
  RmaStatus.QC_INSPECTING,
  RmaStatus.QC_PASSED,
  RmaStatus.QC_FAILED,
  RmaStatus.EXCHANGE_SHIPPED,
  RmaStatus.REFUND_PROCESSING,
  RmaStatus.RMA_COMPLETED,
]);

export const RMA_CUSTOMER_NOTE_MAX_LEN = 300 as const;

export function truncateRmaCustomerNote(
  note: string | null | undefined,
  maxLength: number = RMA_CUSTOMER_NOTE_MAX_LEN,
): string {
  if (!note) {
    return '';
  }
  // eslint-disable-next-line no-control-regex
  const cleaned = note.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength);
}

export const CreateRmaRequestDtoSchema = z.object({
  orderItemId: z.string().min(1),
  qty: z.number().int().positive().default(1),
  type: RmaTypeSchema,
  exchangeMode: RmaExchangeModeSchema.default(RmaExchangeMode.STANDARD_QC),
  reasonCode: RmaReasonCodeSchema,
  targetSkuId: z.string().min(1).nullable().optional(),
  customerNote: z.string().trim().max(RMA_CUSTOMER_NOTE_MAX_LEN).default(''),
  evidencePhotoUrls: z.array(z.string().min(1)).max(6).default([]),
});
export type CreateRmaRequestDTO = z.infer<typeof CreateRmaRequestDtoSchema>;
export type CreateRmaRequestDto = CreateRmaRequestDTO;

export const CompleteRmaQcDtoSchema = z.object({
  tagsIntact: z.boolean(),
  unwashed: z.boolean(),
  noStainsOrOdor: z.boolean(),
  passed: z.boolean(),
  inspectorNote: z.string().max(500).optional(),
  evidencePhotoUrls: z.array(z.string().min(1)).max(6).optional(),
});
export type CompleteRmaQcDTO = z.infer<typeof CompleteRmaQcDtoSchema>;
export type CompleteRmaQcDto = CompleteRmaQcDTO;

export const RmaRequestDtoSchema = z.object({
  id: z.string().min(1),
  rmaCode: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().optional(),
  orderItemId: z.string().min(1),
  userId: z.string().nullable(),
  productId: z.string().min(1),
  skuId: z.string().min(1),
  targetSkuId: z.string().nullable(),
  qty: z.number().int().positive(),
  type: RmaTypeSchema,
  exchangeMode: RmaExchangeModeSchema,
  reasonCode: RmaReasonCodeSchema,
  status: RmaStatusSchema,
  customerNote: z.string().max(RMA_CUSTOMER_NOTE_MAX_LEN),
  evidencePhotoUrls: z.array(z.string()),
  exchangeReservationId: z.string().nullable(),
  refundAmountVnd: z.number().int().nonnegative().nullable(),
  refundTransactionId: z.string().nullable(),
  qcResult: CompleteRmaQcDtoSchema.nullable().optional(),
  rejectionReason: z.string().nullable().optional(),
  rejectedBy: z.string().nullable().optional(),
  rejectedAt: z.string().nullable().optional(),
  supplierBatchCode: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type RmaRequestDTO = z.infer<typeof RmaRequestDtoSchema>;
export type RmaRequestDto = RmaRequestDTO;

export const RejectRmaDtoSchema = z.object({
  reason: z.string().trim().min(2).max(500),
  rejectedBy: z.string().trim().max(140).optional(),
});
export type RejectRmaDTO = z.infer<typeof RejectRmaDtoSchema>;
export type RejectRmaDto = RejectRmaDTO;

export const RmaSampleCustomerNoteSchema = z.object({
  rmaCode: z.string().min(1),
  productId: z.string().min(1),
  sizePurchased: z.string().min(1),
  reasonCode: RmaReasonCodeSchema,
  customerNote: z.string().max(RMA_CUSTOMER_NOTE_MAX_LEN),
});
export type RmaSampleCustomerNote = z.infer<typeof RmaSampleCustomerNoteSchema>;

export const RmaStatsSummaryDtoSchema = z.object({
  periodDays: z.number().int().positive(),
  totalRmaCount: z.number().int().nonnegative(),
  totalDeliveredOrders: z.number().int().nonnegative().optional(),
  overallReturnRatePct: z.number().min(0).max(100),
  byProduct: z.array(
    z.object({
      productId: z.string().min(1),
      productName: z.string().optional(),
      skuCode: z.string().optional(),
      totalRmas: z.number().int().nonnegative(),
      returnRatePct: z.number().min(0).max(100).optional(),
      dominantReasonCode: RmaReasonCodeSchema,
      byReason: z.record(z.number().int().nonnegative()),
    }),
  ),
  bySupplierBatch: z.array(
    z.object({
      supplierBatchCode: z.string().min(1),
      productId: z.string().optional(),
      totalRmas: z.number().int().nonnegative(),
      defectCount: z.number().int().nonnegative(),
    }),
  ),
  byReason: z.record(z.number().int().nonnegative()),
  sampleCustomerNotes: z.array(RmaSampleCustomerNoteSchema).max(5),
});
export type RmaStatsSummaryDTO = z.infer<typeof RmaStatsSummaryDtoSchema>;
export type RmaStatsSummaryDto = RmaStatsSummaryDTO;
