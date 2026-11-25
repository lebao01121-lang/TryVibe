import * as crypto from 'node:crypto';
import { HttpStatus, Inject, Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import {
  AdminCancelOrderDtoSchema,
  CheckoutSubmitDtoSchema,
  CompleteOrderDtoSchema,
  CompleteRmaQcDtoSchema,
  createEventEnvelope,
  ErrorCode,
  EVENT_NAMES,
  OrderStatus,
  PaymentMethod,
  RejectRmaDtoSchema,
  RmaExchangeMode,
  RmaReasonCode,
  RmaReasonCodeSchema,
  RmaStatus,
  RmaType,
  RmaTypeSchema,
  RmaExchangeModeSchema,
  ShipmentStatus,
  ShippingMethod,
  ShippingMethodSchema,
  truncateRmaCustomerNote,
  type CompleteRmaQcDTO,
  type OrderDTO,
  type OrderItemDTO,
  type PaymentIntentResponseDTO,
  type RefundResponseDTO,
  type RmaRequestDTO,
  type RmaStatsSummaryDTO,
  type ShipmentDTO,
  type ShippingAddressSnapshot,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import { createLogger, type HeaderBag } from '@atelier/observability';
import { z } from 'zod';
import {
  UpstreamServicesClient,
  type CatalogSkuSnapshot,
  type PackagingOptionInfo,
  type TraceContext,
} from '../clients/upstream-services.client';
import { ApiDomainException, parseWithZod } from '../common/api-exception';
import { ORDER_CONFIG_TOKEN, SERVICE_NAME, type OrderRmaConfig } from '../config/env';
import { OrderDbService } from '../db/order-db.service';
import { OrderRabbitMqService } from '../infra/rabbitmq.service';
import type {
  MappedWebhookOrderStatus,
  ShippingProviderSlug,
  ShippingQuoteResult,
  ShippingTrackingEventRecord,
} from '../shipping/shipping-provider.interface';
import { ShippingProviderRegistry } from '../shipping/shipping-provider.registry';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FREE_SHIP_THRESHOLD_VND = 2_000_000;
const COD_DEPOSIT_THRESHOLD_VND = 3_000_000;
const COD_TRUST_SCORE_MIN = 60;
const COD_DEPOSIT_RATE = 0.2;
const VIP_TRYON_ORDER_BONUS = 5;

/**
 * Extended checkout schema: accepts optional confirmCodDeposit & customerPhone
 * while silently stripping any client-injected price fields (e.g. unitPriceVnd).
 */
const CheckoutRequestBodySchema = CheckoutSubmitDtoSchema.extend({
  confirmCodDeposit: z.boolean().optional(),
  customerPhone: z.string().trim().max(32).optional(),
});

const PackOrderBodySchema = z.object({
  packPhotoUrl: z.string().trim().min(1).max(2048).optional(),
  pack_photo_url: z.string().trim().min(1).max(2048).optional(),
  scannedSkuCodes: z.array(z.string().trim().min(1)).optional(),
});

const CancelOrderBodySchema = z
  .object({
    reason: z.string().trim().max(300).optional(),
  })
  .optional();

const CreateRmaBodySchema = z.object({
  orderItemId: z.string().trim().min(1).optional(),
  skuId: z.string().trim().min(1).optional(),
  qty: z.coerce.number().int().positive().max(99).default(1),
  type: RmaTypeSchema.optional(),
  rmaType: RmaTypeSchema.optional(),
  exchangeMode: RmaExchangeModeSchema.default(RmaExchangeMode.STANDARD_QC),
  reasonCode: RmaReasonCodeSchema,
  targetSkuId: z.string().trim().min(1).nullable().optional(),
  replacementSkuId: z.string().trim().min(1).nullable().optional(),
  targetSkuCode: z.string().trim().min(1).nullable().optional(),
  customerNote: z.string().optional().default(''),
  evidencePhotoUrls: z.array(z.string().min(1)).max(6).optional(),
  evidencePhotos: z.array(z.string().min(1)).max(6).optional(),
});

const ApproveRmaBodySchema = z
  .object({
    replacementSkuId: z.string().trim().min(1).optional(),
    targetSkuId: z.string().trim().min(1).optional(),
    exchangeMode: RmaExchangeModeSchema.optional(),
    returnTrackingCode: z.string().trim().min(1).max(64).optional(),
    exchangeTrackingCode: z.string().trim().min(1).max(64).optional(),
  })
  .optional();

const ShippingQuoteBodySchema = z.object({
  provinceCode: z.string().trim().max(32).optional(),
  districtCode: z.string().trim().max(32).optional(),
  wardCode: z.string().trim().max(32).optional(),
  provinceName: z.string().trim().max(120).optional(),
  districtName: z.string().trim().max(120).optional(),
  wardName: z.string().trim().max(120).optional(),
  streetLine: z.string().trim().max(255).optional(),
  shippingMethod: ShippingMethodSchema.optional(),
  weightGrams: z.coerce.number().int().positive().max(50_000).optional().default(500),
  orderValueVnd: z.coerce.number().int().nonnegative().optional(),
  subtotalVnd: z.coerce.number().int().nonnegative().optional(),
  codAmountVnd: z.coerce.number().int().nonnegative().optional().default(0),
});

const ShipOrderBodySchema = z
  .object({
    trackingCode: z.string().trim().min(1).max(64).optional(),
    carrier: z.string().trim().min(1).max(32).optional(),
    shippingMethod: ShippingMethodSchema.optional(),
    weightGrams: z.coerce.number().int().positive().max(50_000).optional(),
    note: z.string().trim().max(300).optional(),
  })
  .optional();

const PaymentSucceededEventSchema = z.object({
  eventId: z.string().trim().min(1).optional(),
  providerEventId: z.string().trim().min(1).optional(),
  paymentId: z.string().trim().min(1).optional(),
  orderId: z.string().trim().min(1).optional(),
  orderCode: z.string().trim().min(1).optional(),
  provider: z.string().trim().min(1).optional(),
  providerTransactionId: z.string().trim().min(1).optional(),
  amountVnd: z.coerce.number().int().nonnegative().optional(),
  paidAt: z.string().optional(),
  simulateLate: z.boolean().optional(),
});

const TestExpireOrderSchema = z
  .object({
    orderCode: z.string().trim().min(1).optional(),
    orderId: z.string().trim().min(1).optional(),
  })
  .refine((v) => Boolean(v.orderCode || v.orderId), {
    message: 'Cần cung cấp orderCode hoặc orderId để đánh dấu hết hạn.',
  });

export interface OrderActorContext {
  userId: string | null;
  actorEmail?: string | null;
  guestSessionId: string | null;
  loyaltyTier: string | null;
  actorRoles: string[];
  isInternal: boolean;
  correlationId: string;
  traceparent?: string;
}

export interface ExtendedOrderItemDTO extends OrderItemDTO {
  sku: string;
  quantity: number;
}

export interface OrderOpsMetricsProductItem {
  productId: string;
  productName: string;
  totalOrdered: number;
  rmaCount: number;
  sizeExchangeRatePct: number;
}

export interface OrderOpsMetricsDto {
  totalOrders: number;
  confirmedPaidOrders: number;
  deliveredOrders: number;
  latePaymentAlertsCount: number;
  totalRevenueVnd: number;
  totalRmaCount: number;
  sizeExchangeRatePct: number;
  rmaByProduct: OrderOpsMetricsProductItem[];
}

export interface ExtendedShipmentDTO extends ShipmentDTO {
  actualFeeVnd?: number | null;
  providerMode?: string | null;
  expectedDeliveryTime?: string | null;
}

export interface ExtendedOrderDTO extends OrderDTO {
  customerPhone: string | null;
  packagingFeeVnd: number;
  depositRequiredVnd: number;
  grandTotalVnd: number;
  totalVnd: number;
  latePaymentRefunded: boolean;
  completedAt: string | null;
  completedBy: string | null;
  cancelledBy: string | null;
  shippingActualFeeVnd?: number | null;
  shippingProviderMode?: string | null;
  shippingTrackingEvents?: ShippingTrackingEventRecord[];
  shipment: ExtendedShipmentDTO | null;
  items: ExtendedOrderItemDTO[];
}

export interface ExtendedRmaRequestDTO extends RmaRequestDTO {
  returnTrackingCode?: string | null;
  exchangeTrackingCode?: string | null;
  shippingTrackingEvents?: ShippingTrackingEventRecord[];
}

export interface ShippingQuoteResponseDto extends ShippingQuoteResult {
  freeShippingThresholdVnd: number;
  freeShippingEligible: boolean;
  effectiveFeeVnd: number;
  quotes: ShippingQuoteResult[];
}

export interface ShippingWebhookProcessResult {
  deduplicated: boolean;
  processed: boolean;
  eventId: string;
  provider: ShippingProviderSlug;
  trackingCode: string | null;
  orderCode: string | null;
  providerStatus: string;
  mappedOrderStatus: MappedWebhookOrderStatus;
  mappedShipmentStatus: ShipmentStatus | null;
  mappedRmaStatus: RmaStatus | null;
  orderUpdated: boolean;
  rmaUpdated: boolean;
  matchedOrderCode: string | null;
  matchedRmaCode: string | null;
  occurredAt: string;
}

export interface OrderMutationResult extends ExtendedOrderDTO {
  before: ExtendedOrderDTO;
  after: ExtendedOrderDTO;
}

export interface RmaMutationResult extends RmaRequestDTO {
  before: RmaRequestDTO;
  after: RmaRequestDTO;
  customerNotified?: boolean;
}

export interface CheckoutOrderResult extends ExtendedOrderDTO {
  order: ExtendedOrderDTO;
  paymentIntent: PaymentIntentResponseDTO | null;
  idempotentReplay: boolean;
}

interface OrderRow {
  id: string;
  order_code: string;
  idempotency_key: string;
  user_id: string | null;
  guest_session_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  status: string;
  subtotal_vnd: string | number;
  combo_discount_vnd: string | number;
  voucher_discount_vnd: string | number;
  voucher_code: string | null;
  packaging_fee_vnd: string | number;
  shipping_fee_vnd: string | number;
  deposit_required_vnd: string | number;
  grand_total_vnd: string | number;
  payment_method: string;
  shipping_method: string;
  delivery_date: string | null;
  delivery_slot: string | null;
  shipping_address_jsonb: ShippingAddressSnapshot | string;
  packaging_option_jsonb: Record<string, unknown> | string | null;
  gift_note: string | null;
  reservation_id: string | null;
  reservation_expires_at: string | Date | null;
  late_payment_refunded: boolean;
  paid_at: string | Date | null;
  delivered_at: string | Date | null;
  completed_at?: string | Date | null;
  completed_by?: string | null;
  cancelled_at: string | Date | null;
  cancel_reason: string | null;
  cancelled_by?: string | null;
  payment_intent_jsonb: PaymentIntentResponseDTO | string | null;
  shipping_actual_fee_vnd?: string | number | null;
  shipping_provider_mode?: string | null;
  shipping_tracking_events_jsonb?: ShippingTrackingEventRecord[] | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface OrderItemRow {
  id: string;
  order_id: string;
  product_id: string;
  variant_id: string;
  sku_id: string;
  sku_code: string;
  product_name: string;
  color_name: string;
  size_code: string;
  image_url: string | null;
  unit_price_vnd: string | number;
  allocated_discount_vnd: string | number;
  net_refundable_unit_vnd: string | number;
  qty: string | number;
  bundle_group_id: string | null;
  is_returnable: boolean;
  supplier_batch_code: string | null;
}

interface ShipmentRow {
  id: string;
  order_id: string;
  warehouse_code: string;
  carrier: string;
  tracking_code: string;
  status: string;
  pack_photo_url: string | null;
  cod_collect_vnd: string | number;
  actual_fee_vnd?: string | number | null;
  provider_mode?: string | null;
  expected_delivery_time?: string | Date | null;
  provider_response_jsonb?: Record<string, unknown> | string | null;
  updated_at: string | Date;
}

interface RmaRow {
  id: string;
  rma_code: string;
  order_id: string;
  order_code?: string;
  user_id: string | null;
  rma_type: string;
  exchange_mode: string;
  status: string;
  reason_code: string;
  customer_note: string;
  evidence_photos_jsonb: string[] | string;
  qc_checklist_jsonb: CompleteRmaQcDTO | string | null;
  replacement_sku_id: string | null;
  exchange_reservation_id: string | null;
  refund_amount_vnd: string | number;
  refund_transaction_id: string | null;
  rejection_reason?: string | null;
  rejected_by?: string | null;
  rejected_at?: string | Date | null;
  return_tracking_code?: string | null;
  exchange_tracking_code?: string | null;
  shipping_tracking_events_jsonb?: ShippingTrackingEventRecord[] | string | null;
  created_at: string | Date;
  updated_at: string | Date;
}

interface RmaItemRow {
  id: string;
  rma_id: string;
  order_item_id: string;
  sku_id: string;
  product_id: string;
  size_purchased: string;
  qty: string | number;
  supplier_batch_code: string | null;
}

function toIsoString(value: string | Date | null | undefined): string | null {
  if (!value) {
    return null;
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? String(value) : d.toISOString();
}

function parseJsonValue<T>(raw: T | string | null | undefined, fallback: T): T {
  if (raw === null || raw === undefined) {
    return fallback;
  }
  if (typeof raw === 'string') {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }
  return raw;
}

function inferSlotFromSlugOrName(slug: string, name: string): string {
  const s = `${slug} ${name}`.toLowerCase();
  if (s.includes('blazer') || s.includes('khoac') || s.includes('trench') || s.includes('cardigan')) {
    return 'OUTERWEAR';
  }
  if (s.includes('dam-') || s.includes('đầm') || s.includes('vay-lien') || s.includes('jumpsuit')) {
    return 'ONE_PIECE';
  }
  if (s.includes('quan-') || s.includes('quần') || s.includes('chan-vay') || s.includes('chân váy')) {
    return 'BOTTOM';
  }
  if (s.includes('khan-') || s.includes('ghim-') || s.includes('phu-kien') || s.includes('khăn')) {
    return 'ACCESSORY';
  }
  return 'TOP';
}

function baseShippingFeeForMethod(method: ShippingMethod): number {
  switch (method) {
    case ShippingMethod.PICKUP:
      return 0;
    case ShippingMethod.AHAMOVE_2H:
      return 55_000;
    case ShippingMethod.GHN:
    case ShippingMethod.GHTK:
    default:
      return 35_000;
  }
}

function isHcmProvince(provinceName: string): boolean {
  const normalized = provinceName.toLowerCase();
  return (
    normalized.includes('hồ chí minh') ||
    normalized.includes('ho chi minh') ||
    normalized.includes('tp.hcm') ||
    normalized.includes('hcm') ||
    normalized.includes('sài gòn') ||
    normalized.includes('sai gon')
  );
}

function generateOrderCode(): string {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `TX-2026${suffix}`;
}

function generateRmaCode(): string {
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `RMA-2026${suffix}`;
}

function generateTrackingCode(carrier: string, orderCode: string): string {
  const prefix =
    carrier === 'AHAMOVE_2H'
      ? 'AHM2H'
      : carrier === 'GHN'
        ? 'GHN'
        : carrier === 'GHTK'
          ? 'GHTK'
          : 'PKP';
  const cleanOrder = orderCode.replace(/^TX-/, '').replace(/[^A-Z0-9]/gi, '').toUpperCase();
  const rand = crypto.randomBytes(2).toString('hex').toUpperCase();
  return `${prefix}-${cleanOrder}-${rand}`;
}

export function computeProportionalAllocations(
  lines: Array<{ skuId: string; unitPriceVnd: number; qty: number }>,
  totalDiscountVnd: number,
): Array<{ allocatedDiscountVnd: number; netRefundableUnitVnd: number }> {
  const safeTotalDiscount = Math.max(0, Math.round(totalDiscountVnd));
  const lineTotals = lines.map((l) => l.unitPriceVnd * l.qty);
  const subtotal = lineTotals.reduce((acc, v) => acc + v, 0);

  if (safeTotalDiscount === 0 || subtotal <= 0) {
    return lines.map((l) => ({
      allocatedDiscountVnd: 0,
      netRefundableUnitVnd: l.unitPriceVnd,
    }));
  }

  const cappedTotal = Math.min(subtotal, safeTotalDiscount);
  const allocated = new Array<number>(lines.length).fill(0);
  let assigned = 0;
  let largestIdx = 0;

  for (let i = 0; i < lines.length; i += 1) {
    if (lineTotals[i] > lineTotals[largestIdx]) {
      largestIdx = i;
    }
    const share = Math.floor((lineTotals[i] * cappedTotal) / subtotal);
    allocated[i] = Math.min(lineTotals[i], share);
    assigned += allocated[i];
  }

  let remainder = cappedTotal - assigned;
  if (remainder > 0) {
    // Distribute rounding remainder cleanly without exceeding any item's line total
    const indices = [largestIdx, ...lines.map((_, idx) => idx).filter((idx) => idx !== largestIdx)];
    for (const idx of indices) {
      if (remainder <= 0) {
        break;
      }
      const headroom = lineTotals[idx] - allocated[idx];
      if (headroom > 0) {
        const add = Math.min(headroom, remainder);
        allocated[idx] += add;
        remainder -= add;
      }
    }
  }

  return lines.map((l, idx) => {
    const alloc = allocated[idx];
    const netUnit = Math.max(0, Math.round((l.unitPriceVnd * l.qty - alloc) / l.qty));
    return {
      allocatedDiscountVnd: alloc,
      netRefundableUnitVnd: netUnit,
    };
  });
}

@Injectable()
export class OrderRmaService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger(`${SERVICE_NAME}:saga`);
  private sweepTimer: NodeJS.Timeout | null = null;
  private sweeping = false;

  constructor(
    @Inject(ORDER_CONFIG_TOKEN) private readonly config: OrderRmaConfig,
    private readonly db: OrderDbService,
    private readonly rabbitmq: OrderRabbitMqService,
    private readonly upstream: UpstreamServicesClient,
    private readonly shippingRegistry: ShippingProviderRegistry,
  ) {}

  onModuleInit(): void {
    this.sweepTimer = setInterval(() => {
      void this.runExpirySweep('sweeper-timer').catch((error: unknown) => {
        this.logger.warn(
          { err: error instanceof Error ? error.message : String(error) },
          'Scheduled order expiry sweep encountered an error',
        );
      });
    }, this.config.sweeperIntervalMs);
    this.sweepTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // ==========================================================================
  // Outbox & Event Helpers
  // ==========================================================================

  private async writeOutbox(
    executor: AtelierDbExecutor,
    params: {
      eventName: string;
      aggregateType: 'ORDER' | 'RMA';
      aggregateId: string;
      correlationId: string;
      payload: Record<string, unknown>;
    },
  ): Promise<string> {
    const outboxId = crypto.randomUUID();
    await executor.query(
      `INSERT INTO outbox_events (
         id, event_name, aggregate_type, aggregate_id, correlation_id, payload_jsonb
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)`,
      [
        outboxId,
        params.eventName,
        params.aggregateType,
        params.aggregateId,
        params.correlationId,
        JSON.stringify(params.payload),
      ],
    );
    return outboxId;
  }

  private async publishDomainEventNonFatal(
    routingKey: string,
    payload: Record<string, unknown>,
    correlationId: string,
    idempotencyKey?: string,
  ): Promise<void> {
    const envelope = createEventEnvelope({
      eventName: routingKey as typeof EVENT_NAMES[keyof typeof EVENT_NAMES],
      producer: SERVICE_NAME,
      correlationId,
      idempotencyKey,
      payload,
    });
    await this.rabbitmq.publishDomainEvent(
      routingKey,
      envelope as unknown as Record<string, unknown>,
    );
  }

  // ==========================================================================
  // DTO Hydration Helpers
  // ==========================================================================

  private mapOrderItemRow(row: OrderItemRow): ExtendedOrderItemDTO {
    const qty = Number(row.qty);
    return {
      id: row.id,
      orderId: row.order_id,
      productId: row.product_id,
      variantId: row.variant_id,
      skuId: row.sku_id,
      skuCode: row.sku_code,
      sku: row.sku_code,
      productName: row.product_name,
      colorName: row.color_name,
      sizeCode: row.size_code,
      imageUrl: row.image_url,
      unitPriceVnd: Number(row.unit_price_vnd),
      allocatedDiscountVnd: Number(row.allocated_discount_vnd),
      netRefundableUnitVnd: Number(row.net_refundable_unit_vnd),
      qty,
      quantity: qty,
      bundleGroupId: row.bundle_group_id,
      isReturnable: Boolean(row.is_returnable),
      supplierBatchCode: row.supplier_batch_code,
    };
  }

  private mapShipmentRow(row: ShipmentRow): ExtendedShipmentDTO {
    return {
      id: row.id,
      orderId: row.order_id,
      warehouseCode: row.warehouse_code,
      carrier: row.carrier,
      trackingCode: row.tracking_code,
      status: row.status as ShipmentStatus,
      packPhotoUrl: row.pack_photo_url,
      codCollectVnd: Number(row.cod_collect_vnd),
      actualFeeVnd:
        row.actual_fee_vnd !== null && row.actual_fee_vnd !== undefined
          ? Number(row.actual_fee_vnd)
          : null,
      providerMode: row.provider_mode ?? null,
      expectedDeliveryTime: toIsoString(row.expected_delivery_time),
      updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    };
  }

  private mapOrderRow(
    row: OrderRow,
    items: ExtendedOrderItemDTO[],
    shipment: ExtendedShipmentDTO | null,
  ): ExtendedOrderDTO {
    const shippingAddress = parseJsonValue<ShippingAddressSnapshot>(row.shipping_address_jsonb, {
      recipientName: '',
      phone: row.customer_phone ?? '',
      provinceName: '',
      districtName: '',
      wardName: '',
      streetLine: '',
    });
    const packagingObj = parseJsonValue<Record<string, unknown> | null>(
      row.packaging_option_jsonb,
      null,
    );
    const paymentIntent = parseJsonValue<PaymentIntentResponseDTO | null>(
      row.payment_intent_jsonb,
      null,
    );
    const shippingTrackingEvents = parseJsonValue<ShippingTrackingEventRecord[]>(
      row.shipping_tracking_events_jsonb,
      [],
    );
    const packagingFeeVnd = Number(row.packaging_fee_vnd);
    const grandTotalVnd = Number(row.grand_total_vnd);
    const depositRequiredVnd = Number(row.deposit_required_vnd);

    return {
      id: row.id,
      orderCode: row.order_code,
      userId: row.user_id,
      guestSessionId: row.guest_session_id,
      customerEmail: row.customer_email,
      customerPhone: row.customer_phone,
      status: row.status as OrderStatus,
      paymentMethod: row.payment_method as PaymentMethod,
      shippingMethod: row.shipping_method as ShippingMethod,
      shippingAddress,
      deliveryDate: row.delivery_date,
      deliverySlot: row.delivery_slot,
      packagingOptionId:
        packagingObj && typeof packagingObj.id === 'string' ? packagingObj.id : null,
      packagingPriceVnd: packagingFeeVnd,
      packagingFeeVnd,
      giftNote: row.gift_note,
      voucherCode: row.voucher_code,
      subtotalVnd: Number(row.subtotal_vnd),
      comboDiscountVnd: Number(row.combo_discount_vnd),
      voucherDiscountVnd: Number(row.voucher_discount_vnd),
      shippingFeeVnd: Number(row.shipping_fee_vnd),
      shippingActualFeeVnd:
        row.shipping_actual_fee_vnd !== null && row.shipping_actual_fee_vnd !== undefined
          ? Number(row.shipping_actual_fee_vnd)
          : null,
      shippingProviderMode: row.shipping_provider_mode ?? null,
      shippingTrackingEvents: Array.isArray(shippingTrackingEvents)
        ? shippingTrackingEvents
        : [],
      totalAmountVnd: grandTotalVnd,
      grandTotalVnd,
      totalVnd: grandTotalVnd,
      codDepositRequiredVnd: depositRequiredVnd,
      depositRequiredVnd,
      latePaymentRefunded: Boolean(row.late_payment_refunded),
      reservationId: row.reservation_id,
      reservationExpiresAt: toIsoString(row.reservation_expires_at),
      paidAt: toIsoString(row.paid_at),
      deliveredAt: toIsoString(row.delivered_at),
      completedAt: toIsoString(row.completed_at),
      completedBy: row.completed_by ?? null,
      cancelledAt: toIsoString(row.cancelled_at),
      cancelReason: row.cancel_reason,
      cancelledBy: row.cancelled_by ?? null,
      items,
      shipment,
      paymentIntent,
      createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
      updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
    };
  }

  private async hydrateOrders(orderRows: OrderRow[]): Promise<ExtendedOrderDTO[]> {
    if (orderRows.length === 0) {
      return [];
    }
    const orderIds = orderRows.map((o) => o.id);

    const [itemsRes, shipmentsRes] = await Promise.all([
      this.db.query<OrderItemRow>(
        'SELECT * FROM order_items WHERE order_id = ANY($1::uuid[]) ORDER BY id ASC',
        [orderIds],
      ),
      this.db.query<ShipmentRow>(
        'SELECT * FROM shipments WHERE order_id = ANY($1::uuid[]) ORDER BY updated_at DESC',
        [orderIds],
      ),
    ]);

    const itemsByOrder = new Map<string, ExtendedOrderItemDTO[]>();
    for (const row of itemsRes.rows) {
      const list = itemsByOrder.get(row.order_id) ?? [];
      list.push(this.mapOrderItemRow(row));
      itemsByOrder.set(row.order_id, list);
    }

    const shipmentByOrder = new Map<string, ExtendedShipmentDTO>();
    for (const row of shipmentsRes.rows) {
      if (!shipmentByOrder.has(row.order_id)) {
        shipmentByOrder.set(row.order_id, this.mapShipmentRow(row));
      }
    }

    return orderRows.map((row) =>
      this.mapOrderRow(row, itemsByOrder.get(row.id) ?? [], shipmentByOrder.get(row.id) ?? null),
    );
  }

  private async loadOrderRowByCodeOrId(codeOrId: string): Promise<OrderRow | null> {
    const trimmed = codeOrId.trim();
    if (!trimmed) {
      return null;
    }
    if (UUID_REGEX.test(trimmed)) {
      const res = await this.db.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1::uuid OR order_code = $2 LIMIT 1',
        [trimmed, trimmed],
      );
      return res.rows[0] ?? null;
    }
    const res = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE order_code = $1 LIMIT 1',
      [trimmed],
    );
    return res.rows[0] ?? null;
  }

  private async hydrateRmas(rmaRows: RmaRow[]): Promise<ExtendedRmaRequestDTO[]> {
    if (rmaRows.length === 0) {
      return [];
    }
    const rmaIds = rmaRows.map((r) => r.id);
    const orderIds = Array.from(new Set(rmaRows.map((r) => r.order_id)));

    const [itemsRes, ordersRes] = await Promise.all([
      this.db.query<RmaItemRow>(
        'SELECT * FROM rma_items WHERE rma_id = ANY($1::uuid[]) ORDER BY id ASC',
        [rmaIds],
      ),
      this.db.query<{ id: string; order_code: string }>(
        'SELECT id, order_code FROM orders WHERE id = ANY($1::uuid[])',
        [orderIds],
      ),
    ]);

    const itemByRma = new Map<string, RmaItemRow>();
    for (const row of itemsRes.rows) {
      if (!itemByRma.has(row.rma_id)) {
        itemByRma.set(row.rma_id, row);
      }
    }

    const orderCodeById = new Map<string, string>();
    for (const row of ordersRes.rows) {
      orderCodeById.set(row.id, row.order_code);
    }

    return rmaRows.map((row) => {
      const item = itemByRma.get(row.id);
      const evidencePhotoUrls = parseJsonValue<string[]>(row.evidence_photos_jsonb, []);
      const qcResult = parseJsonValue<CompleteRmaQcDTO | null>(row.qc_checklist_jsonb, null);
      const shippingTrackingEvents = parseJsonValue<ShippingTrackingEventRecord[]>(
        row.shipping_tracking_events_jsonb,
        [],
      );
      const refundAmount = Number(row.refund_amount_vnd ?? 0);

      return {
        id: row.id,
        rmaCode: row.rma_code,
        orderId: row.order_id,
        orderCode: row.order_code ?? orderCodeById.get(row.order_id),
        orderItemId: item?.order_item_id ?? '',
        userId: row.user_id,
        productId: item?.product_id ?? '',
        skuId: item?.sku_id ?? '',
        targetSkuId: row.replacement_sku_id,
        qty: item ? Number(item.qty) : 1,
        type: row.rma_type as RmaType,
        exchangeMode: row.exchange_mode as RmaExchangeMode,
        reasonCode: row.reason_code as RmaReasonCode,
        status: row.status as RmaStatus,
        customerNote: truncateRmaCustomerNote(row.customer_note),
        evidencePhotoUrls: Array.isArray(evidencePhotoUrls) ? evidencePhotoUrls : [],
        exchangeReservationId: row.exchange_reservation_id,
        refundAmountVnd: refundAmount > 0 ? refundAmount : null,
        refundTransactionId: row.refund_transaction_id,
        qcResult,
        rejectionReason: row.rejection_reason ?? null,
        rejectedBy: row.rejected_by ?? null,
        rejectedAt: toIsoString(row.rejected_at),
        supplierBatchCode: item?.supplier_batch_code ?? null,
        returnTrackingCode: row.return_tracking_code ?? null,
        exchangeTrackingCode: row.exchange_tracking_code ?? null,
        shippingTrackingEvents: Array.isArray(shippingTrackingEvents)
          ? shippingTrackingEvents
          : [],
        createdAt: toIsoString(row.created_at) ?? new Date().toISOString(),
        updatedAt: toIsoString(row.updated_at) ?? new Date().toISOString(),
      };
    });
  }

  private async ensureShipmentForOrder(
    executor: AtelierDbExecutor,
    order: {
      id: string;
      order_code: string;
      shipping_method: string;
      payment_method: string;
      grand_total_vnd: string | number;
      deposit_required_vnd: string | number;
      shipping_address_jsonb: ShippingAddressSnapshot | string;
    },
    preferredWarehouseCode?: string,
  ): Promise<ShipmentDTO> {
    const existing = await executor.query<ShipmentRow>(
      'SELECT * FROM shipments WHERE order_id = $1 LIMIT 1',
      [order.id],
    );
    if (existing.rows.length > 0) {
      return this.mapShipmentRow(existing.rows[0]);
    }

    const address = parseJsonValue<ShippingAddressSnapshot>(order.shipping_address_jsonb, {
      recipientName: '',
      phone: '',
      provinceName: '',
      districtName: '',
      wardName: '',
      streetLine: '',
    });

    const shippingMethod = order.shipping_method as ShippingMethod;
    let warehouseCode = preferredWarehouseCode || 'CENTRAL_HN';
    if (shippingMethod === ShippingMethod.AHAMOVE_2H || shippingMethod === ShippingMethod.PICKUP) {
      warehouseCode = isHcmProvince(address.provinceName || '') ? 'HCM_SHOWROOM' : 'HN_ATELIER';
    } else if (!preferredWarehouseCode) {
      warehouseCode = isHcmProvince(address.provinceName || '') ? 'HCM_SHOWROOM' : 'CENTRAL_HN';
    }

    const carrier =
      shippingMethod === ShippingMethod.PICKUP ? 'SHOWROOM_PICKUP' : shippingMethod;
    const trackingCode = generateTrackingCode(carrier, order.order_code);
    const codCollectVnd =
      order.payment_method === PaymentMethod.COD
        ? Math.max(0, Number(order.grand_total_vnd) - Number(order.deposit_required_vnd))
        : 0;

    const shipmentId = crypto.randomUUID();
    const inserted = await executor.query<ShipmentRow>(
      `INSERT INTO shipments (
         id, order_id, warehouse_code, carrier, tracking_code,
         status, pack_photo_url, cod_collect_vnd, updated_at
       ) VALUES ($1, $2, $3, $4, $5, $6, NULL, $7, NOW())
       RETURNING *`,
      [
        shipmentId,
        order.id,
        warehouseCode,
        carrier,
        trackingCode,
        ShipmentStatus.READY_TO_PICK,
        codCollectVnd,
      ],
    );

    return this.mapShipmentRow(inserted.rows[0]);
  }

  // ==========================================================================
  // 1. Checkout Order Saga (POST /v1/orders)
  // ==========================================================================

  async createOrder(
    rawBody: unknown,
    idempotencyKey: string | undefined,
    actor: OrderActorContext,
  ): Promise<CheckoutOrderResult> {
    if (!idempotencyKey || idempotencyKey.trim().length === 0) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Header Idempotency-Key là bắt buộc cho yêu cầu tạo đơn hàng.',
      );
    }
    const cleanIdempotencyKey = idempotencyKey.trim().slice(0, 128);

    // 1. Idempotency check BEFORE executing any downstream side effects
    const existingByKey = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE idempotency_key = $1 LIMIT 1',
      [cleanIdempotencyKey],
    );
    if (existingByKey.rows.length > 0) {
      const [hydrated] = await this.hydrateOrders([existingByKey.rows[0]]);
      return {
        ...hydrated,
        order: hydrated,
        paymentIntent: hydrated.paymentIntent ?? null,
        idempotentReplay: true,
      };
    }

    // 2. Validate payload (client price fields are automatically stripped by Zod)
    const input = parseWithZod(CheckoutRequestBodySchema, rawBody);

    // 3. Resolve line items (body.items or current cart from cart-outfit)
    const slotBySkuId = new Map<string, string | null>();
    let cartPackagingOptionId: string | null = null;
    let cartGiftNote: string | null = null;

    let rawItems: Array<{
      skuId: string;
      qty: number;
      bundleGroupId: string | null;
      fromAiTryon: boolean;
    }>;

    if (input.items && input.items.length > 0) {
      rawItems = input.items.map((item) => ({
        skuId: item.skuId.trim(),
        qty: item.qty,
        bundleGroupId: item.bundleGroupId ?? null,
        fromAiTryon: Boolean(item.fromAiTryon),
      }));
    } else {
      const cart = await this.upstream.fetchCart(
        { userId: actor.userId, guestSessionId: actor.guestSessionId },
        actor,
      );
      if (!cart.items || cart.items.length === 0) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Giỏ hàng hiện đang trống, vui lòng thêm sản phẩm trước khi thanh toán.',
        );
      }
      cartPackagingOptionId = cart.packagingOptionId ?? null;
      cartGiftNote = cart.giftNote ?? null;
      rawItems = cart.items.map((item) => {
        slotBySkuId.set(item.skuId, item.slot ?? null);
        return {
          skuId: item.skuId,
          qty: item.qty,
          bundleGroupId: item.bundleGroupId ?? null,
          fromAiTryon: Boolean(item.fromAiTryon),
        };
      });
    }

    // Merge duplicate SKU lines cleanly
    const mergedMap = new Map<
      string,
      { skuId: string; qty: number; bundleGroupId: string | null; fromAiTryon: boolean }
    >();
    for (const item of rawItems) {
      const prev = mergedMap.get(item.skuId);
      if (prev) {
        prev.qty += item.qty;
        prev.bundleGroupId = prev.bundleGroupId ?? item.bundleGroupId;
        prev.fromAiTryon = prev.fromAiTryon || item.fromAiTryon;
      } else {
        mergedMap.set(item.skuId, { ...item });
      }
    }
    const mergedItems = Array.from(mergedMap.values());
    const skuIds = mergedItems.map((i) => i.skuId);

    // 4. Authoritative Server Pricing from catalog-lookbook (NEVER trust client prices!)
    const snapshotMap = await this.upstream.fetchSkusSnapshot({ skuIds }, actor);
    const resolvedLines: Array<{
      skuId: string;
      qty: number;
      bundleGroupId: string | null;
      slot: string;
      snap: CatalogSkuSnapshot;
    }> = [];

    for (const line of mergedItems) {
      const snap = snapshotMap.get(line.skuId);
      if (!snap) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          `SKU "${line.skuId}" không tồn tại trong hệ thống danh mục.`,
          { skuId: line.skuId },
        );
      }
      const slot =
        slotBySkuId.get(line.skuId) ?? inferSlotFromSlugOrName(snap.productSlug, snap.productName);
      resolvedLines.push({
        skuId: snap.skuId,
        qty: line.qty,
        bundleGroupId: line.bundleGroupId,
        slot,
        snap,
      });
    }

    const subtotalVnd = resolvedLines.reduce(
      (sum, line) => sum + line.snap.effectivePriceVnd * line.qty,
      0,
    );

    const distinctSlots = new Set(resolvedLines.map((l) => l.slot).filter(Boolean)).size;
    const baseShippingFeeVnd = baseShippingFeeForMethod(input.shippingMethod);
    const normalizedVoucherCode =
      input.voucherCode && input.voucherCode.trim().length > 0
        ? input.voucherCode.trim().toUpperCase()
        : null;

    // 5. Evaluate Promotions & Combo Discounts via payment-promo
    const promoEval = await this.upstream.evaluatePromotions(
      {
        items: resolvedLines.map((line) => ({
          skuId: line.skuId,
          productId: line.snap.productId,
          sizeCode: line.snap.sizeCode,
          unitPriceVnd: line.snap.effectivePriceVnd,
          qty: line.qty,
          slot: line.slot,
          bundleGroupId: line.bundleGroupId,
        })),
        voucherCode: normalizedVoucherCode,
        shippingMethod: input.shippingMethod,
        shippingFeeVnd: baseShippingFeeVnd,
        subtotalVnd,
        userId: actor.userId,
        comboDistinctSlots: distinctSlots,
      },
      actor,
    );

    if (normalizedVoucherCode && !promoEval.valid) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.PROMOTION_INVALID,
        promoEval.reason || `Mã khuyến mãi "${normalizedVoucherCode}" không hợp lệ.`,
      );
    }

    const localComboPct = distinctSlots >= 3 ? 10 : distinctSlots === 2 ? 5 : 0;
    const localComboDiscountVnd = Math.round((subtotalVnd * localComboPct) / 100);

    let comboDiscountVnd = 0;
    let voucherDiscountVnd = 0;

    if (promoEval.comboDiscountVnd !== null) {
      comboDiscountVnd = promoEval.comboDiscountVnd;
      voucherDiscountVnd = promoEval.voucherDiscountVnd ?? 0;
    } else if (promoEval.promoType === 'OUTFIT_COMBO') {
      comboDiscountVnd = promoEval.discountVnd ?? localComboDiscountVnd;
      voucherDiscountVnd = 0;
    } else if (normalizedVoucherCode) {
      comboDiscountVnd = localComboDiscountVnd;
      voucherDiscountVnd = promoEval.voucherDiscountVnd ?? promoEval.discountVnd ?? 0;
    } else {
      comboDiscountVnd =
        promoEval.discountVnd !== null && promoEval.discountVnd > 0
          ? promoEval.discountVnd
          : localComboDiscountVnd;
      voucherDiscountVnd = 0;
    }

    // Clamp discounts safely so grand total merchandise never drops below 0
    if (comboDiscountVnd + voucherDiscountVnd > subtotalVnd) {
      voucherDiscountVnd = Math.max(0, subtotalVnd - comboDiscountVnd);
    }
    const totalMerchDiscountVnd = comboDiscountVnd + voucherDiscountVnd;

    let shippingFeeVnd: number;
    if (promoEval.shippingFeeVnd !== null) {
      shippingFeeVnd = promoEval.shippingFeeVnd;
    } else {
      const shippingDiscount = promoEval.shippingDiscountVnd ?? 0;
      const netBeforeShip = Math.max(0, subtotalVnd - comboDiscountVnd);
      if (
        input.shippingMethod === ShippingMethod.PICKUP ||
        netBeforeShip >= FREE_SHIP_THRESHOLD_VND ||
        shippingDiscount >= baseShippingFeeVnd
      ) {
        shippingFeeVnd = 0;
      } else {
        shippingFeeVnd = Math.max(0, baseShippingFeeVnd - shippingDiscount);
      }
    }

    // Resolve Packaging Fee authoritatively from catalog options
    const effectivePackagingId = input.packagingOptionId ?? cartPackagingOptionId ?? null;
    const packagingOption: PackagingOptionInfo | null = await this.upstream.resolvePackagingOption(
      effectivePackagingId,
      actor,
    );
    const packagingFeeVnd = packagingOption ? packagingOption.priceVnd : 0;
    const effectiveGiftNote = (input.giftNote ?? cartGiftNote ?? null)?.slice(0, 140) ?? null;

    // Exact per-item discount allocation invariant:
    // SUM(allocatedDiscountVnd) === comboDiscountVnd + voucherDiscountVnd
    const promoAllocMap = new Map(promoEval.allocatedItems.map((a) => [a.skuId, a]));
    const promoAllocMatches =
      promoEval.allocatedItems.length === resolvedLines.length &&
      resolvedLines.every((l) => promoAllocMap.has(l.skuId)) &&
      resolvedLines.reduce(
        (sum, l) => sum + (promoAllocMap.get(l.skuId)?.allocatedDiscountVnd ?? 0),
        0,
      ) === totalMerchDiscountVnd;

    const computedAllocations = promoAllocMatches
      ? resolvedLines.map((l) => {
          const entry = promoAllocMap.get(l.skuId)!;
          const netRefundableUnitVnd = Math.max(
            0,
            Math.round((l.snap.effectivePriceVnd * l.qty - entry.allocatedDiscountVnd) / l.qty),
          );
          return {
            allocatedDiscountVnd: entry.allocatedDiscountVnd,
            netRefundableUnitVnd,
          };
        })
      : computeProportionalAllocations(
          resolvedLines.map((l) => ({
            skuId: l.skuId,
            unitPriceVnd: l.snap.effectivePriceVnd,
            qty: l.qty,
          })),
          totalMerchDiscountVnd,
        );

    const grandTotalVnd =
      Math.max(0, subtotalVnd - totalMerchDiscountVnd) + packagingFeeVnd + shippingFeeVnd;

    // 6. Customer checkout profile & COD Risk Rule
    const checkoutProfile = actor.userId
      ? await this.upstream.fetchCustomerCheckoutProfile(actor.userId, actor)
      : null;

    let depositRequiredVnd = 0;
    if (input.paymentMethod === PaymentMethod.COD) {
      const highValueCod = grandTotalVnd > COD_DEPOSIT_THRESHOLD_VND;
      const lowTrustCod =
        checkoutProfile !== null && checkoutProfile.codTrustScore < COD_TRUST_SCORE_MIN;
      if (highValueCod || lowTrustCod) {
        depositRequiredVnd = Math.round(grandTotalVnd * COD_DEPOSIT_RATE);
        if (!input.confirmCodDeposit) {
          throw new ApiDomainException(
            HttpStatus.BAD_REQUEST,
            ErrorCode.COD_RISK_DEPOSIT_REQUIRED,
            'Đơn COD giá trị trên 3.000.000₫ hoặc điểm tin cậy thấp yêu cầu đặt cọc trước 20%.',
            {
              depositRequiredVnd,
              grandTotalVnd,
              codTrustScore: checkoutProfile?.codTrustScore ?? null,
            },
          );
        }
      }
    }

    const customerEmail =
      input.customerEmail?.trim() || checkoutProfile?.email || 'guest@atelier.local';
    const customerPhone = input.customerPhone?.trim() || input.shippingAddress.phone;

    // 7. Insert Order (PENDING_RESERVATION) + Order Items inside ACID tx
    const orderId = crypto.randomUUID();
    const orderCode = generateOrderCode();
    const initialExpiresAt = new Date(Date.now() + this.config.reservationTtlSeconds * 1000);

    try {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `INSERT INTO orders (
             id, order_code, idempotency_key, user_id, guest_session_id,
             customer_email, customer_phone, status,
             subtotal_vnd, combo_discount_vnd, voucher_discount_vnd, voucher_code,
             packaging_fee_vnd, shipping_fee_vnd, deposit_required_vnd, grand_total_vnd,
             payment_method, shipping_method, delivery_date, delivery_slot,
             shipping_address_jsonb, packaging_option_jsonb, gift_note,
             reservation_id, reservation_expires_at, late_payment_refunded,
             created_at, updated_at
           ) VALUES (
             $1, $2, $3, $4, $5,
             $6, $7, $8,
             $9, $10, $11, $12,
             $13, $14, $15, $16,
             $17, $18, $19, $20,
             $21::jsonb, $22::jsonb, $23,
             NULL, $24::timestamptz, FALSE,
             NOW(), NOW()
           )`,
          [
            orderId,
            orderCode,
            cleanIdempotencyKey,
            actor.userId,
            actor.guestSessionId,
            customerEmail,
            customerPhone,
            OrderStatus.PENDING_RESERVATION,
            subtotalVnd,
            comboDiscountVnd,
            voucherDiscountVnd,
            normalizedVoucherCode,
            packagingFeeVnd,
            shippingFeeVnd,
            depositRequiredVnd,
            grandTotalVnd,
            input.paymentMethod,
            input.shippingMethod,
            input.deliveryDate ?? null,
            input.deliverySlot ?? null,
            JSON.stringify(input.shippingAddress),
            packagingOption ? JSON.stringify(packagingOption) : null,
            effectiveGiftNote,
            initialExpiresAt.toISOString(),
          ],
        );

        for (let i = 0; i < resolvedLines.length; i += 1) {
          const line = resolvedLines[i];
          const alloc = computedAllocations[i];
          await tx.query(
            `INSERT INTO order_items (
               id, order_id, product_id, variant_id, sku_id, sku_code,
               product_name, color_name, size_code, image_url,
               unit_price_vnd, allocated_discount_vnd, net_refundable_unit_vnd,
               qty, bundle_group_id, is_returnable, supplier_batch_code
             ) VALUES (
               $1, $2, $3, $4, $5, $6,
               $7, $8, $9, $10,
               $11, $12, $13,
               $14, $15, $16, NULL
             )`,
            [
              crypto.randomUUID(),
              orderId,
              line.snap.productId,
              line.snap.variantId,
              line.snap.skuId,
              line.snap.skuCode,
              line.snap.productName,
              line.snap.colorName,
              line.snap.sizeCode,
              line.snap.imageUrl,
              line.snap.effectivePriceVnd,
              alloc.allocatedDiscountVnd,
              alloc.netRefundableUnitVnd,
              line.qty,
              line.bundleGroupId,
              line.snap.isReturnable,
            ],
          );
        }
      });
    } catch (error: unknown) {
      // Handle race condition on identical Idempotency-Key cleanly
      const pgCode = (error as { code?: string } | null)?.code;
      if (pgCode === '23505') {
        const raced = await this.db.query<OrderRow>(
          'SELECT * FROM orders WHERE idempotency_key = $1 LIMIT 1',
          [cleanIdempotencyKey],
        );
        if (raced.rows.length > 0) {
          const [hydrated] = await this.hydrateOrders([raced.rows[0]]);
          return {
            ...hydrated,
            order: hydrated,
            paymentIntent: hydrated.paymentIntent ?? null,
            idempotentReplay: true,
          };
        }
      }
      throw error;
    }

    // 8. Reserve Stock on inventory (:4004)
    const preferredWarehouseCode =
      input.shippingMethod === ShippingMethod.AHAMOVE_2H
        ? isHcmProvince(input.shippingAddress.provinceName)
          ? 'HCM_SHOWROOM'
          : 'HN_ATELIER'
        : undefined;

    let reservation;
    try {
      reservation = await this.upstream.reserveStock(
        {
          referenceId: orderId,
          reservationType: 'CHECKOUT',
          items: resolvedLines.map((l) => ({ skuId: l.skuId, qty: l.qty })),
          preferredWarehouseCode,
          ttlSeconds: this.config.reservationTtlSeconds,
          idempotencyKey: `order-res:${orderId}`,
        },
        actor,
      );
    } catch (error: unknown) {
      if (error instanceof ApiDomainException && error.getStatus() === HttpStatus.CONFLICT) {
        await this.db.query(
          `UPDATE orders
           SET status = $2, cancelled_at = NOW(), cancel_reason = 'INSUFFICIENT_STOCK', updated_at = NOW()
           WHERE id = $1`,
          [orderId, OrderStatus.FAILED_OUT_OF_STOCK],
        );
      } else {
        await this.db.query(
          `UPDATE orders
           SET status = $2, cancelled_at = NOW(), cancel_reason = 'RESERVATION_ERROR', updated_at = NOW()
           WHERE id = $1`,
          [orderId, OrderStatus.CANCELLED],
        );
      }
      throw error;
    }

    const reservedExpiresAt = reservation.expiresAt || initialExpiresAt.toISOString();
    const reservedWarehouseCode = reservation.items?.[0]?.warehouseCode;

    // 9. Lock Voucher (if applied)
    let voucherLocked = false;
    if (normalizedVoucherCode) {
      try {
        await this.upstream.lockPromotion(
          {
            promotionId: promoEval.promotionId,
            voucherCode: normalizedVoucherCode,
            orderId,
            userId: actor.userId,
            discountVnd: voucherDiscountVnd,
          },
          actor,
        );
        voucherLocked = true;
      } catch (error: unknown) {
        await this.upstream.releaseReservationNonFatal(
          orderId,
          'CANCEL_RELEASE',
          reservation.reservationId,
          actor,
        );
        await this.db.query(
          `UPDATE orders
           SET status = $2, cancelled_at = NOW(), cancel_reason = 'PROMOTION_LOCK_FAILED', updated_at = NOW()
           WHERE id = $1`,
          [orderId, OrderStatus.CANCELLED],
        );
        throw error;
      }
    }

    // 10. Create Payment Intent via payment-promo (:4007)
    let paymentIntent: PaymentIntentResponseDTO;
    try {
      paymentIntent = await this.upstream.createPaymentIntent(
        {
          orderId,
          orderCode,
          provider: input.paymentMethod,
          amountVnd: grandTotalVnd,
          expiresAt: reservedExpiresAt,
          customerEmail,
          idempotencyKey: `pay-intent:${orderId}`,
        },
        actor,
      );
    } catch (error: unknown) {
      await this.upstream.releaseReservationNonFatal(
        orderId,
        'CANCEL_RELEASE',
        reservation.reservationId,
        actor,
      );
      if (voucherLocked && normalizedVoucherCode) {
        await this.upstream.releasePromotionNonFatal(
          { voucherCode: normalizedVoucherCode, orderId, reason: 'PAYMENT_INTENT_FAILED' },
          actor,
        );
      }
      await this.db.query(
        `UPDATE orders
         SET status = $2, cancelled_at = NOW(), cancel_reason = 'PAYMENT_INTENT_FAILED', updated_at = NOW()
         WHERE id = $1`,
        [orderId, OrderStatus.CANCELLED],
      );
      throw error;
    }

    // 11. Finalize Order State (COD commits immediately; online waits in AWAITING_PAYMENT)
    let createdShipment: ShipmentDTO | null = null;
    if (input.paymentMethod === PaymentMethod.COD) {
      await this.upstream.commitReservation(orderId, reservation.reservationId, actor);
      await this.db.transaction(async (tx) => {
        const orderUpdate = await tx.query<OrderRow>(
          `UPDATE orders
           SET status = $2,
               reservation_id = $3,
               reservation_expires_at = $4::timestamptz,
               payment_intent_jsonb = $5::jsonb,
               updated_at = NOW()
           WHERE id = $1
           RETURNING *`,
          [
            orderId,
            OrderStatus.CONFIRMED,
            reservation.reservationId,
            reservedExpiresAt,
            JSON.stringify(paymentIntent),
          ],
        );
        createdShipment = await this.ensureShipmentForOrder(
          tx,
          orderUpdate.rows[0],
          reservedWarehouseCode,
        );
        await this.writeOutbox(tx, {
          eventName: EVENT_NAMES.ORDER_CREATED,
          aggregateType: 'ORDER',
          aggregateId: orderId,
          correlationId: actor.correlationId,
          payload: {
            orderId,
            orderCode,
            paymentMethod: input.paymentMethod,
            grandTotalVnd,
            status: OrderStatus.CONFIRMED,
          },
        });
        await this.writeOutbox(tx, {
          eventName: 'order.confirmed',
          aggregateType: 'ORDER',
          aggregateId: orderId,
          correlationId: actor.correlationId,
          payload: {
            orderId,
            orderCode,
            shipment: createdShipment,
          },
        });
      });
    } else {
      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE orders
           SET status = $2,
               reservation_id = $3,
               reservation_expires_at = $4::timestamptz,
               payment_intent_jsonb = $5::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
          [
            orderId,
            OrderStatus.AWAITING_PAYMENT,
            reservation.reservationId,
            reservedExpiresAt,
            JSON.stringify(paymentIntent),
          ],
        );
        await this.writeOutbox(tx, {
          eventName: EVENT_NAMES.ORDER_CREATED,
          aggregateType: 'ORDER',
          aggregateId: orderId,
          correlationId: actor.correlationId,
          payload: {
            orderId,
            orderCode,
            paymentMethod: input.paymentMethod,
            grandTotalVnd,
            status: OrderStatus.AWAITING_PAYMENT,
          },
        });
      });
    }

    // 12. Publish event + clear cart non-fatally (and COD post-confirm hooks)
    const sideEffects: Promise<unknown>[] = [
      this.publishDomainEventNonFatal(
        EVENT_NAMES.ORDER_CREATED,
        {
          orderId,
          orderCode,
          customerId: actor.userId ?? actor.guestSessionId ?? 'guest',
          paymentMethod: input.paymentMethod,
          totalAmountVnd: grandTotalVnd,
          currency: 'VND',
          expiresAt: reservedExpiresAt,
          items: resolvedLines.map((l, idx) => ({
            skuCode: l.snap.skuCode,
            productId: l.snap.productId,
            variantId: l.snap.variantId,
            size: l.snap.sizeCode,
            quantity: l.qty,
            unitPriceVnd: l.snap.effectivePriceVnd,
            allocatedDiscountVnd: computedAllocations[idx].allocatedDiscountVnd,
          })),
        },
        actor.correlationId,
        `order-created:${orderId}`,
      ),
      this.upstream.clearCartNonFatal(
        { userId: actor.userId, guestSessionId: actor.guestSessionId, skuIds },
        actor,
      ),
    ];

    if (input.paymentMethod === PaymentMethod.COD) {
      sideEffects.push(
        this.upstream.emitRealtimeOrderEventNonFatal(
          {
            event: 'order:paid',
            orderId,
            orderCode,
            status: OrderStatus.CONFIRMED,
            shipment: createdShipment,
          },
          actor,
        ),
        this.upstream.notifyOrderConfirmedNonFatal(
          {
            eventId: `order-confirmed:${orderCode}`,
            orderCode,
            customerEmail,
            customerPhone,
            customerName: input.shippingAddress.recipientName,
            grandTotalVnd,
            trackingCode: (createdShipment as ShipmentDTO | null)?.trackingCode ?? null,
            items: resolvedLines.map((l) => ({
              productName: l.snap.productName,
              colorName: l.snap.colorName,
              sizeCode: l.snap.sizeCode,
              qty: l.qty,
              unitPriceVnd: l.snap.effectivePriceVnd,
            })),
          },
          actor,
        ),
      );
      if (actor.userId) {
        sideEffects.push(
          this.upstream.grantTryOnBonusNonFatal(
            {
              userId: actor.userId,
              bonusCredits: VIP_TRYON_ORDER_BONUS,
              reason: `ORDER_CONFIRMED:${orderCode}`,
            },
            actor,
          ),
        );
      }
    }

    await Promise.allSettled(sideEffects);

    const finalRow = await this.loadOrderRowByCodeOrId(orderId);
    const [hydrated] = await this.hydrateOrders([finalRow!]);

    return {
      ...hydrated,
      order: hydrated,
      paymentIntent,
      idempotentReplay: false,
    };
  }

  // ==========================================================================
  // 2. Payment Succeeded Consumer (POST /internal/events/payment-succeeded)
  // ==========================================================================

  async handlePaymentSucceededEvent(
    rawBody: unknown,
    trace: string | TraceContext,
  ): Promise<Record<string, unknown>> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const input = parseWithZod(PaymentSucceededEventSchema, rawBody);
    const lookupKey = input.orderId ?? input.orderCode;
    if (!lookupKey) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Thiếu orderId hoặc orderCode trong sự kiện payment-succeeded.',
      );
    }

    const eventId =
      input.eventId ||
      input.providerEventId ||
      input.paymentId ||
      `payment-succeeded:${lookupKey}`;

    const dedup = await this.db.query<{ event_id: string }>(
      `INSERT INTO processed_events (event_id, event_name)
       VALUES ($1, $2)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [eventId, EVENT_NAMES.PAYMENT_SUCCEEDED],
    );

    const orderRow = await this.loadOrderRowByCodeOrId(lookupKey);
    if (!orderRow) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${lookupKey}".`,
      );
    }

    if (dedup.rowCount === 0) {
      return {
        deduplicated: true,
        processed: false,
        eventId,
        orderId: orderRow.id,
        orderCode: orderRow.order_code,
        status: orderRow.status,
      };
    }

    const paidAtIso = input.paidAt ?? new Date().toISOString();
    const expiresAtMs = orderRow.reservation_expires_at
      ? new Date(orderRow.reservation_expires_at).getTime()
      : null;
    const isReservationExpired = expiresAtMs !== null && Number.isFinite(expiresAtMs) && expiresAtMs <= Date.now();

    // CRITICAL EDGE CASE: Late Payment after cancellation/expiration
    if (
      orderRow.status === OrderStatus.CANCELLED ||
      orderRow.status === OrderStatus.FAILED_OUT_OF_STOCK ||
      orderRow.status === OrderStatus.LATE_PAYMENT_NEEDS_REFUND ||
      input.simulateLate === true ||
      (orderRow.status === OrderStatus.AWAITING_PAYMENT && isReservationExpired)
    ) {
      // NEVER call CommitReservation! If it somehow still held a reservation before sweeper, release it.
      if (orderRow.status === OrderStatus.AWAITING_PAYMENT && orderRow.reservation_id) {
        await this.upstream.releaseReservationNonFatal(
          orderRow.id,
          'RELEASE_EXPIRED',
          orderRow.reservation_id,
          trace,
        );
      }

      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE orders
           SET status = $2,
               paid_at = COALESCE(paid_at, $3::timestamptz),
               updated_at = NOW()
           WHERE id = $1`,
          [orderRow.id, OrderStatus.LATE_PAYMENT_NEEDS_REFUND, paidAtIso],
        );
        await this.writeOutbox(tx, {
          eventName: EVENT_NAMES.PAYMENT_LATE_DETECTED,
          aggregateType: 'ORDER',
          aggregateId: orderRow.id,
          correlationId,
          payload: {
            paymentId: input.paymentId ?? eventId,
            orderId: orderRow.id,
            orderCode: orderRow.order_code,
            provider: input.provider ?? orderRow.payment_method,
            providerTransactionId: input.providerTransactionId ?? eventId,
            amountVnd: input.amountVnd ?? Number(orderRow.grand_total_vnd),
            detectedAt: new Date().toISOString(),
            recommendedAction: 'AUTO_REFUND_REVIEW',
          },
        });
      });

      await Promise.allSettled([
        this.publishDomainEventNonFatal(
          EVENT_NAMES.PAYMENT_LATE_DETECTED,
          {
            paymentId: input.paymentId ?? eventId,
            orderId: orderRow.id,
            provider: (input.provider ?? orderRow.payment_method) as 'VNPAY' | 'MOMO' | 'VIETQR',
            providerTransactionId: input.providerTransactionId ?? eventId,
            amountVnd: input.amountVnd ?? Number(orderRow.grand_total_vnd),
            detectedAt: new Date().toISOString(),
            recommendedAction: 'AUTO_REFUND_REVIEW',
          },
          correlationId,
          `late-pay:${orderRow.id}`,
        ),
        this.upstream.emitRealtimeOrderEventNonFatal(
          {
            event: 'order:updated',
            orderId: orderRow.id,
            orderCode: orderRow.order_code,
            status: OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
          },
          trace,
        ),
      ]);

      return {
        deduplicated: false,
        processed: true,
        latePayment: true,
        eventId,
        orderId: orderRow.id,
        orderCode: orderRow.order_code,
        status: OrderStatus.LATE_PAYMENT_NEEDS_REFUND,
      };
    }

    // Already confirmed or past confirmed -> idempotent no-op
    if (
      orderRow.status !== OrderStatus.AWAITING_PAYMENT &&
      orderRow.status !== OrderStatus.PENDING_RESERVATION
    ) {
      return {
        deduplicated: true,
        processed: false,
        eventId,
        orderId: orderRow.id,
        orderCode: orderRow.order_code,
        status: orderRow.status,
      };
    }

    // Happy Path: Commit Inventory Reservation -> CONFIRMED -> Smart Order Routing Shipment
    await this.upstream.commitReservation(orderRow.id, orderRow.reservation_id, trace);

    let shipment!: ShipmentDTO;
    await this.db.transaction(async (tx) => {
      const updated = await tx.query<OrderRow>(
        `UPDATE orders
         SET status = $2,
             paid_at = COALESCE(paid_at, $3::timestamptz),
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [orderRow.id, OrderStatus.CONFIRMED, paidAtIso],
      );
      shipment = await this.ensureShipmentForOrder(tx, updated.rows[0]);
      await this.writeOutbox(tx, {
        eventName: 'order.confirmed',
        aggregateType: 'ORDER',
        aggregateId: orderRow.id,
        correlationId,
        payload: {
          orderId: orderRow.id,
          orderCode: orderRow.order_code,
          status: OrderStatus.CONFIRMED,
          shipment,
        },
      });
    });

    const itemsRes = await this.db.query<OrderItemRow>(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [orderRow.id],
    );
    const shippingAddress = parseJsonValue<ShippingAddressSnapshot>(
      orderRow.shipping_address_jsonb,
      {
        recipientName: 'Quý khách',
        phone: orderRow.customer_phone ?? '',
        provinceName: '',
        districtName: '',
        wardName: '',
        streetLine: '',
      },
    );

    const postConfirmTasks: Promise<unknown>[] = [
      this.publishDomainEventNonFatal(
        EVENT_NAMES.PAYMENT_SUCCEEDED,
        {
          paymentId: input.paymentId ?? eventId,
          orderId: orderRow.id,
          provider: (input.provider ?? orderRow.payment_method) as
            | 'VNPAY'
            | 'MOMO'
            | 'VIETQR'
            | 'COD',
          providerTransactionId: input.providerTransactionId ?? eventId,
          amountVnd: input.amountVnd ?? Number(orderRow.grand_total_vnd),
          paidAt: paidAtIso,
        },
        correlationId,
        `order-confirmed:${orderRow.id}`,
      ),
      this.upstream.emitRealtimeOrderEventNonFatal(
        {
          event: 'order:paid',
          orderId: orderRow.id,
          orderCode: orderRow.order_code,
          status: OrderStatus.CONFIRMED,
          shipment,
        },
        trace,
      ),
      this.upstream.notifyOrderConfirmedNonFatal(
        {
          eventId: `order-confirmed:${orderRow.order_code}`,
          orderCode: orderRow.order_code,
          customerEmail: orderRow.customer_email || 'customer@atelier.local',
          customerPhone: orderRow.customer_phone,
          customerName: shippingAddress.recipientName,
          grandTotalVnd: Number(orderRow.grand_total_vnd),
          trackingCode: shipment.trackingCode,
          items: itemsRes.rows.map((i) => ({
            productName: i.product_name,
            colorName: i.color_name,
            sizeCode: i.size_code,
            qty: Number(i.qty),
            unitPriceVnd: Number(i.unit_price_vnd),
          })),
        },
        trace,
      ),
    ];

    if (orderRow.user_id) {
      postConfirmTasks.push(
        this.upstream.grantTryOnBonusNonFatal(
          {
            userId: orderRow.user_id,
            bonusCredits: VIP_TRYON_ORDER_BONUS,
            reason: `ORDER_CONFIRMED:${orderRow.order_code}`,
          },
          trace,
        ),
      );
    }

    await Promise.allSettled(postConfirmTasks);

    return {
      deduplicated: false,
      processed: true,
      eventId,
      orderId: orderRow.id,
      orderCode: orderRow.order_code,
      status: OrderStatus.CONFIRMED,
      shipment,
    };
  }

  // ==========================================================================
  // 3. Expiry Sweeper & Internal Test Hooks
  // ==========================================================================

  async testExpireOrder(
    rawBody: unknown,
  ): Promise<{ orderId: string; orderCode: string; reservationExpiresAt: string }> {
    const input = parseWithZod(TestExpireOrderSchema, rawBody);
    const lookupKey = input.orderId ?? input.orderCode!;
    const row = await this.loadOrderRowByCodeOrId(lookupKey);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${lookupKey}".`,
      );
    }

    const updated = await this.db.query<{
      id: string;
      order_code: string;
      reservation_expires_at: string | Date;
    }>(
      `UPDATE orders
       SET reservation_expires_at = NOW() - INTERVAL '1 minute',
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, order_code, reservation_expires_at`,
      [row.id],
    );

    return {
      orderId: updated.rows[0].id,
      orderCode: updated.rows[0].order_code,
      reservationExpiresAt:
        toIsoString(updated.rows[0].reservation_expires_at) ?? new Date().toISOString(),
    };
  }

  async runExpirySweep(
    trace: string | TraceContext,
  ): Promise<{ expiredCount: number; expiredOrderCodes: string[] }> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    if (this.sweeping || !this.db.isReady()) {
      return { expiredCount: 0, expiredOrderCodes: [] };
    }

    this.sweeping = true;
    const expiredOrderCodes: string[] = [];

    try {
      const candidates = await this.db.query<OrderRow>(
        `SELECT * FROM orders
         WHERE status = $1
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at <= NOW()
         ORDER BY reservation_expires_at ASC
         LIMIT 50`,
        [OrderStatus.AWAITING_PAYMENT],
      );

      for (const order of candidates.rows) {
        const claimed = await this.db.transaction(async (tx) => {
          const upd = await tx.query<{ id: string; order_code: string }>(
            `UPDATE orders
             SET status = $2,
                 cancelled_at = NOW(),
                 cancel_reason = 'PAYMENT_TIMEOUT_EXPIRED',
                 updated_at = NOW()
             WHERE id = $1 AND status = $3
             RETURNING id, order_code`,
            [order.id, OrderStatus.CANCELLED, OrderStatus.AWAITING_PAYMENT],
          );
          if (upd.rowCount === 0) {
            return null;
          }
          await this.writeOutbox(tx, {
            eventName: 'order.cancelled',
            aggregateType: 'ORDER',
            aggregateId: order.id,
            correlationId,
            payload: {
              orderId: order.id,
              orderCode: order.order_code,
              reason: 'PAYMENT_TIMEOUT_EXPIRED',
            },
          });
          return upd.rows[0];
        });

        if (!claimed) {
          continue;
        }

        expiredOrderCodes.push(claimed.order_code);

        const releaseTasks: Promise<unknown>[] = [
          this.upstream.releaseReservationNonFatal(
            order.id,
            'RELEASE_EXPIRED',
            order.reservation_id,
            trace,
          ),
          this.upstream.emitRealtimeOrderEventNonFatal(
            {
              event: 'order:updated',
              orderId: order.id,
              orderCode: order.order_code,
              status: OrderStatus.CANCELLED,
            },
            trace,
          ),
          this.publishDomainEventNonFatal(
            EVENT_NAMES.PAYMENT_EXPIRED,
            {
              paymentId: `exp:${order.id}`,
              orderId: order.id,
              provider: (order.payment_method === PaymentMethod.COD
                ? PaymentMethod.VIETQR
                : order.payment_method) as 'VNPAY' | 'MOMO' | 'VIETQR',
              expiredAt: new Date().toISOString(),
            },
            correlationId,
            `order-expired:${order.id}`,
          ),
        ];

        if (order.voucher_code) {
          releaseTasks.push(
            this.upstream.releasePromotionNonFatal(
              {
                voucherCode: order.voucher_code,
                orderId: order.id,
                reason: 'ORDER_PAYMENT_EXPIRED',
              },
              trace,
            ),
          );
        }

        await Promise.allSettled(releaseTasks);
      }

      return {
        expiredCount: expiredOrderCodes.length,
        expiredOrderCodes,
      };
    } finally {
      this.sweeping = false;
    }
  }

  // ==========================================================================
  // 4. Order Queries, Fulfillment & Late-Payment Refund
  // ==========================================================================

  async listMyOrders(userId: string | null): Promise<ExtendedOrderDTO[]> {
    if (!userId || !UUID_REGEX.test(userId)) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        'Yêu cầu đăng nhập để xem lịch sử đơn hàng.',
      );
    }
    const res = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE user_id = $1::uuid ORDER BY created_at DESC LIMIT 100',
      [userId],
    );
    return this.hydrateOrders(res.rows);
  }

  private assertOrderOwnership(row: OrderRow, actor: OrderActorContext): void {
    if (actor.isInternal) {
      return;
    }
    if (
      actor.actorRoles.includes('SUPER_ADMIN') ||
      actor.actorRoles.includes('ORDER_STAFF')
    ) {
      return;
    }

    if (row.user_id) {
      if (!actor.userId || actor.userId.toLowerCase() !== row.user_id.toLowerCase()) {
        throw new ApiDomainException(
          HttpStatus.FORBIDDEN,
          ErrorCode.FORBIDDEN,
          'Bạn không có quyền truy cập đơn hàng thuộc tài khoản khách hàng khác.',
        );
      }
      return;
    }

    // Guest order ownership verification via x-guest-session-id
    if (
      !actor.guestSessionId ||
      !row.guest_session_id ||
      actor.guestSessionId !== row.guest_session_id
    ) {
      throw new ApiDomainException(
        HttpStatus.FORBIDDEN,
        ErrorCode.FORBIDDEN,
        'Bạn không có quyền truy cập đơn hàng của phiên khách hàng khác.',
      );
    }
  }

  private async loadAndHydrateOrderById(orderId: string): Promise<ExtendedOrderDTO> {
    const row = await this.loadOrderRowByCodeOrId(orderId);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderId}".`,
      );
    }
    const [hydrated] = await this.hydrateOrders([row]);
    return hydrated;
  }

  async getOrderByCode(
    orderCode: string,
    actor: OrderActorContext,
  ): Promise<ExtendedOrderDTO> {
    const row = await this.loadOrderRowByCodeOrId(orderCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }
    this.assertOrderOwnership(row, actor);
    const [hydrated] = await this.hydrateOrders([row]);
    return hydrated;
  }

  async cancelOrderByCustomer(
    idOrCode: string,
    rawBody: unknown,
    actor: OrderActorContext,
  ): Promise<ExtendedOrderDTO> {
    const input = parseWithZod(CancelOrderBodySchema, rawBody ?? undefined);
    const row = await this.loadOrderRowByCodeOrId(idOrCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${idOrCode}".`,
      );
    }

    this.assertOrderOwnership(row, actor);

    const previousStatus = row.status as OrderStatus;
    if (
      previousStatus !== OrderStatus.AWAITING_PAYMENT &&
      previousStatus !== OrderStatus.CONFIRMED
    ) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể hủy đơn hàng ở trạng thái ${row.status}. Khách hàng chỉ có thể tự hủy đơn đang Chờ thanh toán hoặc Đã xác nhận.`,
        { currentStatus: row.status },
      );
    }

    const cancelReason =
      input?.reason && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'CUSTOMER_SELF_CANCELLED';
    const cancelledBy = actor.actorEmail ?? actor.userId ?? actor.guestSessionId ?? 'customer';

    const claimed = await this.db.transaction(async (tx) => {
      const updated = await tx.query<OrderRow>(
        `UPDATE orders
         SET status = $2,
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancel_reason = $3,
             cancelled_by = $4,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ($5, $6)
         RETURNING *`,
        [
          row.id,
          OrderStatus.CANCELLED,
          cancelReason,
          cancelledBy,
          OrderStatus.AWAITING_PAYMENT,
          OrderStatus.CONFIRMED,
        ],
      );

      if (updated.rowCount === 0 || updated.rows.length === 0) {
        return null;
      }

      await this.writeOutbox(tx, {
        eventName: 'order.cancelled',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId: actor.correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          previousStatus,
          reason: cancelReason,
          cancelledBy: actor.userId ?? actor.guestSessionId ?? 'customer',
        },
      });

      return updated.rows[0];
    });

    if (!claimed) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Trạng thái đơn hàng vừa thay đổi và không còn đủ điều kiện hủy.',
      );
    }

    const compensationTasks: Promise<unknown>[] = [
      this.upstream.emitRealtimeOrderEventNonFatal(
        {
          event: 'order:updated',
          orderId: row.id,
          orderCode: row.order_code,
          status: OrderStatus.CANCELLED,
        },
        actor,
      ),
      this.publishDomainEventNonFatal(
        'order.cancelled',
        {
          orderId: row.id,
          orderCode: row.order_code,
          previousStatus,
          reason: cancelReason,
          cancelledBy: actor.userId ?? actor.guestSessionId ?? 'customer',
        },
        actor.correlationId,
        `order-cancel:${row.id}`,
      ),
    ];

    // Release active inventory reservation (AWAITING_PAYMENT) or restock committed lines (CONFIRMED)
    // without risking double-restocking if a reservation was still ACTIVE.
    if (previousStatus === OrderStatus.AWAITING_PAYMENT) {
      compensationTasks.push(
        this.upstream.releaseReservationNonFatal(
          row.id,
          'CANCEL_RELEASE',
          row.reservation_id,
          actor,
        ),
      );
    } else if (previousStatus === OrderStatus.CONFIRMED) {
      const releasedActiveReservation = await this.upstream.releaseReservationNonFatal(
        row.id,
        'CANCEL_RELEASE',
        row.reservation_id,
        actor,
      );
      if (!releasedActiveReservation) {
        const orderItemsRes = await this.db.query<OrderItemRow>(
          'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
          [row.id],
        );
        for (const item of orderItemsRes.rows) {
          compensationTasks.push(
            this.upstream
              .rmaRestock(
                {
                  skuId: item.sku_id,
                  qty: Number(item.qty),
                  restockable: true,
                  referenceId: `CANCEL:${row.order_code}`,
                },
                actor,
              )
              .catch((err: unknown) => {
                this.logger.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    orderCode: row.order_code,
                    skuId: item.sku_id,
                    correlationId: actor.correlationId,
                  },
                  'Non-fatal restock on CONFIRMED order self-cancel failed',
                );
              }),
          );
        }
      }
    }

    // Release voucher lock on payment-promo (:4007)
    if (row.voucher_code) {
      compensationTasks.push(
        this.upstream.releasePromotionNonFatal(
          {
            voucherCode: row.voucher_code,
            orderId: row.id,
            reason: 'CUSTOMER_SELF_CANCELLED',
          },
          actor,
        ),
      );
    }

    await Promise.allSettled(compensationTasks);
    return this.loadAndHydrateOrderById(row.id);
  }

  async cancelOrderByAdmin(
    idOrCode: string,
    rawBody: unknown,
    actor: OrderActorContext,
  ): Promise<OrderMutationResult> {
    const input = parseWithZod(AdminCancelOrderDtoSchema, rawBody ?? {});
    const row = await this.loadOrderRowByCodeOrId(idOrCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${idOrCode}".`,
      );
    }

    const [before] = await this.hydrateOrders([row]);
    const previousStatus = row.status as OrderStatus;
    const cancellableStatuses: readonly OrderStatus[] = [
      OrderStatus.PENDING_RESERVATION,
      OrderStatus.AWAITING_PAYMENT,
      OrderStatus.CONFIRMED,
      OrderStatus.PACKING,
    ];

    if (!cancellableStatuses.includes(previousStatus)) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể hủy đơn hàng ở trạng thái ${row.status}. Chỉ có thể hủy đơn ở trạng thái PENDING_RESERVATION, AWAITING_PAYMENT, CONFIRMED hoặc PACKING.`,
        { currentStatus: row.status },
      );
    }

    const cancelReason =
      input.reason && input.reason.trim().length > 0
        ? input.reason.trim()
        : 'ADMIN_CANCELLED';
    const cancelledBy =
      input.cancelledBy?.trim() ||
      actor.actorEmail?.trim() ||
      actor.userId?.trim() ||
      'admin';

    const claimed = await this.db.transaction(async (tx) => {
      const updated = await tx.query<OrderRow>(
        `UPDATE orders
         SET status = $2,
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancel_reason = $3,
             cancelled_by = $4,
             updated_at = NOW()
         WHERE id = $1
           AND status IN ($5, $6, $7, $8)
         RETURNING *`,
        [
          row.id,
          OrderStatus.CANCELLED,
          cancelReason,
          cancelledBy,
          OrderStatus.PENDING_RESERVATION,
          OrderStatus.AWAITING_PAYMENT,
          OrderStatus.CONFIRMED,
          OrderStatus.PACKING,
        ],
      );

      if (updated.rowCount === 0 || updated.rows.length === 0) {
        return null;
      }

      await this.writeOutbox(tx, {
        eventName: 'order.cancelled',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId: actor.correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          previousStatus,
          reason: cancelReason,
          cancelledBy,
        },
      });

      return updated.rows[0];
    });

    if (!claimed) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        'Trạng thái đơn hàng vừa thay đổi và không còn đủ điều kiện hủy.',
      );
    }

    const compensationTasks: Promise<unknown>[] = [
      this.upstream.emitRealtimeOrderEventNonFatal(
        {
          event: 'order:updated',
          orderId: row.id,
          orderCode: row.order_code,
          status: OrderStatus.CANCELLED,
        },
        actor,
      ),
      this.publishDomainEventNonFatal(
        'order.cancelled',
        {
          orderId: row.id,
          orderCode: row.order_code,
          previousStatus,
          reason: cancelReason,
          cancelledBy,
        },
        actor.correlationId,
        `order-admin-cancel:${row.id}`,
      ),
    ];

    if (
      previousStatus === OrderStatus.AWAITING_PAYMENT ||
      previousStatus === OrderStatus.PENDING_RESERVATION
    ) {
      compensationTasks.push(
        this.upstream.releaseReservationNonFatal(
          row.id,
          'CANCEL_RELEASE',
          row.reservation_id,
          actor,
        ),
      );
    } else if (previousStatus === OrderStatus.CONFIRMED || previousStatus === OrderStatus.PACKING) {
      const releasedActiveReservation = await this.upstream.releaseReservationNonFatal(
        row.id,
        'CANCEL_RELEASE',
        row.reservation_id,
        actor,
      );
      if (!releasedActiveReservation) {
        const orderItemsRes = await this.db.query<OrderItemRow>(
          'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
          [row.id],
        );
        for (const item of orderItemsRes.rows) {
          compensationTasks.push(
            this.upstream
              .rmaRestock(
                {
                  skuId: item.sku_id,
                  qty: Number(item.qty),
                  restockable: true,
                  referenceId: `ADMIN_CANCEL:${row.order_code}`,
                },
                actor,
              )
              .catch((err: unknown) => {
                this.logger.warn(
                  {
                    err: err instanceof Error ? err.message : String(err),
                    orderCode: row.order_code,
                    skuId: item.sku_id,
                    correlationId: actor.correlationId,
                  },
                  'Non-fatal restock on admin order cancel failed',
                );
              }),
          );
        }
      }
    }

    if (row.voucher_code) {
      compensationTasks.push(
        this.upstream.releasePromotionNonFatal(
          {
            voucherCode: row.voucher_code,
            orderId: row.id,
            reason: cancelReason,
          },
          actor,
        ),
      );
    }

    await Promise.allSettled(compensationTasks);
    const after = await this.loadAndHydrateOrderById(row.id);
    return {
      ...after,
      before,
      after,
    };
  }

  async completeOrder(
    idOrCode: string,
    rawBody: unknown,
    actor: OrderActorContext,
  ): Promise<OrderMutationResult> {
    const input = parseWithZod(CompleteOrderDtoSchema, rawBody ?? undefined);
    const row = await this.loadOrderRowByCodeOrId(idOrCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${idOrCode}".`,
      );
    }

    const [before] = await this.hydrateOrders([row]);
    if (row.status === OrderStatus.COMPLETED) {
      return {
        ...before,
        before,
        after: before,
      };
    }

    const completableStatuses: readonly OrderStatus[] = [
      OrderStatus.DELIVERED,
      OrderStatus.SHIPPED,
      OrderStatus.PACKING,
      OrderStatus.CONFIRMED,
    ];

    if (!completableStatuses.includes(row.status as OrderStatus)) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể hoàn tất đơn hàng đang ở trạng thái ${row.status}.`,
        { currentStatus: row.status },
      );
    }

    const completedBy =
      input?.completedBy?.trim() ||
      actor.actorEmail?.trim() ||
      actor.userId?.trim() ||
      'admin';

    let updatedShipment: ShipmentDTO | null = null;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE orders
         SET status = $2,
             delivered_at = COALESCE(delivered_at, NOW()),
             completed_at = COALESCE(completed_at, NOW()),
             completed_by = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, OrderStatus.COMPLETED, completedBy],
      );

      const shipRes = await tx.query<ShipmentRow>(
        `UPDATE shipments
         SET status = $2, updated_at = NOW()
         WHERE order_id = $1
         RETURNING *`,
        [row.id, ShipmentStatus.DELIVERED],
      );
      if (shipRes.rows[0]) {
        updatedShipment = this.mapShipmentRow(shipRes.rows[0]);
      }

      await this.writeOutbox(tx, {
        eventName: 'order.completed',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId: actor.correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          completedBy,
          note: input?.note ?? null,
          completedAt: new Date().toISOString(),
        },
      });
    });

    await this.upstream.emitRealtimeOrderEventNonFatal(
      {
        event: 'order:updated',
        orderId: row.id,
        orderCode: row.order_code,
        status: OrderStatus.COMPLETED,
        shipment: updatedShipment,
      },
      actor,
    );

    const after = await this.loadAndHydrateOrderById(row.id);
    return {
      ...after,
      before,
      after,
    };
  }

  async getOrderOpsMetrics(): Promise<OrderOpsMetricsDto> {
    const [orderAggRes, rmaAggRes, orderedTotalRes, byProductRes] = await Promise.all([
      this.db.query<{
        total_orders: string | number;
        confirmed_paid_orders: string | number;
        delivered_orders: string | number;
        late_payment_alerts_count: string | number;
        total_revenue_vnd: string | number;
      }>(
        `SELECT
           COUNT(*)::int AS total_orders,
           COALESCE(SUM(CASE WHEN status IN ('CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED') THEN 1 ELSE 0 END), 0)::int AS confirmed_paid_orders,
           COALESCE(SUM(CASE WHEN status IN ('DELIVERED', 'COMPLETED') THEN 1 ELSE 0 END), 0)::int AS delivered_orders,
           COALESCE(SUM(CASE WHEN status = 'LATE_PAYMENT_NEEDS_REFUND' OR late_payment_refunded = TRUE THEN 1 ELSE 0 END), 0)::int AS late_payment_alerts_count,
           COALESCE(SUM(CASE WHEN status IN ('CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED') THEN grand_total_vnd ELSE 0 END), 0)::bigint AS total_revenue_vnd
         FROM orders`,
      ),
      this.db.query<{
        total_rma_count: string | number;
        size_exchange_count: string | number;
      }>(
        `SELECT
           COUNT(*)::int AS total_rma_count,
           COALESCE(SUM(CASE WHEN rma_type = 'SIZE_EXCHANGE' THEN 1 ELSE 0 END), 0)::int AS size_exchange_count
         FROM rma_requests`,
      ),
      this.db.query<{ total_ordered_qty: string | number }>(
        `SELECT COALESCE(SUM(oi.qty), 0)::int AS total_ordered_qty
         FROM order_items oi
         JOIN orders o ON o.id = oi.order_id
         WHERE o.status IN ('CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED')`,
      ),
      this.db.query<{
        product_id: string;
        product_name: string | null;
        total_ordered: string | number;
        rma_count: string | number;
        size_exchange_count: string | number;
      }>(
        `WITH ordered_agg AS (
           SELECT
             oi.product_id,
             MAX(oi.product_name) AS product_name,
             COALESCE(SUM(oi.qty), 0)::int AS total_ordered
           FROM order_items oi
           JOIN orders o ON o.id = oi.order_id
           WHERE o.status IN ('CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED')
           GROUP BY oi.product_id
         ),
         rma_agg AS (
           SELECT
             ri.product_id,
             COUNT(DISTINCT ri.rma_id)::int AS rma_count,
             COUNT(DISTINCT CASE WHEN r.rma_type = 'SIZE_EXCHANGE' THEN ri.rma_id END)::int AS size_exchange_count
           FROM rma_items ri
           JOIN rma_requests r ON r.id = ri.rma_id
           GROUP BY ri.product_id
         )
         SELECT
           COALESCE(o.product_id, r.product_id) AS product_id,
           COALESCE(o.product_name, 'Sản phẩm TryVibe Atelier') AS product_name,
           COALESCE(o.total_ordered, 0)::int AS total_ordered,
           COALESCE(r.rma_count, 0)::int AS rma_count,
           COALESCE(r.size_exchange_count, 0)::int AS size_exchange_count
         FROM ordered_agg o
         FULL OUTER JOIN rma_agg r ON r.product_id = o.product_id
         ORDER BY COALESCE(r.rma_count, 0) DESC, COALESCE(o.total_ordered, 0) DESC
         LIMIT 20`,
      ),
    ]);

    const orderAgg = orderAggRes.rows[0];
    const rmaAgg = rmaAggRes.rows[0];
    const totalOrderedAll = Number(orderedTotalRes.rows[0]?.total_ordered_qty ?? 0);
    const totalRmaCount = Number(rmaAgg?.total_rma_count ?? 0);
    const sizeExchangeCount = Number(rmaAgg?.size_exchange_count ?? 0);

    const sizeExchangeRatePct =
      sizeExchangeCount === 0
        ? 0
        : Math.min(
            100,
            Math.round(
              (sizeExchangeCount / Math.max(totalOrderedAll, sizeExchangeCount, 1)) * 10000,
            ) / 100,
          );

    const rmaByProduct: OrderOpsMetricsProductItem[] = byProductRes.rows.map((row) => {
      const totalOrdered = Number(row.total_ordered ?? 0);
      const rmaCount = Number(row.rma_count ?? 0);
      const prodSizeExch = Number(row.size_exchange_count ?? 0);
      const prodRatePct =
        prodSizeExch === 0
          ? 0
          : Math.min(
              100,
              Math.round((prodSizeExch / Math.max(totalOrdered, prodSizeExch, 1)) * 10000) / 100,
            );
      return {
        productId: row.product_id,
        productName: row.product_name ?? 'Sản phẩm TryVibe Atelier',
        totalOrdered,
        rmaCount,
        sizeExchangeRatePct: prodRatePct,
      };
    });

    return {
      totalOrders: Number(orderAgg?.total_orders ?? 0),
      confirmedPaidOrders: Number(orderAgg?.confirmed_paid_orders ?? 0),
      deliveredOrders: Number(orderAgg?.delivered_orders ?? 0),
      latePaymentAlertsCount: Number(orderAgg?.late_payment_alerts_count ?? 0),
      totalRevenueVnd: Number(orderAgg?.total_revenue_vnd ?? 0),
      totalRmaCount,
      sizeExchangeRatePct,
      rmaByProduct,
    };
  }

  async listAdminOrders(filters: {
    status?: string;
    q?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<ExtendedOrderDTO[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.status && filters.status.trim().length > 0 && filters.status.trim().toUpperCase() !== 'ALL') {
      params.push(filters.status.trim().toUpperCase());
      clauses.push(`status = $${params.length}`);
    }

    if (filters.q && filters.q.trim().length > 0) {
      params.push(`%${filters.q.trim()}%`);
      clauses.push(
        `(order_code ILIKE $${params.length} OR customer_email ILIKE $${params.length} OR customer_phone ILIKE $${params.length})`,
      );
    }

    if (filters.from && !Number.isNaN(Date.parse(filters.from))) {
      params.push(new Date(filters.from).toISOString());
      clauses.push(`created_at >= $${params.length}::timestamptz`);
    }

    if (filters.to && !Number.isNaN(Date.parse(filters.to))) {
      params.push(new Date(filters.to).toISOString());
      clauses.push(`created_at <= $${params.length}::timestamptz`);
    }

    const limit = Math.min(1000, Math.max(1, filters.limit ?? 100));
    params.push(limit);

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.db.query<OrderRow>(
      `SELECT * FROM orders ${whereSql} ORDER BY created_at DESC LIMIT $${params.length}`,
      params,
    );
    return this.hydrateOrders(res.rows);
  }

  async packOrder(
    orderCode: string,
    rawBody: unknown,
    trace: string | TraceContext,
  ): Promise<ExtendedOrderDTO> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const input = parseWithZod(PackOrderBodySchema, rawBody ?? {});
    const packPhotoUrl = input.packPhotoUrl ?? input.pack_photo_url;
    if (!packPhotoUrl) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Trường packPhotoUrl là bắt buộc khi xác nhận đóng gói đơn hàng.',
      );
    }

    const row = await this.loadOrderRowByCodeOrId(orderCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }

    if (row.status !== OrderStatus.CONFIRMED && row.status !== OrderStatus.PACKING) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể đóng gói đơn hàng đang ở trạng thái ${row.status}.`,
      );
    }

    let updatedShipment!: ShipmentDTO;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE orders SET status = $2, updated_at = NOW() WHERE id = $1`,
        [row.id, OrderStatus.PACKING],
      );
      const ensured = await this.ensureShipmentForOrder(tx, row);
      const shipRes = await tx.query<ShipmentRow>(
        `UPDATE shipments
         SET pack_photo_url = $2,
             status = $3,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [ensured.id, packPhotoUrl, ShipmentStatus.PICKED],
      );
      updatedShipment = this.mapShipmentRow(shipRes.rows[0]);
      await this.writeOutbox(tx, {
        eventName: 'order.packed',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          packPhotoUrl,
          scannedSkuCodes: input.scannedSkuCodes ?? [],
        },
      });
    });

    await Promise.allSettled([
      this.upstream.notifyOrderPackedNonFatal(
        {
          eventId: `order-packed:${row.order_code}`,
          orderCode: row.order_code,
          customerEmail: row.customer_email || 'customer@atelier.local',
          customerPhone: row.customer_phone,
          packPhotoUrl,
          trackingCode: updatedShipment.trackingCode,
        },
        trace,
      ),
      this.upstream.emitRealtimeOrderEventNonFatal(
        {
          event: 'order:updated',
          orderId: row.id,
          orderCode: row.order_code,
          status: OrderStatus.PACKING,
          shipment: updatedShipment,
        },
        trace,
      ),
    ]);

    return this.loadAndHydrateOrderById(row.id);
  }

  async quoteShipping(rawBody: unknown): Promise<ShippingQuoteResponseDto> {
    const input = parseWithZod(ShippingQuoteBodySchema, rawBody ?? {});
    const orderValueVnd = input.orderValueVnd ?? input.subtotalVnd ?? 0;

    const quoteReq = {
      provinceCode: input.provinceCode,
      districtCode: input.districtCode,
      wardCode: input.wardCode,
      provinceName: input.provinceName,
      districtName: input.districtName,
      wardName: input.wardName,
      streetLine: input.streetLine,
      shippingMethod: input.shippingMethod,
      weightGrams: input.weightGrams,
      orderValueVnd,
      codAmountVnd: input.codAmountVnd,
    };

    const quotes = await this.shippingRegistry.quoteAll(quoteReq);
    const primary = input.shippingMethod
      ? (quotes.find((q) => q.shippingMethod === input.shippingMethod) ??
        (await this.shippingRegistry.quote(quoteReq)))
      : (quotes.find((q) => q.shippingMethod === ShippingMethod.GHN) ?? quotes[0]);

    const freeShippingEligible = orderValueVnd >= FREE_SHIP_THRESHOLD_VND;
    const effectiveFeeVnd =
      primary.shippingMethod === ShippingMethod.PICKUP || freeShippingEligible
        ? 0
        : primary.feeVnd;

    return {
      ...primary,
      freeShippingThresholdVnd: FREE_SHIP_THRESHOLD_VND,
      freeShippingEligible,
      effectiveFeeVnd,
      quotes,
    };
  }

  async shipOrder(
    orderCode: string,
    trace: string | TraceContext,
    rawBody?: unknown,
  ): Promise<ExtendedOrderDTO> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const input = parseWithZod(ShipOrderBodySchema, rawBody ?? undefined);
    const row = await this.loadOrderRowByCodeOrId(orderCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }

    if (
      row.status !== OrderStatus.PACKING &&
      row.status !== OrderStatus.CONFIRMED &&
      row.status !== OrderStatus.SHIPPED
    ) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể chuyển trạng thái giao vận khi đơn hàng đang ở trạng thái ${row.status}.`,
      );
    }

    const orderItemsRes = await this.db.query<OrderItemRow>(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [row.id],
    );
    const address = parseJsonValue<ShippingAddressSnapshot>(row.shipping_address_jsonb, {
      recipientName: 'Quý khách',
      phone: row.customer_phone ?? '0900000000',
      provinceName: 'Thành phố Hà Nội',
      districtName: 'Quận Ba Đình',
      wardName: 'Phường Quán Thánh',
      streetLine: '18 Phan Đình Phùng',
    });

    const effectiveShippingMethod = (input?.shippingMethod ??
      (row.shipping_method as ShippingMethod)) as ShippingMethod;
    const totalQty = orderItemsRes.rows.reduce((sum, item) => sum + Number(item.qty || 1), 0);
    const weightGrams = input?.weightGrams ?? Math.max(350, totalQty * 350);
    const codAmountVnd =
      row.payment_method === PaymentMethod.COD
        ? Math.max(0, Number(row.grand_total_vnd) - Number(row.deposit_required_vnd))
        : 0;

    let trackingCode: string;
    let actualFeeVnd: number;
    let providerMode: string;
    let expectedDeliveryTime: string;
    let providerResponse: Record<string, unknown>;
    let carrierLabel: string;

    if (input?.trackingCode && input.trackingCode.trim().length > 0) {
      trackingCode = input.trackingCode.trim();
      const quoteRes = await this.shippingRegistry.quote({
        provinceCode: address.provinceCode,
        districtCode: address.districtCode,
        wardCode: address.wardCode,
        provinceName: address.provinceName,
        districtName: address.districtName,
        wardName: address.wardName,
        streetLine: address.streetLine,
        shippingMethod: effectiveShippingMethod,
        weightGrams,
        orderValueVnd: Number(row.grand_total_vnd),
        codAmountVnd,
      });
      actualFeeVnd = quoteRes.feeVnd;
      providerMode = 'MANUAL_OVERRIDE';
      expectedDeliveryTime = quoteRes.estimatedDeliveryDate;
      carrierLabel =
        input.carrier?.trim().toUpperCase() ||
        (effectiveShippingMethod === ShippingMethod.PICKUP
          ? 'SHOWROOM_PICKUP'
          : effectiveShippingMethod);
      providerResponse = {
        manualOverride: true,
        carrier: carrierLabel,
        trackingCode,
        estimatedFeeVnd: actualFeeVnd,
      };
    } else {
      const shipmentResult = await this.shippingRegistry.createShipment({
        orderId: row.id,
        orderCode: row.order_code,
        shippingMethod: effectiveShippingMethod,
        recipientName: address.recipientName || 'Quý khách',
        recipientPhone: address.phone || row.customer_phone || '0900000000',
        provinceCode: address.provinceCode,
        districtCode: address.districtCode,
        wardCode: address.wardCode,
        provinceName: address.provinceName || 'Thành phố Hà Nội',
        districtName: address.districtName || 'Quận Ba Đình',
        wardName: address.wardName || 'Phường Quán Thánh',
        streetLine: address.streetLine || '18 Phan Đình Phùng',
        weightGrams,
        orderValueVnd: Number(row.grand_total_vnd),
        codAmountVnd,
        items: orderItemsRes.rows.map((item) => ({
          name: item.product_name,
          skuCode: item.sku_code,
          qty: Number(item.qty || 1),
          priceVnd: Number(item.unit_price_vnd || 0),
          weightGrams: 350,
        })),
        note: input?.note,
      });

      trackingCode = shipmentResult.trackingCode;
      actualFeeVnd = shipmentResult.actualFeeVnd;
      providerMode = shipmentResult.mode;
      expectedDeliveryTime = shipmentResult.expectedDeliveryTime;
      carrierLabel =
        input?.carrier?.trim().toUpperCase() ||
        (effectiveShippingMethod === ShippingMethod.PICKUP
          ? 'SHOWROOM_PICKUP'
          : effectiveShippingMethod);
      providerResponse = shipmentResult.rawProviderResponse;
    }

    const existingEvents = parseJsonValue<ShippingTrackingEventRecord[]>(
      row.shipping_tracking_events_jsonb,
      [],
    );
    const nowIso = new Date().toISOString();
    const nextEvents: ShippingTrackingEventRecord[] = [
      ...(Array.isArray(existingEvents) ? existingEvents : []),
      {
        eventId: `ship:${row.order_code}:${trackingCode}`,
        provider: carrierLabel.toLowerCase(),
        trackingCode,
        providerStatus: 'SHIPMENT_CREATED',
        mappedOrderStatus: OrderStatus.SHIPPED,
        mappedRmaStatus: null,
        note: input?.note || `Đã bàn giao đơn vị vận chuyển ${carrierLabel} (${providerMode})`,
        occurredAt: nowIso,
        recordedAt: nowIso,
      },
    ];

    let updatedShipment!: ExtendedShipmentDTO;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE orders
         SET status = $2,
             shipping_actual_fee_vnd = $3,
             shipping_provider_mode = $4,
             shipping_tracking_events_jsonb = $5::jsonb,
             updated_at = NOW()
         WHERE id = $1`,
        [
          row.id,
          OrderStatus.SHIPPED,
          actualFeeVnd,
          providerMode,
          JSON.stringify(nextEvents),
        ],
      );
      const ensured = await this.ensureShipmentForOrder(tx, row);
      const shipRes = await tx.query<ShipmentRow>(
        `UPDATE shipments
         SET carrier = $2,
             tracking_code = $3,
             status = $4,
             actual_fee_vnd = $5,
             provider_mode = $6,
             expected_delivery_time = $7::timestamptz,
             provider_response_jsonb = $8::jsonb,
             updated_at = NOW()
         WHERE id = $1
         RETURNING *`,
        [
          ensured.id,
          carrierLabel,
          trackingCode,
          ShipmentStatus.IN_TRANSIT,
          actualFeeVnd,
          providerMode,
          expectedDeliveryTime,
          JSON.stringify(providerResponse),
        ],
      );
      updatedShipment = this.mapShipmentRow(shipRes.rows[0]);
      await this.writeOutbox(tx, {
        eventName: 'order.shipped',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          carrier: carrierLabel,
          trackingCode: updatedShipment.trackingCode,
          actualFeeVnd,
          providerMode,
          expectedDeliveryTime,
        },
      });
    });

    await this.upstream.emitRealtimeOrderEventNonFatal(
      {
        event: 'order:updated',
        orderId: row.id,
        orderCode: row.order_code,
        status: OrderStatus.SHIPPED,
        shipment: updatedShipment,
      },
      trace,
    );

    return this.loadAndHydrateOrderById(row.id);
  }

  async handleShippingWebhook(
    providerSlug: string,
    rawBody: unknown,
    rawBodyBuffer: Buffer | string,
    headers: HeaderBag,
    trace: string | TraceContext,
  ): Promise<ShippingWebhookProcessResult> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const adapter = this.shippingRegistry.getAdapterBySlug(providerSlug);
    if (!adapter) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        `Đơn vị vận chuyển "${providerSlug}" không được hỗ trợ webhook (chỉ hỗ trợ: ghn, ghtk, ahamove).`,
      );
    }

    const verified = adapter.verifyWebhook(headers, rawBodyBuffer);
    if (!verified) {
      throw new ApiDomainException(
        HttpStatus.UNAUTHORIZED,
        ErrorCode.UNAUTHORIZED,
        `Chữ ký webhook vận chuyển (${adapter.slug}) không hợp lệ hoặc bị thiếu.`,
      );
    }

    const payloadObj: Record<string, unknown> =
      rawBody && typeof rawBody === 'object' && !Array.isArray(rawBody)
        ? (rawBody as Record<string, unknown>)
        : {};

    const parsed = adapter.parseWebhook(payloadObj, headers);

    const dedup = await this.db.query<{ event_id: string }>(
      `INSERT INTO processed_shipping_webhooks (
         event_id, provider, tracking_code, order_code, provider_status, payload_jsonb
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       ON CONFLICT (event_id) DO NOTHING
       RETURNING event_id`,
      [
        parsed.eventId,
        parsed.provider,
        parsed.trackingCode,
        parsed.orderCode,
        parsed.providerStatus,
        JSON.stringify(payloadObj),
      ],
    );

    if (dedup.rowCount === 0) {
      return {
        deduplicated: true,
        processed: false,
        eventId: parsed.eventId,
        provider: parsed.provider,
        trackingCode: parsed.trackingCode,
        orderCode: parsed.orderCode,
        providerStatus: parsed.providerStatus,
        mappedOrderStatus: parsed.mappedOrderStatus,
        mappedShipmentStatus: parsed.mappedShipmentStatus,
        mappedRmaStatus: parsed.mappedRmaStatus,
        orderUpdated: false,
        rmaUpdated: false,
        matchedOrderCode: null,
        matchedRmaCode: null,
        occurredAt: parsed.occurredAt,
      };
    }

    const trackingEvent: ShippingTrackingEventRecord = {
      eventId: parsed.eventId,
      provider: parsed.provider,
      trackingCode: parsed.trackingCode,
      providerStatus: parsed.providerStatus,
      mappedOrderStatus: parsed.mappedOrderStatus,
      mappedRmaStatus: parsed.mappedRmaStatus,
      note: parsed.note,
      occurredAt: parsed.occurredAt,
      recordedAt: new Date().toISOString(),
    };

    // 1. Check if trackingCode or orderCode matches a 2-way RMA shipment first
    let matchedRma: RmaRow | null = null;
    let isExchangeLeg = false;
    if (parsed.trackingCode) {
      const rmaByTrack = await this.db.query<RmaRow>(
        `SELECT * FROM rma_requests
         WHERE return_tracking_code = $1 OR exchange_tracking_code = $1
         LIMIT 1`,
        [parsed.trackingCode],
      );
      if (rmaByTrack.rows[0]) {
        matchedRma = rmaByTrack.rows[0];
        isExchangeLeg = matchedRma.exchange_tracking_code === parsed.trackingCode;
      }
    }
    if (!matchedRma && parsed.orderCode && parsed.orderCode.toUpperCase().startsWith('RMA-')) {
      matchedRma = await this.loadRmaByIdOrCode(parsed.orderCode);
    }

    let rmaUpdated = false;
    let effectiveRmaStatus: RmaStatus | null = parsed.mappedRmaStatus;
    let rmaParentOrder: OrderRow | null = null;

    if (matchedRma) {
      if (isExchangeLeg) {
        if (parsed.mappedOrderStatus === OrderStatus.SHIPPED) {
          effectiveRmaStatus = RmaStatus.EXCHANGE_SHIPPED;
        } else if (parsed.mappedOrderStatus === OrderStatus.DELIVERED) {
          effectiveRmaStatus =
            matchedRma.status === RmaStatus.EXCHANGE_SHIPPED ||
            matchedRma.status === RmaStatus.QC_PASSED
              ? RmaStatus.RMA_COMPLETED
              : RmaStatus.EXCHANGE_SHIPPED;
        } else {
          effectiveRmaStatus = null;
        }
      } else {
        // Customer return leg arriving back to Atelier warehouse
        if (parsed.mappedOrderStatus === OrderStatus.SHIPPED) {
          effectiveRmaStatus = RmaStatus.RETURN_IN_TRANSIT;
        } else if (parsed.mappedOrderStatus === OrderStatus.DELIVERED) {
          effectiveRmaStatus = RmaStatus.QC_INSPECTING;
        } else {
          effectiveRmaStatus = null;
        }
      }

      const prevRmaEvents = parseJsonValue<ShippingTrackingEventRecord[]>(
        matchedRma.shipping_tracking_events_jsonb,
        [],
      );
      const nextRmaEvents = [
        ...(Array.isArray(prevRmaEvents) ? prevRmaEvents : []),
        { ...trackingEvent, mappedRmaStatus: effectiveRmaStatus },
      ];

      await this.db.transaction(async (tx) => {
        if (
          effectiveRmaStatus &&
          matchedRma!.status !== RmaStatus.RMA_COMPLETED &&
          matchedRma!.status !== RmaStatus.RMA_REJECTED
        ) {
          await tx.query(
            `UPDATE rma_requests
             SET status = $2,
                 shipping_tracking_events_jsonb = $3::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [matchedRma!.id, effectiveRmaStatus, JSON.stringify(nextRmaEvents)],
          );
          rmaUpdated = true;
        } else {
          await tx.query(
            `UPDATE rma_requests
             SET shipping_tracking_events_jsonb = $2::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [matchedRma!.id, JSON.stringify(nextRmaEvents)],
          );
        }

        await this.writeOutbox(tx, {
          eventName: 'rma.shipping.updated',
          aggregateType: 'RMA',
          aggregateId: matchedRma!.id,
          correlationId,
          payload: {
            rmaId: matchedRma!.id,
            rmaCode: matchedRma!.rma_code,
            provider: parsed.provider,
            trackingCode: parsed.trackingCode,
            providerStatus: parsed.providerStatus,
            mappedRmaStatus: effectiveRmaStatus,
            leg: isExchangeLeg ? 'EXCHANGE' : 'RETURN',
          },
        });
      });

      const parentRes = await this.db.query<OrderRow>(
        'SELECT * FROM orders WHERE id = $1 LIMIT 1',
        [matchedRma.order_id],
      );
      rmaParentOrder = parentRes.rows[0] ?? null;
    }

    // 2. Match standard Order shipment (skip mutating order status if webhook was exclusively for an RMA tracking code)
    let matchedOrder: OrderRow | null = null;
    let matchedShipment: ShipmentRow | null = null;
    let orderUpdated = false;
    let updatedShipmentDto: ExtendedShipmentDTO | null = null;

    if (!matchedRma) {
      if (parsed.trackingCode) {
        const shipRes = await this.db.query<ShipmentRow>(
          'SELECT * FROM shipments WHERE tracking_code = $1 LIMIT 1',
          [parsed.trackingCode],
        );
        if (shipRes.rows[0]) {
          matchedShipment = shipRes.rows[0];
          const ordRes = await this.db.query<OrderRow>(
            'SELECT * FROM orders WHERE id = $1 LIMIT 1',
            [matchedShipment.order_id],
          );
          matchedOrder = ordRes.rows[0] ?? null;
        }
      }
      if (!matchedOrder && parsed.orderCode) {
        matchedOrder = await this.loadOrderRowByCodeOrId(parsed.orderCode);
        if (matchedOrder) {
          const shipRes = await this.db.query<ShipmentRow>(
            'SELECT * FROM shipments WHERE order_id = $1 ORDER BY updated_at DESC LIMIT 1',
            [matchedOrder.id],
          );
          matchedShipment = shipRes.rows[0] ?? null;
        }
      }
    }

    if (matchedOrder) {
      const prevOrderEvents = parseJsonValue<ShippingTrackingEventRecord[]>(
        matchedOrder.shipping_tracking_events_jsonb,
        [],
      );
      const nextOrderEvents = [
        ...(Array.isArray(prevOrderEvents) ? prevOrderEvents : []),
        trackingEvent,
      ];

      await this.db.transaction(async (tx) => {
        if (
          parsed.mappedOrderStatus &&
          matchedOrder!.status !== OrderStatus.COMPLETED &&
          matchedOrder!.status !== OrderStatus.CANCELLED
        ) {
          const isDelivered = parsed.mappedOrderStatus === OrderStatus.DELIVERED;
          await tx.query(
            `UPDATE orders
             SET status = $2,
                 delivered_at = CASE WHEN $3::boolean THEN COALESCE(delivered_at, $4::timestamptz) ELSE delivered_at END,
                 shipping_tracking_events_jsonb = $5::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [
              matchedOrder!.id,
              parsed.mappedOrderStatus,
              isDelivered,
              parsed.occurredAt,
              JSON.stringify(nextOrderEvents),
            ],
          );
          orderUpdated = true;
        } else {
          await tx.query(
            `UPDATE orders
             SET shipping_tracking_events_jsonb = $2::jsonb,
                 updated_at = NOW()
             WHERE id = $1`,
            [matchedOrder!.id, JSON.stringify(nextOrderEvents)],
          );
        }

        if (matchedShipment && parsed.mappedShipmentStatus) {
          const shipUpd = await tx.query<ShipmentRow>(
            `UPDATE shipments
             SET status = $2, updated_at = NOW()
             WHERE id = $1
             RETURNING *`,
            [matchedShipment.id, parsed.mappedShipmentStatus],
          );
          if (shipUpd.rows[0]) {
            updatedShipmentDto = this.mapShipmentRow(shipUpd.rows[0]);
          }
        }

        await this.writeOutbox(tx, {
          eventName: 'shipping.webhook.processed',
          aggregateType: 'ORDER',
          aggregateId: matchedOrder!.id,
          correlationId,
          payload: {
            eventId: parsed.eventId,
            provider: parsed.provider,
            orderId: matchedOrder!.id,
            orderCode: matchedOrder!.order_code,
            trackingCode: parsed.trackingCode,
            providerStatus: parsed.providerStatus,
            mappedOrderStatus: parsed.mappedOrderStatus,
            mappedShipmentStatus: parsed.mappedShipmentStatus,
          },
        });
      });

      const realtimeEvent: 'order:updated' | 'order:shipped' | 'order:delivered' =
        parsed.mappedOrderStatus === OrderStatus.DELIVERED
          ? 'order:delivered'
          : parsed.mappedOrderStatus === OrderStatus.SHIPPED
            ? 'order:shipped'
            : 'order:updated';

      await Promise.allSettled([
        this.upstream.emitRealtimeOrderEventNonFatal(
          {
            event: realtimeEvent,
            orderId: matchedOrder.id,
            orderCode: matchedOrder.order_code,
            status: parsed.mappedOrderStatus ?? matchedOrder.status,
            shipment: updatedShipmentDto,
            trackingEvent: trackingEvent as unknown as Record<string, unknown>,
          },
          trace,
        ),
        ...(realtimeEvent !== 'order:updated'
          ? [
              this.upstream.emitRealtimeOrderEventNonFatal(
                {
                  event: 'order:updated',
                  orderId: matchedOrder.id,
                  orderCode: matchedOrder.order_code,
                  status: parsed.mappedOrderStatus ?? matchedOrder.status,
                  shipment: updatedShipmentDto,
                  trackingEvent: trackingEvent as unknown as Record<string, unknown>,
                },
                trace,
              ),
            ]
          : []),
      ]);
    } else if (matchedRma && rmaParentOrder) {
      await this.upstream.emitRealtimeOrderEventNonFatal(
        {
          event: 'order:updated',
          orderId: rmaParentOrder.id,
          orderCode: rmaParentOrder.order_code,
          status: rmaParentOrder.status,
          trackingEvent: {
            ...trackingEvent,
            rmaCode: matchedRma.rma_code,
            rmaStatus: effectiveRmaStatus ?? matchedRma.status,
          },
        },
        trace,
      );
    }

    return {
      deduplicated: false,
      processed: true,
      eventId: parsed.eventId,
      provider: parsed.provider,
      trackingCode: parsed.trackingCode,
      orderCode: parsed.orderCode,
      providerStatus: parsed.providerStatus,
      mappedOrderStatus: parsed.mappedOrderStatus,
      mappedShipmentStatus: parsed.mappedShipmentStatus,
      mappedRmaStatus: effectiveRmaStatus,
      orderUpdated,
      rmaUpdated,
      matchedOrderCode: matchedOrder?.order_code ?? rmaParentOrder?.order_code ?? null,
      matchedRmaCode: matchedRma?.rma_code ?? null,
      occurredAt: parsed.occurredAt,
    };
  }

  async deliverOrder(
    orderCode: string,
    trace: string | TraceContext,
  ): Promise<ExtendedOrderDTO> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const row = await this.loadOrderRowByCodeOrId(orderCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }

    if (
      row.status !== OrderStatus.SHIPPED &&
      row.status !== OrderStatus.PACKING &&
      row.status !== OrderStatus.CONFIRMED &&
      row.status !== OrderStatus.DELIVERED
    ) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể xác nhận đã giao khi đơn hàng đang ở trạng thái ${row.status}.`,
      );
    }

    let updatedShipment!: ShipmentDTO;
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE orders
         SET status = $2,
             delivered_at = COALESCE(delivered_at, NOW()),
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, OrderStatus.DELIVERED],
      );
      const ensured = await this.ensureShipmentForOrder(tx, row);
      const shipRes = await tx.query<ShipmentRow>(
        `UPDATE shipments SET status = $2, updated_at = NOW() WHERE id = $1 RETURNING *`,
        [ensured.id, ShipmentStatus.DELIVERED],
      );
      updatedShipment = this.mapShipmentRow(shipRes.rows[0]);
      await this.writeOutbox(tx, {
        eventName: 'order.delivered',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          deliveredAt: new Date().toISOString(),
        },
      });
    });

    await this.upstream.emitRealtimeOrderEventNonFatal(
      {
        event: 'order:updated',
        orderId: row.id,
        orderCode: row.order_code,
        status: OrderStatus.DELIVERED,
        shipment: updatedShipment,
      },
      trace,
    );

    return this.loadAndHydrateOrderById(row.id);
  }

  async refundLatePayment(
    orderCode: string,
    trace: string | TraceContext,
  ): Promise<
    ExtendedOrderDTO & {
      order: ExtendedOrderDTO;
      refund: RefundResponseDTO | null;
      idempotentReplay: boolean;
    }
  > {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const row = await this.loadOrderRowByCodeOrId(orderCode);
    if (!row) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }

    if (row.late_payment_refunded && row.status === OrderStatus.CANCELLED) {
      const existingOrder = await this.loadAndHydrateOrderById(row.id);
      return {
        ...existingOrder,
        order: existingOrder,
        refund: null,
        idempotentReplay: true,
      };
    }

    if (row.status !== OrderStatus.LATE_PAYMENT_NEEDS_REFUND) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Chỉ được hoàn tiền thanh toán muộn cho đơn hàng trạng thái LATE_PAYMENT_NEEDS_REFUND (hiện tại: ${row.status}).`,
      );
    }

    const refundAmountVnd = Math.max(1, Number(row.grand_total_vnd));
    const refund = await this.upstream.createRefund(
      {
        orderId: row.id,
        orderCode: row.order_code,
        amountVnd: refundAmountVnd,
        reason: 'LATE_PAYMENT_AUTO_REFUND',
        idempotencyKey: `late-refund:${row.id}`,
      },
      trace,
    );

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE orders
         SET status = $2,
             late_payment_refunded = TRUE,
             cancelled_at = COALESCE(cancelled_at, NOW()),
             cancel_reason = 'LATE_PAYMENT_AUTO_REFUND',
             updated_at = NOW()
         WHERE id = $1`,
        [row.id, OrderStatus.CANCELLED],
      );
      await this.writeOutbox(tx, {
        eventName: 'order.late_payment_refunded',
        aggregateType: 'ORDER',
        aggregateId: row.id,
        correlationId,
        payload: {
          orderId: row.id,
          orderCode: row.order_code,
          refundId: refund.refundId,
          amountVnd: refund.amountVnd,
        },
      });
    });

    await this.upstream.emitRealtimeOrderEventNonFatal(
      {
        event: 'order:updated',
        orderId: row.id,
        orderCode: row.order_code,
        status: OrderStatus.CANCELLED,
      },
      trace,
    );

    const updatedOrder = await this.loadAndHydrateOrderById(row.id);
    return {
      ...updatedOrder,
      order: updatedOrder,
      refund,
      idempotentReplay: false,
    };
  }

  async checkDeliveredPurchase(
    userId: string | undefined,
    productId: string | undefined,
  ): Promise<{ eligible: boolean; orderCode?: string; orderId?: string }> {
    const cleanUserId = userId?.trim() ?? '';
    const cleanProductId = productId?.trim() ?? '';

    if (!UUID_REGEX.test(cleanUserId) || !UUID_REGEX.test(cleanProductId)) {
      return { eligible: false };
    }

    const res = await this.db.query<{ order_id: string; order_code: string }>(
      `SELECT o.id AS order_id, o.order_code
       FROM orders o
       JOIN order_items oi ON oi.order_id = o.id
       WHERE o.user_id = $1::uuid
         AND oi.product_id = $2::uuid
         AND o.status IN ($3, $4)
       ORDER BY o.delivered_at DESC NULLS LAST, o.created_at DESC
       LIMIT 1`,
      [cleanUserId, cleanProductId, OrderStatus.DELIVERED, OrderStatus.COMPLETED],
    );

    if (res.rows.length === 0) {
      return { eligible: false };
    }

    return {
      eligible: true,
      orderCode: res.rows[0].order_code,
      orderId: res.rows[0].order_id,
    };
  }

  // ==========================================================================
  // 5. 2-Mode Size Exchange RMA & 3-Criterion QC Checklist
  // ==========================================================================

  async createRmaRequest(
    orderCode: string,
    rawBody: unknown,
    actor: OrderActorContext,
  ): Promise<RmaRequestDTO> {
    const input = parseWithZod(CreateRmaBodySchema, rawBody);
    const rmaType = input.type ?? input.rmaType;
    if (!rmaType) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Vui lòng chọn loại yêu cầu đổi trả (SIZE_EXCHANGE, COLOR_EXCHANGE hoặc RETURN_REFUND).',
      );
    }

    const orderRow = await this.loadOrderRowByCodeOrId(orderCode);
    if (!orderRow) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }

    this.assertOrderOwnership(orderRow, actor);

    if (orderRow.status !== OrderStatus.DELIVERED && orderRow.status !== OrderStatus.COMPLETED) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.ORDER_NOT_DELIVERED,
        'Chỉ được tạo yêu cầu đổi size/trả hàng sau khi đơn hàng đã giao thành công (DELIVERED).',
        { orderStatus: orderRow.status },
      );
    }

    // Check 7-day standard / 14-day GOLD & DIAMOND return window
    let loyaltyTier = actor.loyaltyTier?.toUpperCase() ?? null;
    if (!loyaltyTier && orderRow.user_id) {
      const profile = await this.upstream.fetchCustomerCheckoutProfile(
        orderRow.user_id,
        actor,
      );
      loyaltyTier = profile?.loyaltyTier?.toUpperCase() ?? 'BRONZE';
    }
    const windowDays = loyaltyTier === 'GOLD' || loyaltyTier === 'DIAMOND' ? 14 : 7;
    const deliveredAt = orderRow.delivered_at ? new Date(orderRow.delivered_at) : new Date();
    const elapsedMs = Date.now() - deliveredAt.getTime();
    if (elapsedMs > windowDays * 86_400_000) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.RMA_WINDOW_EXPIRED,
        `Đơn hàng đã quá thời hạn đổi trả ${windowDays} ngày kể từ ngày nhận hàng.`,
        { windowDays, deliveredAt: deliveredAt.toISOString(), loyaltyTier },
      );
    }

    const orderItemsRes = await this.db.query<OrderItemRow>(
      'SELECT * FROM order_items WHERE order_id = $1 ORDER BY id ASC',
      [orderRow.id],
    );
    let targetItem: OrderItemRow | undefined;
    if (input.orderItemId) {
      targetItem = orderItemsRes.rows.find((item) => item.id === input.orderItemId);
    } else if (input.skuId) {
      targetItem = orderItemsRes.rows.find((item) => item.sku_id === input.skuId);
    } else if (orderItemsRes.rows.length === 1) {
      targetItem = orderItemsRes.rows[0];
    }

    if (!targetItem) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy sản phẩm tương ứng trong đơn hàng để tạo yêu cầu RMA.',
      );
    }

    if (!targetItem.is_returnable) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.RMA_NOT_RETURNABLE,
        'Sản phẩm này không thuộc diện hỗ trợ đổi trả theo chính sách Atelier.',
      );
    }

    if (input.qty > Number(targetItem.qty)) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        `Số lượng đổi trả (${input.qty}) vượt quá số lượng đã mua (${targetItem.qty}).`,
      );
    }

    // Resolve replacement SKU for exchange requests
    let replacementSkuId = input.targetSkuId ?? input.replacementSkuId ?? null;
    if (!replacementSkuId && input.targetSkuCode) {
      const snaps = await this.upstream.fetchSkusSnapshot(
        { skuCodes: [input.targetSkuCode] },
        actor,
      );
      replacementSkuId = snaps.get(input.targetSkuCode)?.skuId ?? null;
    }

    if (
      (rmaType === RmaType.SIZE_EXCHANGE || rmaType === RmaType.COLOR_EXCHANGE) &&
      (!replacementSkuId || !UUID_REGEX.test(replacementSkuId))
    ) {
      throw new ApiDomainException(
        HttpStatus.BAD_REQUEST,
        ErrorCode.VALIDATION_ERROR,
        'Yêu cầu đổi size/màu cần cung cấp targetSkuId hợp lệ của phiên bản muốn đổi.',
      );
    }

    const sanitizedNote = truncateRmaCustomerNote(input.customerNote);
    const evidencePhotos = input.evidencePhotoUrls ?? input.evidencePhotos ?? [];
    const rmaId = crypto.randomUUID();
    const rmaCode = generateRmaCode();
    const expectedRefundVnd =
      rmaType === RmaType.RETURN_REFUND
        ? Number(targetItem.net_refundable_unit_vnd) * input.qty
        : 0;

    await this.db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO rma_requests (
           id, rma_code, order_id, user_id, rma_type, exchange_mode,
           status, reason_code, customer_note, evidence_photos_jsonb,
           qc_checklist_jsonb, replacement_sku_id, exchange_reservation_id,
           refund_amount_vnd, created_at, updated_at
         ) VALUES (
           $1, $2, $3, $4, $5, $6,
           $7, $8, $9, $10::jsonb,
           NULL, $11, NULL,
           $12, NOW(), NOW()
         )`,
        [
          rmaId,
          rmaCode,
          orderRow.id,
          actor.userId ?? orderRow.user_id,
          rmaType,
          input.exchangeMode,
          RmaStatus.RMA_REQUESTED,
          input.reasonCode,
          sanitizedNote,
          JSON.stringify(evidencePhotos),
          replacementSkuId,
          expectedRefundVnd,
        ],
      );

      await tx.query(
        `INSERT INTO rma_items (
           id, rma_id, order_item_id, sku_id, product_id,
           size_purchased, qty, supplier_batch_code
         ) VALUES (
           $1, $2, $3, $4, $5,
           $6, $7, $8
         )`,
        [
          crypto.randomUUID(),
          rmaId,
          targetItem.id,
          targetItem.sku_id,
          targetItem.product_id,
          targetItem.size_code,
          input.qty,
          targetItem.supplier_batch_code,
        ],
      );

      await this.writeOutbox(tx, {
        eventName: EVENT_NAMES.RMA_REQUESTED,
        aggregateType: 'RMA',
        aggregateId: rmaId,
        correlationId: actor.correlationId,
        payload: {
          rmaId,
          rmaCode,
          orderId: orderRow.id,
          orderCode: orderRow.order_code,
          rmaType,
          exchangeMode: input.exchangeMode,
          reasonCode: input.reasonCode,
        },
      });
    });

    await this.publishDomainEventNonFatal(
      EVENT_NAMES.RMA_REQUESTED,
      {
        rmaId,
        orderId: orderRow.id,
        customerId: actor.userId ?? orderRow.user_id ?? 'guest',
        rmaType: rmaType === RmaType.RETURN_REFUND ? 'RETURN_REFUND' : 'SIZE_EXCHANGE',
        reasonCode:
          input.reasonCode === RmaReasonCode.SAI_KICH_CO_CHAT
            ? 'TOO_SMALL'
            : input.reasonCode === RmaReasonCode.SAI_KICH_CO_RONG
              ? 'TOO_LARGE'
              : input.reasonCode === RmaReasonCode.LOI_SAN_XUAT
                ? 'DEFECTIVE'
                : 'OTHER',
        originalSkuCode: targetItem.sku_code,
        quantity: input.qty,
      },
      actor.correlationId,
      `rma-req:${rmaId}`,
    );

    const createdRes = await this.db.query<RmaRow>('SELECT * FROM rma_requests WHERE id = $1', [
      rmaId,
    ]);
    const [hydrated] = await this.hydrateRmas(createdRes.rows);
    return hydrated;
  }

  async listOrderRmas(
    orderCode: string,
    actor: OrderActorContext,
  ): Promise<RmaRequestDTO[]> {
    const orderRow = await this.loadOrderRowByCodeOrId(orderCode);
    if (!orderRow) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy đơn hàng "${orderCode}".`,
      );
    }
    this.assertOrderOwnership(orderRow, actor);
    const res = await this.db.query<RmaRow>(
      'SELECT * FROM rma_requests WHERE order_id = $1 ORDER BY created_at DESC',
      [orderRow.id],
    );
    return this.hydrateRmas(res.rows);
  }

  async listAdminRmas(filters: {
    status?: string;
    rmaType?: string;
    reasonCode?: string;
    orderCode?: string;
    productId?: string;
    from?: string;
    to?: string;
    limit?: number;
  }): Promise<RmaRequestDTO[]> {
    const clauses: string[] = [];
    const params: unknown[] = [];

    if (filters.status?.trim() && filters.status.trim().toUpperCase() !== 'ALL') {
      const normalizedStatus = filters.status.trim().toUpperCase();
      if (normalizedStatus === 'REJECTED') {
        clauses.push(`r.status IN ('RMA_REJECTED', 'REJECTED')`);
      } else {
        params.push(normalizedStatus);
        clauses.push(`r.status = $${params.length}`);
      }
    }
    if (filters.rmaType?.trim()) {
      params.push(filters.rmaType.trim().toUpperCase());
      clauses.push(`r.rma_type = $${params.length}`);
    }
    if (filters.reasonCode?.trim()) {
      params.push(filters.reasonCode.trim().toUpperCase());
      clauses.push(`r.reason_code = $${params.length}`);
    }
    if (filters.orderCode?.trim()) {
      params.push(filters.orderCode.trim());
      clauses.push(`o.order_code = $${params.length}`);
    }
    if (filters.productId?.trim() && UUID_REGEX.test(filters.productId.trim())) {
      params.push(filters.productId.trim());
      clauses.push(
        `EXISTS (SELECT 1 FROM rma_items ri WHERE ri.rma_id = r.id AND ri.product_id = $${params.length}::uuid)`,
      );
    }
    if (filters.from && !Number.isNaN(Date.parse(filters.from))) {
      params.push(new Date(filters.from).toISOString());
      clauses.push(`r.created_at >= $${params.length}::timestamptz`);
    }
    if (filters.to && !Number.isNaN(Date.parse(filters.to))) {
      params.push(new Date(filters.to).toISOString());
      clauses.push(`r.created_at <= $${params.length}::timestamptz`);
    }

    const limit = Math.min(1000, Math.max(1, filters.limit ?? 100));
    params.push(limit);

    const whereSql = clauses.length > 0 ? `WHERE ${clauses.join(' AND ')}` : '';
    const res = await this.db.query<RmaRow>(
      `SELECT r.*, o.order_code
       FROM rma_requests r
       JOIN orders o ON o.id = r.order_id
       ${whereSql}
       ORDER BY r.created_at DESC
       LIMIT $${params.length}`,
      params,
    );
    return this.hydrateRmas(res.rows);
  }

  private async loadRmaByIdOrCode(rmaIdOrCode: string): Promise<RmaRow | null> {
    const trimmed = rmaIdOrCode.trim();
    if (!trimmed) {
      return null;
    }
    if (UUID_REGEX.test(trimmed)) {
      const res = await this.db.query<RmaRow>(
        'SELECT * FROM rma_requests WHERE id = $1::uuid OR rma_code = $2 LIMIT 1',
        [trimmed, trimmed],
      );
      return res.rows[0] ?? null;
    }
    const res = await this.db.query<RmaRow>(
      'SELECT * FROM rma_requests WHERE rma_code = $1 LIMIT 1',
      [trimmed],
    );
    return res.rows[0] ?? null;
  }

  async approveRma(
    rmaIdOrCode: string,
    rawBody: unknown,
    trace: string | TraceContext,
  ): Promise<RmaRequestDTO> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const input = parseWithZod(ApproveRmaBodySchema, rawBody ?? undefined);
    const rma = await this.loadRmaByIdOrCode(rmaIdOrCode);
    if (!rma) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy yêu cầu RMA "${rmaIdOrCode}".`,
      );
    }

    if (
      rma.status === RmaStatus.INSTANT_2WAY_DISPATCHED ||
      rma.status === RmaStatus.EXCHANGE_RESERVED ||
      rma.status === RmaStatus.RETURN_IN_TRANSIT
    ) {
      const [hydrated] = await this.hydrateRmas([rma]);
      return hydrated;
    }

    if (rma.status !== RmaStatus.RMA_REQUESTED) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể duyệt RMA đang ở trạng thái ${rma.status}.`,
      );
    }

    const rmaItemsRes = await this.db.query<RmaItemRow>(
      'SELECT * FROM rma_items WHERE rma_id = $1 ORDER BY id ASC LIMIT 1',
      [rma.id],
    );
    const rmaItem = rmaItemsRes.rows[0];
    if (!rmaItem) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy dòng sản phẩm thuộc yêu cầu RMA này.',
      );
    }

    const exchangeMode = (input?.exchangeMode ?? rma.exchange_mode) as RmaExchangeMode;
    const replacementSkuId =
      input?.replacementSkuId ?? input?.targetSkuId ?? rma.replacement_sku_id;
    const isExchange =
      rma.rma_type === RmaType.SIZE_EXCHANGE || rma.rma_type === RmaType.COLOR_EXCHANGE;

    let exchangeReservationId: string | null = rma.exchange_reservation_id;
    let nextStatus: RmaStatus;

    if (exchangeMode === RmaExchangeMode.INSTANT_2WAY) {
      if (!replacementSkuId) {
        throw new ApiDomainException(
          HttpStatus.BAD_REQUEST,
          ErrorCode.VALIDATION_ERROR,
          'Đổi nhanh 2 chiều (INSTANT_2WAY) yêu cầu có SKU thay thế hợp lệ.',
        );
      }

      const reservation = await this.upstream.reserveStock(
        {
          referenceId: rma.id,
          reservationType: 'SIZE_EXCHANGE',
          items: [{ skuId: replacementSkuId, qty: Number(rmaItem.qty) }],
          ttlSeconds: 86_400,
          idempotencyKey: `rma-exch:${rma.id}`,
        },
        trace,
      );
      exchangeReservationId = reservation.reservationId;
      // Transition EXCHANGE_RESERVED -> INSTANT_2WAY_DISPATCHED
      nextStatus = RmaStatus.INSTANT_2WAY_DISPATCHED;
    } else if (isExchange && replacementSkuId) {
      const reservation = await this.upstream.reserveStock(
        {
          referenceId: rma.id,
          reservationType: 'SIZE_EXCHANGE',
          items: [{ skuId: replacementSkuId, qty: Number(rmaItem.qty) }],
          ttlSeconds: 86_400,
          idempotencyKey: `rma-exch:${rma.id}`,
        },
        trace,
      );
      exchangeReservationId = reservation.reservationId;
      nextStatus = RmaStatus.EXCHANGE_RESERVED;
    } else {
      nextStatus = RmaStatus.RETURN_IN_TRANSIT;
    }

    const cleanRmaTag = rma.rma_code.replace(/[^A-Z0-9]/gi, '').toUpperCase();
    const returnTrackingCode =
      input?.returnTrackingCode ??
      rma.return_tracking_code ??
      `GHNRET-${cleanRmaTag}`;
    const exchangeTrackingCode =
      input?.exchangeTrackingCode ??
      rma.exchange_tracking_code ??
      (exchangeMode === RmaExchangeMode.INSTANT_2WAY ? `GHNEXC-${cleanRmaTag}` : null);

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE rma_requests
         SET status = $2,
             exchange_mode = $3,
             replacement_sku_id = $4,
             exchange_reservation_id = $5,
             return_tracking_code = COALESCE($6, return_tracking_code),
             exchange_tracking_code = COALESCE($7, exchange_tracking_code),
             updated_at = NOW()
         WHERE id = $1`,
        [
          rma.id,
          nextStatus,
          exchangeMode,
          replacementSkuId,
          exchangeReservationId,
          returnTrackingCode,
          exchangeTrackingCode,
        ],
      );
      await this.writeOutbox(tx, {
        eventName: 'rma.approved',
        aggregateType: 'RMA',
        aggregateId: rma.id,
        correlationId,
        payload: {
          rmaId: rma.id,
          rmaCode: rma.rma_code,
          status: nextStatus,
          exchangeMode,
          exchangeReservationId,
          returnTrackingCode,
          exchangeTrackingCode,
        },
      });
    });

    const updated = await this.loadRmaByIdOrCode(rma.id);
    const [hydrated] = await this.hydrateRmas([updated!]);
    return hydrated;
  }

  async rejectRma(
    rmaIdOrCode: string,
    rawBody: unknown,
    actor: OrderActorContext,
  ): Promise<RmaMutationResult> {
    const input = parseWithZod(RejectRmaDtoSchema, rawBody);
    const rma = await this.loadRmaByIdOrCode(rmaIdOrCode);
    if (!rma) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy yêu cầu RMA "${rmaIdOrCode}".`,
      );
    }

    const [before] = await this.hydrateRmas([rma]);
    if (rma.status === RmaStatus.RMA_REJECTED) {
      return {
        ...before,
        before,
        after: before,
        customerNotified: false,
      };
    }

    if (
      rma.status === RmaStatus.RMA_COMPLETED ||
      rma.status === RmaStatus.QC_PASSED ||
      rma.status === RmaStatus.REFUND_PROCESSING
    ) {
      throw new ApiDomainException(
        HttpStatus.CONFLICT,
        ErrorCode.CONFLICT,
        `Không thể từ chối yêu cầu RMA đã hoàn tất hoặc đang hoàn tiền (trạng thái hiện tại: ${rma.status}).`,
        { currentStatus: rma.status },
      );
    }

    const rejectedBy =
      input.rejectedBy?.trim() ||
      actor.actorEmail?.trim() ||
      actor.userId?.trim() ||
      'admin';

    if (rma.exchange_reservation_id) {
      await this.upstream.releaseReservationNonFatal(
        rma.id,
        'CANCEL_RELEASE',
        rma.exchange_reservation_id,
        actor,
      );
    }

    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE rma_requests
         SET status = $2,
             rejection_reason = $3,
             rejected_by = $4,
             rejected_at = NOW(),
             updated_at = NOW()
         WHERE id = $1`,
        [rma.id, RmaStatus.RMA_REJECTED, input.reason.trim(), rejectedBy],
      );

      await this.writeOutbox(tx, {
        eventName: 'rma.rejected',
        aggregateType: 'RMA',
        aggregateId: rma.id,
        correlationId: actor.correlationId,
        payload: {
          rmaId: rma.id,
          rmaCode: rma.rma_code,
          orderId: rma.order_id,
          reason: input.reason.trim(),
          rejectedBy,
        },
      });
    });

    let customerNotified = false;
    const orderRes = await this.db.query<OrderRow>(
      'SELECT * FROM orders WHERE id = $1 LIMIT 1',
      [rma.order_id],
    );
    const parentOrder = orderRes.rows[0];
    if (parentOrder?.customer_email) {
      const shippingAddr = parseJsonValue<ShippingAddressSnapshot | null>(
        parentOrder.shipping_address_jsonb,
        null,
      );
      customerNotified = await this.upstream.notifyRmaRejectedNonFatal(
        {
          eventId: `rma-rejected:${rma.rma_code}`,
          rmaId: rma.id,
          rmaCode: rma.rma_code,
          orderCode: parentOrder.order_code,
          customerEmail: parentOrder.customer_email,
          customerPhone: parentOrder.customer_phone,
          customerName: shippingAddr?.recipientName ?? null,
          reason: input.reason.trim(),
          rejectedBy,
        },
        actor,
      );
    }

    const updated = await this.loadRmaByIdOrCode(rma.id);
    const [after] = await this.hydrateRmas([updated!]);
    return {
      ...after,
      before,
      after,
      customerNotified,
    };
  }

  async completeRmaQc(
    rmaIdOrCode: string,
    rawBody: unknown,
    trace: string | TraceContext,
  ): Promise<RmaRequestDTO> {
    const correlationId = typeof trace === 'string' ? trace : trace.correlationId;
    const input = parseWithZod(CompleteRmaQcDtoSchema, rawBody);
    const rma = await this.loadRmaByIdOrCode(rmaIdOrCode);
    if (!rma) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        `Không tìm thấy yêu cầu RMA "${rmaIdOrCode}".`,
      );
    }

    if (rma.status === RmaStatus.RMA_COMPLETED) {
      const [hydrated] = await this.hydrateRmas([rma]);
      return hydrated;
    }

    const [rmaItemsRes, orderRes] = await Promise.all([
      this.db.query<RmaItemRow>(
        'SELECT * FROM rma_items WHERE rma_id = $1 ORDER BY id ASC LIMIT 1',
        [rma.id],
      ),
      this.db.query<OrderRow>('SELECT * FROM orders WHERE id = $1 LIMIT 1', [rma.order_id]),
    ]);

    const rmaItem = rmaItemsRes.rows[0];
    const order = orderRes.rows[0];
    if (!rmaItem || !order) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Dữ liệu sản phẩm hoặc đơn hàng gốc của yêu cầu RMA không tồn tại.',
      );
    }

    const orderItemRes = await this.db.query<OrderItemRow>(
      'SELECT * FROM order_items WHERE id = $1 LIMIT 1',
      [rmaItem.order_item_id],
    );
    const orderItem = orderItemRes.rows[0];
    if (!orderItem) {
      throw new ApiDomainException(
        HttpStatus.NOT_FOUND,
        ErrorCode.NOT_FOUND,
        'Không tìm thấy dòng đơn hàng gốc cho yêu cầu RMA.',
      );
    }

    const qcPayload = {
      ...input,
      inspectedAt: new Date().toISOString(),
    };

    if (!input.passed) {
      if (rma.exchange_reservation_id) {
        await this.upstream.releaseReservationNonFatal(
          rma.id,
          'CANCEL_RELEASE',
          rma.exchange_reservation_id,
          trace,
        );
      }

      await this.db.transaction(async (tx) => {
        await tx.query(
          `UPDATE rma_requests
           SET status = $2,
               qc_checklist_jsonb = $3::jsonb,
               updated_at = NOW()
           WHERE id = $1`,
          [rma.id, RmaStatus.QC_FAILED, JSON.stringify(qcPayload)],
        );
        await this.writeOutbox(tx, {
          eventName: 'rma.qc_failed',
          aggregateType: 'RMA',
          aggregateId: rma.id,
          correlationId,
          payload: {
            rmaId: rma.id,
            rmaCode: rma.rma_code,
            qcResult: qcPayload,
          },
        });
      });

      const failedRow = await this.loadRmaByIdOrCode(rma.id);
      const [hydrated] = await this.hydrateRmas([failedRow!]);
      return hydrated;
    }

    // QC PASSED:
    // Step 1: Mark QC_PASSED + store 3-criterion checklist
    await this.db.query(
      `UPDATE rma_requests
       SET status = $2,
           qc_checklist_jsonb = $3::jsonb,
           updated_at = NOW()
       WHERE id = $1`,
      [rma.id, RmaStatus.QC_PASSED, JSON.stringify(qcPayload)],
    );

    // Step 2: Restock original returned SKU (or record damaged if LOI_SAN_XUAT)
    const restockable = rma.reason_code !== RmaReasonCode.LOI_SAN_XUAT;
    await this.upstream.rmaRestock(
      {
        skuId: rmaItem.sku_id,
        qty: Number(rmaItem.qty),
        restockable,
        referenceId: rma.rma_code,
      },
      trace,
    );

    // Step 3: Commit exchange reservation OR trigger exact partial refund
    let finalRefundAmountVnd = Number(rma.refund_amount_vnd ?? 0);
    let refundTransactionId: string | null = rma.refund_transaction_id;

    if (rma.rma_type === RmaType.RETURN_REFUND) {
      finalRefundAmountVnd = Number(orderItem.net_refundable_unit_vnd) * Number(rmaItem.qty);

      await this.db.query(
        `UPDATE rma_requests
         SET status = $2,
             refund_amount_vnd = $3,
             updated_at = NOW()
         WHERE id = $1`,
        [rma.id, RmaStatus.REFUND_PROCESSING, finalRefundAmountVnd],
      );

      if (finalRefundAmountVnd > 0) {
        const refundRes = await this.upstream.createRefund(
          {
            orderId: order.id,
            orderCode: order.order_code,
            amountVnd: finalRefundAmountVnd,
            reason: 'RMA_PARTIAL_REFUND',
            rmaId: rma.id,
            idempotencyKey: `rma-refund:${rma.id}`,
          },
          trace,
        );
        refundTransactionId = refundRes.refundId;
      }
    } else if (rma.exchange_reservation_id) {
      await this.upstream.commitReservation(rma.id, rma.exchange_reservation_id, trace);
      await this.db.query(
        `UPDATE rma_requests SET status = $2, updated_at = NOW() WHERE id = $1`,
        [rma.id, RmaStatus.EXCHANGE_SHIPPED],
      );
    }

    // Step 4: Finalize RMA_COMPLETED + transactional outbox
    await this.db.transaction(async (tx) => {
      await tx.query(
        `UPDATE rma_requests
         SET status = $2,
             refund_amount_vnd = $3,
             refund_transaction_id = $4,
             updated_at = NOW()
         WHERE id = $1`,
        [rma.id, RmaStatus.RMA_COMPLETED, finalRefundAmountVnd, refundTransactionId],
      );
      await this.writeOutbox(tx, {
        eventName: EVENT_NAMES.RMA_QC_PASSED,
        aggregateType: 'RMA',
        aggregateId: rma.id,
        correlationId,
        payload: {
          rmaId: rma.id,
          rmaCode: rma.rma_code,
          orderId: order.id,
          orderCode: order.order_code,
          restockable,
          refundAmountVnd: finalRefundAmountVnd,
          refundTransactionId,
        },
      });
    });

    await this.publishDomainEventNonFatal(
      EVENT_NAMES.RMA_QC_PASSED,
      {
        rmaId: rma.id,
        orderId: order.id,
        warehouseId: 'CENTRAL_HN',
        inspectorId: 'admin-qc',
        returnedSkuCode: orderItem.sku_code,
        restockable,
        ...(finalRefundAmountVnd > 0 ? { refundAmountVnd: finalRefundAmountVnd } : {}),
        inspectedAt: qcPayload.inspectedAt,
      },
      correlationId,
      `rma-qc-passed:${rma.id}`,
    );

    const completedRow = await this.loadRmaByIdOrCode(rma.id);
    const [hydrated] = await this.hydrateRmas([completedRow!]);
    return hydrated;
  }

  // ==========================================================================
  // 6. RMA Sizing & Defect Stats (GET /v1/admin/rma/stats)
  // ==========================================================================

  async getRmaStats(params: {
    productId?: string;
    periodDays?: number;
  }): Promise<RmaStatsSummaryDTO> {
    const periodDays = Math.min(365, Math.max(1, Math.round(params.periodDays ?? 30)));
    const cleanProductId =
      params.productId && UUID_REGEX.test(params.productId.trim())
        ? params.productId.trim()
        : null;

    const queryParams: unknown[] = [String(periodDays)];
    let productClause = '';
    if (cleanProductId) {
      queryParams.push(cleanProductId);
      productClause = `AND ri.product_id = $${queryParams.length}::uuid`;
    }

    const rmaDataRes = await this.db.query<{
      rma_code: string;
      reason_code: string;
      customer_note: string;
      product_id: string;
      size_purchased: string;
      qty: string | number;
      supplier_batch_code: string | null;
      product_name: string | null;
      sku_code: string | null;
      created_at: string | Date;
    }>(
      `SELECT r.rma_code, r.reason_code, r.customer_note, r.created_at,
              ri.product_id, ri.size_purchased, ri.qty, ri.supplier_batch_code,
              oi.product_name, oi.sku_code
       FROM rma_requests r
       JOIN rma_items ri ON ri.rma_id = r.id
       LEFT JOIN order_items oi ON oi.id = ri.order_item_id
       WHERE r.created_at >= NOW() - ($1 || ' days')::interval
       ${productClause}
       ORDER BY r.created_at ASC`,
      queryParams,
    );

    const deliveredParams: unknown[] = [String(periodDays)];
    let deliveredProductJoin = '';
    let deliveredProductWhere = '';
    if (cleanProductId) {
      deliveredParams.push(cleanProductId);
      deliveredProductJoin = 'JOIN order_items oi ON oi.order_id = o.id';
      deliveredProductWhere = `AND oi.product_id = $${deliveredParams.length}::uuid`;
    }
    const deliveredRes = await this.db.query<{ cnt: string | number }>(
      `SELECT COUNT(DISTINCT o.id)::int AS cnt
       FROM orders o
       ${deliveredProductJoin}
       WHERE o.status IN ('DELIVERED', 'COMPLETED')
         AND COALESCE(o.delivered_at, o.created_at) >= NOW() - ($1 || ' days')::interval
         ${deliveredProductWhere}`,
      deliveredParams,
    );

    const totalDeliveredOrders = Number(deliveredRes.rows[0]?.cnt ?? 0);
    const totalRmaCount = rmaDataRes.rows.length;
    const overallReturnRatePct =
      totalRmaCount === 0
        ? 0
        : Math.min(
            100,
            Math.round((totalRmaCount / Math.max(totalDeliveredOrders, totalRmaCount)) * 10000) /
              100,
          );

    const byReason: Record<string, number> = {};
    const productAgg = new Map<
      string,
      {
        productId: string;
        productName?: string;
        skuCode?: string;
        totalRmas: number;
        byReason: Record<string, number>;
      }
    >();
    const batchAgg = new Map<
      string,
      {
        supplierBatchCode: string;
        productId: string;
        totalRmas: number;
        defectCount: number;
      }
    >();

    const sampleCustomerNotes: RmaStatsSummaryDTO['sampleCustomerNotes'] = [];

    for (const row of rmaDataRes.rows) {
      const reason = (row.reason_code || RmaReasonCode.KHAC) as RmaReasonCode;
      byReason[reason] = (byReason[reason] ?? 0) + 1;

      const prodEntry = productAgg.get(row.product_id) ?? {
        productId: row.product_id,
        productName: row.product_name ?? undefined,
        skuCode: row.sku_code ?? undefined,
        totalRmas: 0,
        byReason: {} as Record<string, number>,
      };
      prodEntry.totalRmas += 1;
      prodEntry.byReason[reason] = (prodEntry.byReason[reason] ?? 0) + 1;
      productAgg.set(row.product_id, prodEntry);

      if (row.supplier_batch_code) {
        const key = `${row.supplier_batch_code}::${row.product_id}`;
        const batchEntry = batchAgg.get(key) ?? {
          supplierBatchCode: row.supplier_batch_code,
          productId: row.product_id,
          totalRmas: 0,
          defectCount: 0,
        };
        batchEntry.totalRmas += 1;
        if (reason === RmaReasonCode.LOI_SAN_XUAT) {
          batchEntry.defectCount += 1;
        }
        batchAgg.set(key, batchEntry);
      }

      const cleanNote = truncateRmaCustomerNote(row.customer_note);
      if (cleanNote.length > 0 && sampleCustomerNotes.length < 5) {
        sampleCustomerNotes.push({
          rmaCode: row.rma_code,
          productId: row.product_id,
          sizePurchased: row.size_purchased || 'M',
          reasonCode: reason,
          customerNote: cleanNote,
        });
      }
    }

    const byProduct = Array.from(productAgg.values())
      .map((entry) => {
        const sortedReasons = Object.entries(entry.byReason).sort((a, b) => b[1] - a[1]);
        const dominantReasonCode = (sortedReasons[0]?.[0] ?? RmaReasonCode.KHAC) as RmaReasonCode;
        return {
          productId: entry.productId,
          productName: entry.productName,
          skuCode: entry.skuCode,
          totalRmas: entry.totalRmas,
          returnRatePct: Math.min(
            100,
            Math.round((entry.totalRmas / Math.max(totalDeliveredOrders, entry.totalRmas)) * 10000) /
              100,
          ),
          dominantReasonCode,
          byReason: entry.byReason,
        };
      })
      .sort((a, b) => b.totalRmas - a.totalRmas);

    const bySupplierBatch = Array.from(batchAgg.values()).sort((a, b) => b.totalRmas - a.totalRmas);

    return {
      periodDays,
      totalRmaCount,
      totalDeliveredOrders,
      overallReturnRatePct,
      byProduct,
      bySupplierBatch,
      byReason,
      sampleCustomerNotes,
    };
  }
}
