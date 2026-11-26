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
  INACTIVE: 'INACTIVE',
  PAUSED: 'PAUSED',
  EXPIRED: 'EXPIRED',
  ARCHIVED: 'ARCHIVED',
} as const;
export type PromoStatus = (typeof PromoStatus)[keyof typeof PromoStatus];
export const PromoStatusSchema = z.enum([
  PromoStatus.NHAP_AI,
  PromoStatus.ACTIVE,
  PromoStatus.INACTIVE,
  PromoStatus.PAUSED,
  PromoStatus.EXPIRED,
  PromoStatus.ARCHIVED,
]);

export const PromoDiscountTypeInput = {
  PERCENTAGE: 'PERCENTAGE',
  FIXED_AMOUNT: 'FIXED_AMOUNT',
  FREESHIP: 'FREESHIP',
  PERCENT: 'PERCENT',
  FIXED: 'FIXED',
  OUTFIT_COMBO: 'OUTFIT_COMBO',
  FLASH_SALE: 'FLASH_SALE',
  CLEARANCE_ODD_SIZE: 'CLEARANCE_ODD_SIZE',
} as const;
export type PromoDiscountTypeInput =
  (typeof PromoDiscountTypeInput)[keyof typeof PromoDiscountTypeInput];
export const PromoDiscountTypeInputSchema = z.enum([
  PromoDiscountTypeInput.PERCENTAGE,
  PromoDiscountTypeInput.FIXED_AMOUNT,
  PromoDiscountTypeInput.FREESHIP,
  PromoDiscountTypeInput.PERCENT,
  PromoDiscountTypeInput.FIXED,
  PromoDiscountTypeInput.OUTFIT_COMBO,
  PromoDiscountTypeInput.FLASH_SALE,
  PromoDiscountTypeInput.CLEARANCE_ODD_SIZE,
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
  approvedBy: z.string().nullable().optional(),
  approvedAt: z.string().nullable().optional(),
  discountType: z.string().optional(),
  discountValue: z.number().nonnegative().optional(),
  usageLimit: z.number().int().nonnegative().optional(),
  applicableSkus: z.array(z.string()).optional(),
  applicableSpuIds: z.array(z.string()).optional(),
  targetSizes: z.array(z.string()).optional(),
  bonusTryonCredits: z.number().int().nonnegative().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PromotionDTO = z.infer<typeof PromotionDtoSchema>;
export type PromotionDto = PromotionDTO;

export const CreatePromotionDtoSchema = z
  .object({
    code: z.string().trim().min(2).max(64),
    name: z.string().trim().min(2).max(255).optional(),
    title: z.string().trim().min(2).max(255).optional(),
    description: z.string().max(1000).nullable().optional(),
    discountType: PromoDiscountTypeInputSchema.optional(),
    type: PromoDiscountTypeInputSchema.optional(),
    promoType: PromoDiscountTypeInputSchema.optional(),
    discountValue: z.coerce.number().min(0).optional(),
    discountPercent: z.coerce.number().min(0).max(100).optional(),
    discountAmountVnd: z.coerce.number().int().nonnegative().optional(),
    maxDiscountVnd: z.coerce.number().int().nonnegative().nullable().optional(),
    minOrderVnd: z.coerce.number().int().nonnegative().optional(),
    usageLimit: z.coerce.number().int().positive().max(1_000_000).optional(),
    maxUses: z.coerce.number().int().positive().max(1_000_000).optional(),
    perUserLimit: z.coerce.number().int().positive().max(10_000).optional(),
    startsAt: z.string().nullable().optional(),
    endsAt: z.string().nullable().optional(),
    applicableSkus: z.array(z.string().min(1)).optional(),
    targetSkuCodes: z.array(z.string().min(1)).optional(),
    applicableSpuIds: z.array(z.string().min(1)).optional(),
    targetProductIds: z.array(z.string().min(1)).optional(),
    targetSizes: z.array(z.string().trim().min(1)).optional(),
    bonusTryonCredits: z.coerce.number().int().nonnegative().max(100).optional(),
    status: PromoStatusSchema.optional(),
    createdByActorType: z.enum(['USER', 'AI_COPILOT', 'SYSTEM']).optional(),
  })
  .refine((val) => Boolean(val.name || val.title), {
    message: 'Either name or title is required',
  });
export type CreatePromotionDTO = z.infer<typeof CreatePromotionDtoSchema>;
export type CreatePromotionDto = CreatePromotionDTO;

export const UpdatePromotionDtoSchema = z.object({
  code: z.string().trim().min(2).max(64).optional(),
  name: z.string().trim().min(2).max(255).optional(),
  title: z.string().trim().min(2).max(255).optional(),
  description: z.string().max(1000).nullable().optional(),
  discountType: PromoDiscountTypeInputSchema.optional(),
  type: PromoDiscountTypeInputSchema.optional(),
  promoType: PromoDiscountTypeInputSchema.optional(),
  discountValue: z.coerce.number().min(0).optional(),
  discountPercent: z.coerce.number().min(0).max(100).nullable().optional(),
  discountAmountVnd: z.coerce.number().int().nonnegative().nullable().optional(),
  maxDiscountVnd: z.coerce.number().int().nonnegative().nullable().optional(),
  minOrderVnd: z.coerce.number().int().nonnegative().optional(),
  usageLimit: z.coerce.number().int().positive().max(1_000_000).optional(),
  maxUses: z.coerce.number().int().positive().max(1_000_000).optional(),
  perUserLimit: z.coerce.number().int().positive().max(10_000).optional(),
  startsAt: z.string().nullable().optional(),
  endsAt: z.string().nullable().optional(),
  applicableSkus: z.array(z.string().min(1)).optional(),
  targetSkuCodes: z.array(z.string().min(1)).optional(),
  applicableSpuIds: z.array(z.string().min(1)).optional(),
  targetProductIds: z.array(z.string().min(1)).optional(),
  targetSizes: z.array(z.string().trim().min(1)).optional(),
  bonusTryonCredits: z.coerce.number().int().nonnegative().max(100).optional(),
  status: PromoStatusSchema.optional(),
  isActive: z.boolean().optional(),
});
export type UpdatePromotionDTO = z.infer<typeof UpdatePromotionDtoSchema>;
export type UpdatePromotionDto = UpdatePromotionDTO;

export const ApprovePromotionDraftDtoSchema = z
  .object({
    approvedBy: z.string().trim().min(1).max(180).optional(),
    note: z.string().max(500).optional(),
  })
  .optional();
export type ApprovePromotionDraftDTO = z.infer<typeof ApprovePromotionDraftDtoSchema>;
export type ApprovePromotionDraftDto = ApprovePromotionDraftDTO;

export const AdminPromotionsQuerySchema = z.object({
  status: z.string().trim().optional(),
  type: z.string().trim().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type AdminPromotionsQuery = z.infer<typeof AdminPromotionsQuerySchema>;

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

export const PaymentBankInfoSchema = z.object({
  bankBin: z.string(),
  bankCode: z.string().optional(),
  bankName: z.string().optional(),
  accountNo: z.string(),
  accountName: z.string(),
});
export type PaymentBankInfoDTO = z.infer<typeof PaymentBankInfoSchema>;

export const PaymentIntentResponseDtoSchema = z.object({
  transactionId: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  provider: PaymentProviderSchema,
  paymentUrl: z.string().nullable(),
  vietQrPayload: z.string().nullable(),
  vietQrImageUrl: z.string().nullable(),
  sepayQrImageUrl: z.string().nullable().optional(),
  transferContent: z.string().nullable().optional(),
  vietqrProvider: z.enum(['SEPAY', 'PAYOS', 'LOCAL']).optional(),
  providerMode: z.enum(['LIVE', 'SANDBOX_LOCAL']).optional(),
  bankInfo: PaymentBankInfoSchema.nullable().optional(),
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

export const PaymentRefundRecordDtoSchema = z.object({
  id: z.string().min(1),
  refundId: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  rmaId: z.string().nullable(),
  amountVnd: z.number().int().nonnegative(),
  status: PaymentTransactionStatusSchema,
  provider: PaymentProviderSchema,
  providerTxId: z.string().nullable(),
  reason: z.string().nullable(),
  refundedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PaymentRefundRecordDTO = z.infer<typeof PaymentRefundRecordDtoSchema>;
export type PaymentRefundRecordDto = PaymentRefundRecordDTO;

export const PaymentTransactionAdminDtoSchema = z.object({
  id: z.string().min(1),
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  provider: PaymentProviderSchema,
  method: PaymentProviderSchema,
  txType: z.enum(['CHARGE', 'REFUND']),
  amountVnd: z.number().int().nonnegative(),
  refundedAmountVnd: z.number().int().nonnegative(),
  netRefundableVnd: z.number().int().nonnegative(),
  status: PaymentTransactionStatusSchema,
  providerTxId: z.string().nullable(),
  idempotencyKey: z.string().min(1),
  qrPayload: z.string().nullable(),
  paymentUrl: z.string().nullable(),
  signatureVerified: z.boolean(),
  expiresAt: z.string().nullable(),
  paidAt: z.string().nullable(),
  createdAt: z.string(),
  refunds: z.array(PaymentRefundRecordDtoSchema),
});
export type PaymentTransactionAdminDTO = z.infer<typeof PaymentTransactionAdminDtoSchema>;
export type PaymentTransactionAdminDto = PaymentTransactionAdminDTO;

export const PaymentWebhookLogDtoSchema = z.object({
  id: z.string().min(1),
  provider: PaymentProviderSchema,
  providerEventId: z.string().min(1),
  eventId: z.string().min(1),
  orderCode: z.string().nullable(),
  signatureValid: z.boolean(),
  signatureHeader: z.string().nullable().optional(),
  status: z.string().min(1),
  payloadSummary: z.string().nullable().optional(),
  rawPayload: z.record(z.unknown()).nullable().optional(),
  receivedAt: z.string(),
});
export type PaymentWebhookLogDTO = z.infer<typeof PaymentWebhookLogDtoSchema>;
export type PaymentWebhookLogDto = PaymentWebhookLogDTO;

export const AdminPaymentTransactionsQuerySchema = z.object({
  method: z.string().trim().optional(),
  provider: z.string().trim().optional(),
  status: z.string().trim().optional(),
  orderCode: z.string().trim().optional(),
  q: z.string().trim().optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type AdminPaymentTransactionsQuery = z.infer<typeof AdminPaymentTransactionsQuerySchema>;

export const AdminPaymentWebhooksQuerySchema = z.object({
  provider: z.string().trim().optional(),
  orderCode: z.string().trim().optional(),
  signatureValid: z.union([z.boolean(), z.string()]).optional(),
  page: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().positive().max(200).optional(),
});
export type AdminPaymentWebhooksQuery = z.infer<typeof AdminPaymentWebhooksQuerySchema>;

export const SePayWebhookPayloadSchema = z.object({
  id: z.union([z.number().int(), z.string().min(1)]),
  gateway: z.string().default(''),
  transactionDate: z.string().optional().default(''),
  accountNumber: z.string().default(''),
  subAccount: z.string().nullable().optional(),
  code: z.string().nullable().optional(),
  content: z.string().default(''),
  transferType: z.enum(['in', 'out']),
  description: z.string().nullable().optional(),
  transferAmount: z.coerce.number().nonnegative(),
  accumulated: z.coerce.number().optional(),
  referenceCode: z.string().nullable().optional(),
});
export type SePayWebhookPayloadDTO = z.infer<typeof SePayWebhookPayloadSchema>;

export const SePayConfigStatusSchema = z.object({
  enabled: z.boolean(),
  activeVietQrProvider: z.enum(['SEPAY', 'PAYOS', 'LOCAL']),
  mode: z.enum(['LIVE', 'SANDBOX_LOCAL']),
  bankCode: z.string(),
  bankBin: z.string(),
  bankName: z.string(),
  accountNoMasked: z.string(),
  accountName: z.string(),
  orderPrefix: z.string(),
  qrTemplate: z.string(),
  webhookUrl: z.string(),
  webhookAuthHeaderExample: z.string(),
  webhookApiKeyConfigured: z.boolean(),
  apiTokenConfigured: z.boolean(),
  autoPollEnabled: z.boolean(),
  pollIntervalMs: z.number().int().positive(),
  lastPollAt: z.string().nullable(),
  lastPollError: z.string().nullable(),
  pendingVietQrCount: z.number().int().nonnegative(),
});
export type SePayConfigStatusDTO = z.infer<typeof SePayConfigStatusSchema>;

export const SePaySyncResultSchema = z.object({
  ok: z.boolean(),
  mode: z.enum(['LIVE', 'SANDBOX_LOCAL']),
  checkedPendingCount: z.number().int().nonnegative(),
  fetchedTransactionsCount: z.number().int().nonnegative(),
  settledOrderCodes: z.array(z.string()),
  skippedReason: z.string().nullable(),
  syncedAt: z.string(),
});
export type SePaySyncResultDTO = z.infer<typeof SePaySyncResultSchema>;

export const SePayOrderStatusSchema = z.object({
  orderCode: z.string(),
  paid: z.boolean(),
  status: z.string(),
  amountVnd: z.number().int().nonnegative(),
  provider: PaymentProviderSchema,
  providerMode: z.enum(['LIVE', 'SANDBOX_LOCAL']),
  vietqrProvider: z.enum(['SEPAY', 'PAYOS', 'LOCAL']),
  sepaySyncedNow: z.boolean(),
  providerTxId: z.string().nullable(),
  paidAt: z.string().nullable(),
  orderStatus: z.string().nullable().optional(),
  message: z.string(),
});
export type SePayOrderStatusDTO = z.infer<typeof SePayOrderStatusSchema>;
