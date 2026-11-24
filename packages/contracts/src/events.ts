import { z } from 'zod';

export const RABBITMQ_EXCHANGES = {
  DOMAIN_TOPIC: 'atelier.domain.topic',
  TRYON_DIRECT: 'atelier.tryon.direct',
  DLX_DIRECT: 'atelier.dlx.direct',
} as const;

export type RabbitMqExchange = (typeof RABBITMQ_EXCHANGES)[keyof typeof RABBITMQ_EXCHANGES];

export const TRYON_QUEUE_PREFETCH = 2 as const;
export const RETRY_BACKOFF_MS = [2000, 10000, 30000] as const;
export const DLQ_SUFFIX = '.dlq' as const;

export const EVENT_NAMES = {
  // Order / Inventory / Payment / RMA Saga
  ORDER_CREATED: 'order.created',
  INVENTORY_STOCK_RESERVED: 'inventory.stock.reserved',
  INVENTORY_STOCK_RESERVE_FAILED: 'inventory.stock.reserve_failed',
  PAYMENT_SUCCEEDED: 'payment.succeeded',
  PAYMENT_EXPIRED: 'payment.expired',
  PAYMENT_LATE_DETECTED: 'payment.late.detected',
  RMA_REQUESTED: 'rma.requested',
  RMA_QC_PASSED: 'rma.qc_passed',

  // B2B Procurement / Media / Reviews
  MEDIA_ASSET_PROCESSED: 'media.asset.processed',
  PROCUREMENT_PO_SUBMITTED: 'procurement.po.submitted',
  PROCUREMENT_PO_CONFIRMED: 'procurement.po.confirmed',
  INVENTORY_STOCK_REPLENISHED: 'inventory.stock.replenished',
  REVIEW_FIT_STATS_AGGREGATED: 'review.fit_stats.aggregated',

  // AI Virtual Try-On Pipeline
  TRYON_JOB_QUEUED: 'tryon.job.queued',
  TRYON_JOB_PROGRESS: 'tryon.job.progress',
  TRYON_JOB_COMPLETED: 'tryon.job.completed',
  TRYON_JOB_FAILED: 'tryon.job.failed',
  TRYON_MEDIA_PURGED: 'tryon.media.purged',
} as const;

export type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES];

export const EventNameSchema = z.enum([
  EVENT_NAMES.ORDER_CREATED,
  EVENT_NAMES.INVENTORY_STOCK_RESERVED,
  EVENT_NAMES.INVENTORY_STOCK_RESERVE_FAILED,
  EVENT_NAMES.PAYMENT_SUCCEEDED,
  EVENT_NAMES.PAYMENT_EXPIRED,
  EVENT_NAMES.PAYMENT_LATE_DETECTED,
  EVENT_NAMES.RMA_REQUESTED,
  EVENT_NAMES.RMA_QC_PASSED,
  EVENT_NAMES.MEDIA_ASSET_PROCESSED,
  EVENT_NAMES.PROCUREMENT_PO_SUBMITTED,
  EVENT_NAMES.PROCUREMENT_PO_CONFIRMED,
  EVENT_NAMES.INVENTORY_STOCK_REPLENISHED,
  EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED,
  EVENT_NAMES.TRYON_JOB_QUEUED,
  EVENT_NAMES.TRYON_JOB_PROGRESS,
  EVENT_NAMES.TRYON_JOB_COMPLETED,
  EVENT_NAMES.TRYON_JOB_FAILED,
  EVENT_NAMES.TRYON_MEDIA_PURGED,
]);

export interface EventEnvelope<T> {
  eventId: string;
  eventName: EventName;
  eventVersion: string;
  occurredAt: string;
  correlationId: string;
  producer: string;
  idempotencyKey: string;
  payload: T;
}

export function createEventEnvelopeSchema<T extends z.ZodTypeAny>(payloadSchema: T) {
  return z.object({
    eventId: z.string().uuid(),
    eventName: EventNameSchema,
    eventVersion: z.string().min(1),
    occurredAt: z.string().datetime(),
    correlationId: z.string().min(1),
    producer: z.string().min(1),
    idempotencyKey: z.string().min(1),
    payload: payloadSchema,
  });
}

function generateUuid(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    return cryptoApi.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = Math.floor(Math.random() * 16);
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export interface CreateEventEnvelopeOptions<T> {
  eventName: EventName;
  producer: string;
  correlationId: string;
  payload: T;
  eventVersion?: string;
  idempotencyKey?: string;
  eventId?: string;
  occurredAt?: string;
}

export function createEventEnvelope<T>(
  options: CreateEventEnvelopeOptions<T>,
): EventEnvelope<T> {
  const eventId = options.eventId ?? generateUuid();
  return {
    eventId,
    eventName: options.eventName,
    eventVersion: options.eventVersion ?? '1.0.0',
    occurredAt: options.occurredAt ?? new Date().toISOString(),
    correlationId: options.correlationId,
    producer: options.producer,
    idempotencyKey: options.idempotencyKey ?? eventId,
    payload: options.payload,
  };
}

// ============================================================================
// 1. Order / Inventory / Payment / RMA Event Payloads
// ============================================================================

export const OrderItemLineSchema = z.object({
  skuCode: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1),
  size: z.string().min(1),
  quantity: z.number().int().positive(),
  unitPriceVnd: z.number().int().nonnegative(),
  allocatedDiscountVnd: z.number().int().nonnegative().default(0),
});

export const OrderCreatedPayloadSchema = z.object({
  orderId: z.string().min(1),
  orderCode: z.string().min(1),
  customerId: z.string().min(1),
  paymentMethod: z.enum(['VNPAY', 'MOMO', 'VIETQR', 'COD']),
  totalAmountVnd: z.number().int().nonnegative(),
  currency: z.literal('VND').default('VND'),
  items: z.array(OrderItemLineSchema).min(1),
  expiresAt: z.string().datetime(),
});
export type OrderCreatedPayload = z.infer<typeof OrderCreatedPayloadSchema>;

export const InventoryStockReservedPayloadSchema = z.object({
  reservationId: z.string().min(1),
  orderId: z.string().min(1),
  warehouseId: z.string().min(1),
  reservedItems: z.array(
    z.object({
      skuCode: z.string().min(1),
      quantity: z.number().int().positive(),
    }),
  ),
  expiresAt: z.string().datetime(),
});
export type InventoryStockReservedPayload = z.infer<typeof InventoryStockReservedPayloadSchema>;

export const InventoryStockReserveFailedPayloadSchema = z.object({
  orderId: z.string().min(1),
  reason: z.string().min(1),
  shortages: z.array(
    z.object({
      skuCode: z.string().min(1),
      requestedQty: z.number().int().positive(),
      availableQty: z.number().int().nonnegative(),
    }),
  ),
});
export type InventoryStockReserveFailedPayload = z.infer<
  typeof InventoryStockReserveFailedPayloadSchema
>;

export const PaymentSucceededPayloadSchema = z.object({
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  provider: z.enum(['VNPAY', 'MOMO', 'VIETQR', 'COD']),
  providerTransactionId: z.string().min(1),
  amountVnd: z.number().int().nonnegative(),
  paidAt: z.string().datetime(),
});
export type PaymentSucceededPayload = z.infer<typeof PaymentSucceededPayloadSchema>;

export const PaymentExpiredPayloadSchema = z.object({
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  provider: z.enum(['VNPAY', 'MOMO', 'VIETQR']),
  expiredAt: z.string().datetime(),
});
export type PaymentExpiredPayload = z.infer<typeof PaymentExpiredPayloadSchema>;

export const PaymentLateDetectedPayloadSchema = z.object({
  paymentId: z.string().min(1),
  orderId: z.string().min(1),
  provider: z.enum(['VNPAY', 'MOMO', 'VIETQR']),
  providerTransactionId: z.string().min(1),
  amountVnd: z.number().int().nonnegative(),
  detectedAt: z.string().datetime(),
  recommendedAction: z.enum(['MANUAL_RECONCILE', 'AUTO_REFUND_REVIEW']),
});
export type PaymentLateDetectedPayload = z.infer<typeof PaymentLateDetectedPayloadSchema>;

export const RmaRequestedPayloadSchema = z.object({
  rmaId: z.string().min(1),
  orderId: z.string().min(1),
  customerId: z.string().min(1),
  rmaType: z.enum(['SIZE_EXCHANGE', 'RETURN_REFUND', 'DEFECT_REPLACEMENT']),
  reasonCode: z.enum(['TOO_SMALL', 'TOO_LARGE', 'STYLE_MISMATCH', 'DEFECTIVE', 'OTHER']),
  originalSkuCode: z.string().min(1),
  requestedReplacementSkuCode: z.string().min(1).optional(),
  quantity: z.number().int().positive(),
});
export type RmaRequestedPayload = z.infer<typeof RmaRequestedPayloadSchema>;

export const RmaQcPassedPayloadSchema = z.object({
  rmaId: z.string().min(1),
  orderId: z.string().min(1),
  warehouseId: z.string().min(1),
  inspectorId: z.string().min(1),
  returnedSkuCode: z.string().min(1),
  restockable: z.boolean(),
  replacementSkuCode: z.string().min(1).optional(),
  refundAmountVnd: z.number().int().nonnegative().optional(),
  inspectedAt: z.string().datetime(),
});
export type RmaQcPassedPayload = z.infer<typeof RmaQcPassedPayloadSchema>;

// ============================================================================
// 2. B2B Procurement / Media / Reviews Event Payloads
// ============================================================================

export const MediaAssetProcessedPayloadSchema = z.object({
  assetId: z.string().min(1),
  productId: z.string().min(1),
  variantId: z.string().min(1).optional(),
  bucket: z.enum(['atelier-public', 'atelier-garments', 'atelier-private-tryon']),
  objectKey: z.string().min(1),
  assetType: z.enum(['RACK_FRONT', 'RACK_BACK', 'GARMENT_FLAT_TRYON', 'LOOKBOOK', 'STUDIO_LAYER']),
  widthPx: z.number().int().positive(),
  heightPx: z.number().int().positive(),
  hasAlphaChannel: z.boolean(),
  autoAttachAsTryOnGarment: z.literal(false).default(false),
  requiresHumanApproval: z.boolean().default(true),
});
export type MediaAssetProcessedPayload = z.infer<typeof MediaAssetProcessedPayloadSchema>;

export const ProcurementPoSubmittedPayloadSchema = z.object({
  poId: z.string().min(1),
  poNumber: z.string().min(1),
  supplierId: z.string().min(1),
  approvedByUserId: z.string().min(1),
  items: z.array(
    z.object({
      skuCode: z.string().min(1),
      orderedQty: z.number().int().positive(),
    }),
  ),
  expectedDeliveryDate: z.string(),
  submittedAt: z.string().datetime(),
});
export type ProcurementPoSubmittedPayload = z.infer<typeof ProcurementPoSubmittedPayloadSchema>;

export const ProcurementPoConfirmedPayloadSchema = z.object({
  poId: z.string().min(1),
  poNumber: z.string().min(1),
  supplierId: z.string().min(1),
  confirmedBySupplierUserId: z.string().min(1),
  confirmedDeliveryDate: z.string(),
  confirmedAt: z.string().datetime(),
});
export type ProcurementPoConfirmedPayload = z.infer<typeof ProcurementPoConfirmedPayloadSchema>;

export const InventoryStockReplenishedPayloadSchema = z.object({
  grnId: z.string().min(1),
  poId: z.string().min(1),
  warehouseId: z.string().min(1),
  supplierId: z.string().min(1),
  items: z.array(
    z.object({
      skuCode: z.string().min(1),
      receivedQty: z.number().int().positive(),
    }),
  ),
  replenishedAt: z.string().datetime(),
});
export type InventoryStockReplenishedPayload = z.infer<
  typeof InventoryStockReplenishedPayloadSchema
>;

export const ReviewFitStatsAggregatedPayloadSchema = z.object({
  productId: z.string().min(1),
  totalVerifiedReviews: z.number().int().nonnegative(),
  averageRating: z.number().min(0).max(5),
  fitDistribution: z.object({
    runsSmallPct: z.number().min(0).max(100),
    trueToSizePct: z.number().min(0).max(100),
    runsLargePct: z.number().min(0).max(100),
  }),
  aggregatedAt: z.string().datetime(),
});
export type ReviewFitStatsAggregatedPayload = z.infer<typeof ReviewFitStatsAggregatedPayloadSchema>;

// ============================================================================
// 3. AI Virtual Try-On Event Payloads
// ============================================================================

export const TryOnJobQueuedPayloadSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  customerId: z.string().min(1).optional(),
  productId: z.string().min(1),
  skuCode: z.string().min(1),
  garmentCategory: z.enum(['UPPER_BODY', 'LOWER_BODY', 'DRESS', 'OUTERWEAR']),
  provider: z.enum(['mock', 'fal']),
  queuedAt: z.string().datetime(),
});
export type TryOnJobQueuedPayload = z.infer<typeof TryOnJobQueuedPayloadSchema>;

export const TryOnJobProgressPayloadSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  stage: z.enum(['VALIDATING', 'POSE_ESTIMATION', 'WARPING', 'RENDERING', 'UPLOADING']),
  progressPct: z.number().int().min(0).max(100),
  updatedAt: z.string().datetime(),
});
export type TryOnJobProgressPayload = z.infer<typeof TryOnJobProgressPayloadSchema>;

export const TryOnJobCompletedPayloadSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  productId: z.string().min(1),
  skuCode: z.string().min(1),
  resultObjectKey: z.string().min(1),
  bucket: z.literal('atelier-private-tryon'),
  expiresAt: z.string().datetime(),
  latencyMs: z.number().int().nonnegative(),
  estimatedCostUsd: z.number().nonnegative(),
  completedAt: z.string().datetime(),
});
export type TryOnJobCompletedPayload = z.infer<typeof TryOnJobCompletedPayloadSchema>;

export const TryOnJobFailedPayloadSchema = z.object({
  jobId: z.string().min(1),
  sessionId: z.string().min(1),
  errorCode: z.string().min(1),
  reason: z.string().min(1),
  retryable: z.boolean(),
  failedAt: z.string().datetime(),
});
export type TryOnJobFailedPayload = z.infer<typeof TryOnJobFailedPayloadSchema>;

export const TryOnMediaPurgedPayloadSchema = z.object({
  jobId: z.string().min(1),
  bucket: z.literal('atelier-private-tryon'),
  purgedObjectKeys: z.array(z.string().min(1)),
  purgeReason: z.enum(['TTL_EXPIRED', 'USER_DELETED', 'PRIVACY_SWEEP']),
  purgedAt: z.string().datetime(),
});
export type TryOnMediaPurgedPayload = z.infer<typeof TryOnMediaPurgedPayloadSchema>;

export const DomainEventSchemas = {
  [EVENT_NAMES.ORDER_CREATED]: OrderCreatedPayloadSchema,
  [EVENT_NAMES.INVENTORY_STOCK_RESERVED]: InventoryStockReservedPayloadSchema,
  [EVENT_NAMES.INVENTORY_STOCK_RESERVE_FAILED]: InventoryStockReserveFailedPayloadSchema,
  [EVENT_NAMES.PAYMENT_SUCCEEDED]: PaymentSucceededPayloadSchema,
  [EVENT_NAMES.PAYMENT_EXPIRED]: PaymentExpiredPayloadSchema,
  [EVENT_NAMES.PAYMENT_LATE_DETECTED]: PaymentLateDetectedPayloadSchema,
  [EVENT_NAMES.RMA_REQUESTED]: RmaRequestedPayloadSchema,
  [EVENT_NAMES.RMA_QC_PASSED]: RmaQcPassedPayloadSchema,
  [EVENT_NAMES.MEDIA_ASSET_PROCESSED]: MediaAssetProcessedPayloadSchema,
  [EVENT_NAMES.PROCUREMENT_PO_SUBMITTED]: ProcurementPoSubmittedPayloadSchema,
  [EVENT_NAMES.PROCUREMENT_PO_CONFIRMED]: ProcurementPoConfirmedPayloadSchema,
  [EVENT_NAMES.INVENTORY_STOCK_REPLENISHED]: InventoryStockReplenishedPayloadSchema,
  [EVENT_NAMES.REVIEW_FIT_STATS_AGGREGATED]: ReviewFitStatsAggregatedPayloadSchema,
  [EVENT_NAMES.TRYON_JOB_QUEUED]: TryOnJobQueuedPayloadSchema,
  [EVENT_NAMES.TRYON_JOB_PROGRESS]: TryOnJobProgressPayloadSchema,
  [EVENT_NAMES.TRYON_JOB_COMPLETED]: TryOnJobCompletedPayloadSchema,
  [EVENT_NAMES.TRYON_JOB_FAILED]: TryOnJobFailedPayloadSchema,
  [EVENT_NAMES.TRYON_MEDIA_PURGED]: TryOnMediaPurgedPayloadSchema,
} as const;
