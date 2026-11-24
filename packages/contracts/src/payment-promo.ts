import { z } from 'zod';

export const PromoType = {
  PERCENT: 'PERCENT',
  FIXED: 'FIXED',
  FREESHIP: 'FREESHIP',
  OUTFIT_COMBO: 'OUTFIT_COMBO',
  FLASH_SALE: 'FLASH_SALE',
  CLEARANCE_ODD_SIZE: 'CLEARANCE_ODD_SIZE',
} as const;
export type PromoType = (typeof PromoType)[keyof typeof PromoType];
export const PromoTypeSchema = z.enum([
  PromoType.PERCENT,
  PromoType.FIXED,
  PromoType.FREESHIP,
  PromoType.OUTFIT_COMBO,
  PromoType.FLASH_SALE,
  PromoType.CLEARANCE_ODD_SIZE,
]);

export const PromoStatus = {
  NHAP_AI: 'NHAP_AI',
  ACTIVE: 'ACTIVE',
  PAUSED: 'PAUSED',
  EXPIRED: 'EXPIRED',
} as const;
export type PromoStatus = (typeof PromoStatus)[keyof typeof PromoStatus];
export const PromoStatusSchema = z.enum([
  PromoStatus.NHAP_AI,
  PromoStatus.ACTIVE,
  PromoStatus.PAUSED,
  PromoStatus.EXPIRED,
]);

export const PaymentProvider = {
  VIETQR: 'VIETQR',
  VNPAY: 'VNPAY',
  MOMO: 'MOMO',
  COD: 'COD',
} as const;
export type PaymentProvider = (typeof PaymentProvider)[keyof typeof PaymentProvider];
export const PaymentProviderSchema = z.enum([
  PaymentProvider.VIETQR,
  PaymentProvider.VNPAY,
  PaymentProvider.MOMO,
  PaymentProvider.COD,
]);

export const PaymentTransactionStatus = {
  PENDING: 'PENDING',
  SUCCEEDED: 'SUCCEEDED',
  EXPIRED: 'EXPIRED',
  FAILED: 'FAILED',
  LATE_SUCCEEDED: 'LATE_SUCCEEDED',
  REFUNDED: 'REFUNDED',
} as const;
export type PaymentTransactionStatus =
  (typeof PaymentTransactionStatus)[keyof typeof PaymentTransactionStatus];
export const PaymentTransactionStatusSchema = z.enum([
  PaymentTransactionStatus.PENDING,
  PaymentTransactionStatus.SUCCEEDED,
  PaymentTransactionStatus.EXPIRED,
  PaymentTransactionStatus.FAILED,
  PaymentTransactionStatus.LATE_SUCCEEDED,
  PaymentTransactionStatus.REFUNDED,
]);

export const EvaluatePromotionLineItemSchema = z.object({
  skuId: z.string().min(1),
  productId: z.string().min(1).optional(),
  unitPriceVnd: z.number().int().nonnegative(),
  qty: z.number().int().positive(),
  slot: z.string().nullable().optional(),
});
export type EvaluatePromotionLineItem = z.infer<typeof EvaluatePromotionLineItemSchema>;

export const EvaluatePromotionDtoSchema = z.object({
  voucherCode: z.string().trim().max(64).nullable().optional(),
  items: z.array(EvaluatePromotionLineItemSchema).min(1),
  subtotalVnd: z.number().int().nonnegative().optional(),
  shippingFeeVnd: z.number().int().nonnegative().default(0),
  userId: z.string().min(1).nullable().optional(),
  isNewCustomer: z.boolean().optional(),
  comboDistinctSlots: z.number().int().nonnegative().optional(),
});
export type EvaluatePromotionDTO = z.infer<typeof EvaluatePromotionDtoSchema>;
export type EvaluatePromotionDto = EvaluatePromotionDTO;

export const AllocatedItemDiscountSchema = z.object({
  skuId: z.string().min(1),
  qty: z.number().int().positive(),
  unitPriceVnd: z.number().int().nonnegative(),
  allocatedDiscountVnd: z.number().int().nonnegative(),
  netRefundableUnitVnd: z.number().int().nonnegative(),
});
export type AllocatedItemDiscount = z.infer<typeof AllocatedItemDiscountSchema>;

export const EvaluatePromotionResultDtoSchema = z.object({
  valid: z.boolean(),
  voucherCode: z.string().nullable(),
  promotionId: z.string().nullable(),
  promoType: PromoTypeSchema.nullable(),
  discountVnd: z.number().int().nonnegative(),
  shippingDiscountVnd: z.number().int().nonnegative(),
  totalDiscountVnd: z.number().int().nonnegative(),
  allocatedItems: z.array(AllocatedItemDiscountSchema),
  reason: z.string().nullable(),
});
export type EvaluatePromotionResultDTO = z.infer<typeof EvaluatePromotionResultDtoSchema>;
export type EvaluatePromotionResultDto = EvaluatePromotionResultDTO;

export const LockPromotionDtoSchema = z.object({
  promotionId: z.string().min(1).optional(),
  voucherCode: z.string().trim().min(1).max(64),
  orderId: z.string().min(1),
  userId: z.string().min(1).nullable().optional(),
  discountVnd: z.number().int().nonnegative().optional(),
});
export type LockPromotionDTO = z.infer<typeof LockPromotionDtoSchema>;
export type LockPromotionDto = LockPromotionDTO;

export const ReleasePromotionDtoSchema = z.object({
  promotionId: z.string().min(1).optional(),
  voucherCode: z.string().trim().max(64).optional(),
  orderId: z.string().min(1),
  reason: z.string().max(240).optional(),
});
export type ReleasePromotionDTO = z.infer<typeof ReleasePromotionDtoSchema>;
export type ReleasePromotionDto = ReleasePromotionDTO;

export const CreateClearanceCampaignDraftDtoSchema = z.object({
  code: z.string().trim().min(3).max(64),
  name: z.string().trim().min(2).max(180),
  description: z.string().max(500).optional(),
  discountPercent: z.number().min(1).max(70),
  targetProductIds: z.array(z.string().min(1)).default([]),
  targetSkuCodes: z.array(z.string().min(1)).default([]),
  maxUses: z.number().int().positive().max(100_000).default(100),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  rationale: z.string().max(500).optional(),
});
export type CreateClearanceCampaignDraftDTO = z.infer<typeof CreateClearanceCampaignDraftDtoSchema>;
export type CreateClearanceCampaignDraftDto = CreateClearanceCampaignDraftDTO;

export const PromotionDtoSchema = z.object({
  id: z.string().min(1),
  code: z.string().min(1),
  name: z.string().min(1),
  description: z.string().nullable(),
  type: PromoTypeSchema,
  status: PromoStatusSchema,
  discountPercent: z.number().min(0).max(100).nullable(),
  discountAmountVnd: z.number().int().nonnegative().nullable(),
  maxDiscountVnd: z.number().int().nonnegative().nullable(),
  minOrderVnd: z.number().int().nonnegative(),
  maxUses: z.number().int().positive().nullable(),
  usedCount: z.number().int().nonnegative(),
  perUserLimit: z.number().int().positive().nullable(),
  targetProductIds: z.array(z.string()),
  targetSkuCodes: z.array(z.string()),
  startsAt: z.string().nullable(),
  endsAt: z.string().nullable(),
  createdByActorType: z.enum(['USER', 'AI_COPILOT', 'SYSTEM']).default('USER'),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromotionDTO = z.infer<typeof PromotionDtoSchema>;
export type PromotionDto = PromotionDTO;

export const CreatePaymentIntentDtoSchema = z.object({
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  provider: PaymentProviderSchema,
  amountVnd: z.number().int().nonnegative(),
  expiresAt: z.string().optional(),
  returnUrl: z.string().url().optional(),
  customerEmail: z.string().email().nullable().optional(),
});
export type CreatePaymentIntentDTO = z.infer<typeof CreatePaymentIntentDtoSchema>;
export type CreatePaymentIntentDto = CreatePaymentIntentDTO;

export const PaymentIntentResponseDtoSchema = z.object({
  transactionId: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  provider: PaymentProviderSchema,
  paymentUrl: z.string().nullable(),
  vietQrPayload: z.string().nullable(),
  vietQrImageUrl: z.string().nullable(),
  amountVnd: z.number().int().nonnegative(),
  expiresAt: z.string(),
});
export type PaymentIntentResponseDTO = z.infer<typeof PaymentIntentResponseDtoSchema>;
export type PaymentIntentResponseDto = PaymentIntentResponseDTO;

export const PaymentWebhookDtoSchema = z.object({
  eventId: z.string().min(1),
  provider: PaymentProviderSchema,
  orderId: z.string().min(1).optional(),
  orderCode: z.string().min(1),
  providerTransactionId: z.string().min(1),
  amountVnd: z.number().int().nonnegative(),
  status: z.enum(['SUCCEEDED', 'FAILED']).default('SUCCEEDED'),
  paidAt: z.string().optional(),
  signature: z.string().optional(),
  rawPayload: z.record(z.unknown()).optional(),
});
export type PaymentWebhookDTO = z.infer<typeof PaymentWebhookDtoSchema>;
export type PaymentWebhookDto = PaymentWebhookDTO;

export const DevSimulateWebhookDtoSchema = z.object({
  orderId: z.string().min(1).optional(),
  orderCode: z.string().min(1),
  provider: PaymentProviderSchema,
  eventId: z.string().min(1).optional(),
  amountVnd: z.number().int().nonnegative().optional(),
  simulateLate: z.boolean().default(false),
});
export type DevSimulateWebhookDTO = z.infer<typeof DevSimulateWebhookDtoSchema>;
export type DevSimulateWebhookDto = DevSimulateWebhookDTO;

export const RefundRequestDtoSchema = z.object({
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  amountVnd: z.number().int().positive(),
  reason: z.string().trim().min(1).max(500),
  rmaId: z.string().min(1).nullable().optional(),
  idempotencyKey: z.string().min(1).optional(),
});
export type RefundRequestDTO = z.infer<typeof RefundRequestDtoSchema>;
export type RefundRequestDto = RefundRequestDTO;

export const RefundResponseDtoSchema = z.object({
  refundId: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  rmaId: z.string().nullable(),
  amountVnd: z.number().int().positive(),
  status: z.enum(['COMPLETED', 'PROCESSING', 'FAILED']),
  provider: PaymentProviderSchema,
  idempotentReplay: z.boolean(),
  refundedAt: z.string(),
});
export type RefundResponseDTO = z.infer<typeof RefundResponseDtoSchema>;
export type RefundResponseDto = RefundResponseDTO;
