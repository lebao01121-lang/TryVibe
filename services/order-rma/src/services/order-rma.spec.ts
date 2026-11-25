import * as crypto from 'node:crypto';
import { HttpStatus } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ErrorCode,
  OrderStatus,
  PaymentMethod,
  RmaExchangeMode,
  RmaReasonCode,
  RmaStatus,
  RmaType,
  ShippingMethod,
} from '@atelier/contracts';
import type { AtelierDbExecutor } from '@atelier/db-client';
import type {
  CatalogSkuSnapshot,
  UpstreamServicesClient,
} from '../clients/upstream-services.client';
import { ApiDomainException } from '../common/api-exception';
import type { OrderRmaConfig } from '../config/env';
import type { OrderDbService } from '../db/order-db.service';
import type { OrderRabbitMqService } from '../infra/rabbitmq.service';
import { ShippingProviderRegistry } from '../shipping/shipping-provider.registry';
import {
  OrderRmaService,
  computeProportionalAllocations,
  type OrderActorContext,
} from './order-rma.service';

const USER_ID = '50000000-0000-4000-8000-000000000001';
const OTHER_USER_ID = '50000000-0000-4000-8000-000000000002';
const SKU_1 = '20000000-0000-4000-8000-000000000001';
const SKU_2 = '20000000-0000-4000-8000-000000000002';
const SKU_3 = '20000000-0000-4000-8000-000000000003';
const SKU_EXCHANGE_L = '20000000-0000-4000-8000-000000000009';
const PROD_1 = '30000000-0000-4000-8000-000000000001';
const PROD_2 = '30000000-0000-4000-8000-000000000002';
const PROD_3 = '30000000-0000-4000-8000-000000000003';

interface FakeOrderRow {
  id: string;
  order_code: string;
  idempotency_key: string;
  user_id: string | null;
  guest_session_id: string | null;
  customer_email: string | null;
  customer_phone: string | null;
  status: string;
  subtotal_vnd: number;
  combo_discount_vnd: number;
  voucher_discount_vnd: number;
  voucher_code: string | null;
  packaging_fee_vnd: number;
  shipping_fee_vnd: number;
  deposit_required_vnd: number;
  grand_total_vnd: number;
  payment_method: string;
  shipping_method: string;
  delivery_date: string | null;
  delivery_slot: string | null;
  shipping_address_jsonb: string;
  packaging_option_jsonb: string | null;
  gift_note: string | null;
  reservation_id: string | null;
  reservation_expires_at: string | null;
  late_payment_refunded: boolean;
  paid_at: string | null;
  delivered_at: string | null;
  completed_at: string | null;
  completed_by: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  cancelled_by: string | null;
  payment_intent_jsonb: string | null;
  shipping_actual_fee_vnd: number | null;
  shipping_provider_mode: string | null;
  shipping_tracking_events_jsonb: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeOrderItemRow {
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
  unit_price_vnd: number;
  allocated_discount_vnd: number;
  net_refundable_unit_vnd: number;
  qty: number;
  bundle_group_id: string | null;
  is_returnable: boolean;
  supplier_batch_code: string | null;
}

interface FakeShipmentRow {
  id: string;
  order_id: string;
  warehouse_code: string;
  carrier: string;
  tracking_code: string;
  status: string;
  pack_photo_url: string | null;
  cod_collect_vnd: number;
  actual_fee_vnd: number | null;
  provider_mode: string | null;
  expected_delivery_time: string | null;
  provider_response_jsonb: string | null;
  updated_at: string;
}

interface FakeRmaRow {
  id: string;
  rma_code: string;
  order_id: string;
  user_id: string | null;
  rma_type: string;
  exchange_mode: string;
  status: string;
  reason_code: string;
  customer_note: string;
  evidence_photos_jsonb: string;
  qc_checklist_jsonb: string | null;
  replacement_sku_id: string | null;
  exchange_reservation_id: string | null;
  refund_amount_vnd: number;
  refund_transaction_id: string | null;
  rejection_reason: string | null;
  rejected_by: string | null;
  rejected_at: string | null;
  return_tracking_code: string | null;
  exchange_tracking_code: string | null;
  shipping_tracking_events_jsonb: string | null;
  created_at: string;
  updated_at: string;
}

interface FakeRmaItemRow {
  id: string;
  rma_id: string;
  order_item_id: string;
  sku_id: string;
  product_id: string;
  size_purchased: string;
  qty: number;
  supplier_batch_code: string | null;
}

interface OrderDbState {
  orders: FakeOrderRow[];
  orderItems: FakeOrderItemRow[];
  shipments: FakeShipmentRow[];
  rmas: FakeRmaRow[];
  rmaItems: FakeRmaItemRow[];
  processedEvents: Set<string>;
  processedShippingWebhooks: Set<string>;
  outbox: Array<{ id: string; event_name: string }>;
}

class InMemoryOrderDb {
  public state: OrderDbState = {
    orders: [],
    orderItems: [],
    shipments: [],
    rmas: [],
    rmaItems: [],
    processedEvents: new Set(),
    processedShippingWebhooks: new Set(),
    outbox: [],
  };
  public ready = true;

  isReady(): boolean {
    return this.ready;
  }

  private exec<T>(state: OrderDbState, sql: string, params: unknown[] = []): { rows: T[]; rowCount: number } {
    const norm = sql.replace(/\s+/g, ' ').trim();
    const now = new Date().toISOString();

    // outbox
    if (norm.startsWith('INSERT INTO outbox_events')) {
      state.outbox.push({ id: String(params[0]), event_name: String(params[1]) });
      return { rows: [], rowCount: 1 };
    }

    // processed_events & processed_shipping_webhooks
    if (norm.startsWith('INSERT INTO processed_events')) {
      const id = String(params[0]);
      if (state.processedEvents.has(id)) return { rows: [], rowCount: 0 };
      state.processedEvents.add(id);
      return { rows: [{ event_id: id }] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO processed_shipping_webhooks')) {
      const id = String(params[0]);
      if (state.processedShippingWebhooks.has(id)) return { rows: [], rowCount: 0 };
      state.processedShippingWebhooks.add(id);
      return { rows: [{ event_id: id }] as unknown as T[], rowCount: 1 };
    }

    // orders SELECT
    if (norm.startsWith('SELECT * FROM orders WHERE idempotency_key = $1')) {
      const rows = state.orders.filter((o) => o.idempotency_key === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM orders WHERE id = $1::uuid OR order_code = $2')) {
      const rows = state.orders.filter((o) => o.id === params[0] || o.order_code === params[1]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM orders WHERE order_code = $1')) {
      const rows = state.orders.filter((o) => o.order_code === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM orders WHERE id = $1 LIMIT 1')) {
      const rows = state.orders.filter((o) => o.id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM orders WHERE user_id = $1::uuid')) {
      const rows = state.orders.filter((o) => o.user_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM orders WHERE status = $1 AND reservation_expires_at IS NOT NULL')) {
      const nowMs = Date.now();
      const rows = state.orders.filter(
        (o) =>
          o.status === params[0] &&
          o.reservation_expires_at !== null &&
          new Date(o.reservation_expires_at).getTime() <= nowMs,
      );
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT id, order_code FROM orders WHERE id = ANY($1::uuid[])')) {
      const ids = params[0] as string[];
      const rows = state.orders.filter((o) => ids.includes(o.id)).map((o) => ({ id: o.id, order_code: o.order_code }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT o.id AS order_id, o.order_code FROM orders o JOIN order_items')) {
      const uid = String(params[0]);
      const pid = String(params[1]);
      const statuses = [params[2], params[3]];
      const matched = state.orders.find(
        (o) =>
          o.user_id === uid &&
          statuses.includes(o.status) &&
          state.orderItems.some((oi) => oi.order_id === o.id && oi.product_id === pid),
      );
      return {
        rows: (matched ? [{ order_id: matched.id, order_code: matched.order_code }] : []) as unknown as T[],
        rowCount: matched ? 1 : 0,
      };
    }
    if (norm.startsWith('SELECT * FROM orders')) {
      let rows = [...state.orders];
      const statusMatch = norm.match(/status = \$(\d+)/);
      if (statusMatch) rows = rows.filter((o) => o.status === params[Number(statusMatch[1]) - 1]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // orders INSERT
    if (norm.startsWith('INSERT INTO orders')) {
      const row: FakeOrderRow = {
        id: String(params[0]),
        order_code: String(params[1]),
        idempotency_key: String(params[2]),
        user_id: (params[3] as string | null) ?? null,
        guest_session_id: (params[4] as string | null) ?? null,
        customer_email: (params[5] as string | null) ?? null,
        customer_phone: (params[6] as string | null) ?? null,
        status: String(params[7]),
        subtotal_vnd: Number(params[8]),
        combo_discount_vnd: Number(params[9]),
        voucher_discount_vnd: Number(params[10]),
        voucher_code: (params[11] as string | null) ?? null,
        packaging_fee_vnd: Number(params[12]),
        shipping_fee_vnd: Number(params[13]),
        deposit_required_vnd: Number(params[14]),
        grand_total_vnd: Number(params[15]),
        payment_method: String(params[16]),
        shipping_method: String(params[17]),
        delivery_date: (params[18] as string | null) ?? null,
        delivery_slot: (params[19] as string | null) ?? null,
        shipping_address_jsonb: String(params[20]),
        packaging_option_jsonb: (params[21] as string | null) ?? null,
        gift_note: (params[22] as string | null) ?? null,
        reservation_id: null,
        reservation_expires_at: String(params[23]),
        late_payment_refunded: false,
        paid_at: null,
        delivered_at: null,
        completed_at: null,
        completed_by: null,
        cancelled_at: null,
        cancel_reason: null,
        cancelled_by: null,
        payment_intent_jsonb: null,
        shipping_actual_fee_vnd: null,
        shipping_provider_mode: null,
        shipping_tracking_events_jsonb: null,
        created_at: now,
        updated_at: now,
      };
      state.orders.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }

    // orders UPDATE
    if (norm.startsWith('UPDATE orders SET')) {
      const order = state.orders.find((o) => o.id === params[0]);
      if (!order) return { rows: [], rowCount: 0 };

      if (norm.includes('reservation_id = $3') && norm.includes('payment_intent_jsonb = $5')) {
        order.status = String(params[1]);
        order.reservation_id = (params[2] as string | null) ?? null;
        order.reservation_expires_at = String(params[3]);
        order.payment_intent_jsonb = String(params[4]);
      } else if (norm.includes('paid_at = COALESCE(paid_at, $3::timestamptz)')) {
        order.status = String(params[1]);
        order.paid_at = order.paid_at ?? String(params[2]);
      } else if (norm.includes("reservation_expires_at = NOW() - INTERVAL '1 minute'")) {
        order.reservation_expires_at = new Date(Date.now() - 60_000).toISOString();
      } else if (norm.includes("cancel_reason = 'PAYMENT_TIMEOUT_EXPIRED'")) {
        if (order.status !== params[2]) return { rows: [], rowCount: 0 };
        order.status = String(params[1]);
        order.cancelled_at = now;
        order.cancel_reason = 'PAYMENT_TIMEOUT_EXPIRED';
      } else if (norm.includes('cancel_reason = $3, cancelled_by = $4')) {
        const allowed = params.slice(4);
        if (!allowed.includes(order.status)) return { rows: [], rowCount: 0 };
        order.status = String(params[1]);
        order.cancelled_at = now;
        order.cancel_reason = String(params[2]);
        order.cancelled_by = String(params[3]);
      } else if (norm.includes('late_payment_refunded = TRUE')) {
        order.status = String(params[1]);
        order.late_payment_refunded = true;
        order.cancelled_at = now;
        order.cancel_reason = 'LATE_PAYMENT_AUTO_REFUND';
      } else if (norm.includes('completed_by = $3')) {
        order.status = String(params[1]);
        order.delivered_at = order.delivered_at ?? now;
        order.completed_at = now;
        order.completed_by = String(params[2]);
      } else if (norm.includes('delivered_at = CASE WHEN $3::boolean')) {
        order.status = String(params[1]);
        if (params[2]) order.delivered_at = order.delivered_at ?? String(params[3]);
        order.shipping_tracking_events_jsonb = String(params[4]);
      } else if (norm.includes('shipping_actual_fee_vnd = $3')) {
        order.status = String(params[1]);
        order.shipping_actual_fee_vnd = Number(params[2]);
        order.shipping_provider_mode = String(params[3]);
        order.shipping_tracking_events_jsonb = String(params[4]);
      } else if (norm.includes('delivered_at = COALESCE(delivered_at, NOW())')) {
        order.status = String(params[1]);
        order.delivered_at = order.delivered_at ?? now;
      } else if (norm.includes('SET shipping_tracking_events_jsonb = $2::jsonb')) {
        order.shipping_tracking_events_jsonb = String(params[1]);
      } else if (norm.includes('SET status = $2')) {
        order.status = String(params[1]);
        if (norm.includes('cancel_reason')) {
          order.cancelled_at = now;
        }
      }
      order.updated_at = now;
      return { rows: [order] as unknown as T[], rowCount: 1 };
    }

    // order_items
    if (norm.startsWith('INSERT INTO order_items')) {
      state.orderItems.push({
        id: String(params[0]),
        order_id: String(params[1]),
        product_id: String(params[2]),
        variant_id: String(params[3]),
        sku_id: String(params[4]),
        sku_code: String(params[5]),
        product_name: String(params[6]),
        color_name: String(params[7]),
        size_code: String(params[8]),
        image_url: (params[9] as string | null) ?? null,
        unit_price_vnd: Number(params[10]),
        allocated_discount_vnd: Number(params[11]),
        net_refundable_unit_vnd: Number(params[12]),
        qty: Number(params[13]),
        bundle_group_id: (params[14] as string | null) ?? null,
        is_returnable: Boolean(params[15]),
        supplier_batch_code: null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT * FROM order_items WHERE order_id = ANY($1::uuid[])')) {
      const ids = params[0] as string[];
      const rows = state.orderItems.filter((i) => ids.includes(i.order_id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM order_items WHERE order_id = $1')) {
      const rows = state.orderItems.filter((i) => i.order_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM order_items WHERE id = $1')) {
      const rows = state.orderItems.filter((i) => i.id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }

    // shipments
    if (norm.startsWith('SELECT * FROM shipments WHERE order_id = ANY($1::uuid[])')) {
      const ids = params[0] as string[];
      const rows = state.shipments.filter((s) => ids.includes(s.order_id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM shipments WHERE order_id = $1')) {
      const rows = state.shipments.filter((s) => s.order_id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM shipments WHERE tracking_code = $1')) {
      const rows = state.shipments.filter((s) => s.tracking_code === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('INSERT INTO shipments')) {
      const row: FakeShipmentRow = {
        id: String(params[0]),
        order_id: String(params[1]),
        warehouse_code: String(params[2]),
        carrier: String(params[3]),
        tracking_code: String(params[4]),
        status: String(params[5]),
        pack_photo_url: null,
        cod_collect_vnd: Number(params[6]),
        actual_fee_vnd: null,
        provider_mode: null,
        expected_delivery_time: null,
        provider_response_jsonb: null,
        updated_at: now,
      };
      state.shipments.push(row);
      return { rows: [row] as unknown as T[], rowCount: 1 };
    }
    if (norm.startsWith('UPDATE shipments SET')) {
      const ship = norm.includes('WHERE order_id = $1')
        ? state.shipments.find((s) => s.order_id === params[0])
        : state.shipments.find((s) => s.id === params[0]);
      if (!ship) return { rows: [], rowCount: 0 };
      if (norm.includes('pack_photo_url = $2')) {
        ship.pack_photo_url = String(params[1]);
        ship.status = String(params[2]);
      } else if (norm.includes('carrier = $2, tracking_code = $3')) {
        ship.carrier = String(params[1]);
        ship.tracking_code = String(params[2]);
        ship.status = String(params[3]);
        ship.actual_fee_vnd = Number(params[4]);
        ship.provider_mode = String(params[5]);
        ship.expected_delivery_time = String(params[6]);
        ship.provider_response_jsonb = String(params[7]);
      } else {
        ship.status = String(params[1]);
      }
      ship.updated_at = now;
      return { rows: [ship] as unknown as T[], rowCount: 1 };
    }

    // rma_requests & rma_items
    if (norm.startsWith('INSERT INTO rma_requests')) {
      state.rmas.push({
        id: String(params[0]),
        rma_code: String(params[1]),
        order_id: String(params[2]),
        user_id: (params[3] as string | null) ?? null,
        rma_type: String(params[4]),
        exchange_mode: String(params[5]),
        status: String(params[6]),
        reason_code: String(params[7]),
        customer_note: String(params[8]),
        evidence_photos_jsonb: String(params[9]),
        qc_checklist_jsonb: null,
        replacement_sku_id: (params[10] as string | null) ?? null,
        exchange_reservation_id: null,
        refund_amount_vnd: Number(params[11]),
        refund_transaction_id: null,
        rejection_reason: null,
        rejected_by: null,
        rejected_at: null,
        return_tracking_code: null,
        exchange_tracking_code: null,
        shipping_tracking_events_jsonb: null,
        created_at: now,
        updated_at: now,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('INSERT INTO rma_items')) {
      state.rmaItems.push({
        id: String(params[0]),
        rma_id: String(params[1]),
        order_item_id: String(params[2]),
        sku_id: String(params[3]),
        product_id: String(params[4]),
        size_purchased: String(params[5]),
        qty: Number(params[6]),
        supplier_batch_code: (params[7] as string | null) ?? null,
      });
      return { rows: [], rowCount: 1 };
    }
    if (norm.startsWith('SELECT * FROM rma_requests WHERE return_tracking_code = $1 OR exchange_tracking_code = $1')) {
      const rows = state.rmas
        .filter((r) => r.return_tracking_code === params[0] || r.exchange_tracking_code === params[0])
        .slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_requests WHERE id = $1::uuid OR rma_code = $2')) {
      const rows = state.rmas.filter((r) => r.id === params[0] || r.rma_code === params[1]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_requests WHERE rma_code = $1')) {
      const rows = state.rmas.filter((r) => r.rma_code === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_requests WHERE id = $1')) {
      const rows = state.rmas.filter((r) => r.id === params[0]).slice(0, 1);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_requests WHERE order_id = $1')) {
      const rows = state.rmas.filter((r) => r.order_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT r.*, o.order_code FROM rma_requests r')) {
      const rows = state.rmas.map((r) => ({
        ...r,
        order_code: state.orders.find((o) => o.id === r.order_id)?.order_code,
      }));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_items WHERE rma_id = ANY($1::uuid[])')) {
      const ids = params[0] as string[];
      const rows = state.rmaItems.filter((ri) => ids.includes(ri.rma_id));
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT * FROM rma_items WHERE rma_id = $1')) {
      const rows = state.rmaItems.filter((ri) => ri.rma_id === params[0]);
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('UPDATE rma_requests SET')) {
      const rma = state.rmas.find((r) => r.id === params[0]);
      if (!rma) return { rows: [], rowCount: 0 };
      if (norm.includes('exchange_mode = $3')) {
        rma.status = String(params[1]);
        rma.exchange_mode = String(params[2]);
        rma.replacement_sku_id = (params[3] as string | null) ?? null;
        rma.exchange_reservation_id = (params[4] as string | null) ?? null;
        rma.return_tracking_code = (params[5] as string | null) ?? rma.return_tracking_code;
        rma.exchange_tracking_code = (params[6] as string | null) ?? rma.exchange_tracking_code;
      } else if (norm.includes('rejection_reason = $3')) {
        rma.status = String(params[1]);
        rma.rejection_reason = String(params[2]);
        rma.rejected_by = String(params[3]);
        rma.rejected_at = now;
      } else if (norm.includes('qc_checklist_jsonb = $3')) {
        rma.status = String(params[1]);
        rma.qc_checklist_jsonb = String(params[2]);
      } else if (norm.includes('refund_amount_vnd = $3, refund_transaction_id = $4')) {
        rma.status = String(params[1]);
        rma.refund_amount_vnd = Number(params[2]);
        rma.refund_transaction_id = (params[3] as string | null) ?? null;
      } else if (norm.includes('refund_amount_vnd = $3')) {
        rma.status = String(params[1]);
        rma.refund_amount_vnd = Number(params[2]);
      } else if (norm.includes('shipping_tracking_events_jsonb = $3::jsonb')) {
        rma.status = String(params[1]);
        rma.shipping_tracking_events_jsonb = String(params[2]);
      } else if (norm.includes('SET shipping_tracking_events_jsonb = $2::jsonb')) {
        rma.shipping_tracking_events_jsonb = String(params[1]);
      } else {
        rma.status = String(params[1]);
      }
      rma.updated_at = now;
      return { rows: [rma] as unknown as T[], rowCount: 1 };
    }

    // Metrics & RMA stats
    if (norm.includes('AS confirmed_paid_orders')) {
      return {
        rows: [
          {
            total_orders: state.orders.length,
            confirmed_paid_orders: state.orders.filter((o) =>
              ['CONFIRMED', 'PACKING', 'SHIPPED', 'DELIVERED', 'COMPLETED'].includes(o.status),
            ).length,
            delivered_orders: state.orders.filter((o) => ['DELIVERED', 'COMPLETED'].includes(o.status)).length,
            late_payment_alerts_count: state.orders.filter((o) => o.late_payment_refunded || o.status === 'LATE_PAYMENT_NEEDS_REFUND').length,
            total_revenue_vnd: state.orders.reduce((s, o) => s + o.grand_total_vnd, 0),
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.includes('AS size_exchange_count FROM rma_requests')) {
      return {
        rows: [
          {
            total_rma_count: state.rmas.length,
            size_exchange_count: state.rmas.filter((r) => r.rma_type === RmaType.SIZE_EXCHANGE).length,
          },
        ] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.includes('AS total_ordered_qty FROM order_items')) {
      return {
        rows: [{ total_ordered_qty: state.orderItems.reduce((s, i) => s + i.qty, 0) }] as unknown as T[],
        rowCount: 1,
      };
    }
    if (norm.startsWith('SELECT r.rma_code, r.reason_code, r.customer_note')) {
      const rows = state.rmas.map((r) => {
        const ri = state.rmaItems.find((x) => x.rma_id === r.id)!;
        const oi = state.orderItems.find((x) => x.id === ri?.order_item_id);
        return {
          rma_code: r.rma_code,
          reason_code: r.reason_code,
          customer_note: r.customer_note,
          created_at: r.created_at,
          product_id: ri?.product_id ?? PROD_1,
          size_purchased: ri?.size_purchased ?? 'M',
          qty: ri?.qty ?? 1,
          supplier_batch_code: ri?.supplier_batch_code ?? 'LOT-01',
          product_name: oi?.product_name ?? 'Blazer Linen',
          sku_code: oi?.sku_code ?? 'AT-BLZ-M',
        };
      });
      return { rows: rows as unknown as T[], rowCount: rows.length };
    }
    if (norm.startsWith('SELECT COUNT(DISTINCT o.id)::int AS cnt FROM orders o')) {
      const cnt = state.orders.filter((o) => ['DELIVERED', 'COMPLETED'].includes(o.status)).length;
      return { rows: [{ cnt }] as unknown as T[], rowCount: 1 };
    }

    return { rows: [], rowCount: 0 };
  }

  async query<T = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<{ rows: T[]; rowCount: number }> {
    return this.exec<T>(this.state, sql, params);
  }

  async transaction<T>(fn: (tx: AtelierDbExecutor) => Promise<T>): Promise<T> {
    const snap: OrderDbState = {
      orders: structuredClone(this.state.orders),
      orderItems: structuredClone(this.state.orderItems),
      shipments: structuredClone(this.state.shipments),
      rmas: structuredClone(this.state.rmas),
      rmaItems: structuredClone(this.state.rmaItems),
      processedEvents: new Set(this.state.processedEvents),
      processedShippingWebhooks: new Set(this.state.processedShippingWebhooks),
      outbox: structuredClone(this.state.outbox),
    };
    const tx = {
      query: async <R = Record<string, unknown>>(sql: string, params: unknown[] = []) =>
        this.exec<R>(snap, sql, params),
    } as unknown as AtelierDbExecutor;
    const res = await fn(tx);
    this.state = snap;
    return res;
  }
}

function createOrderHarness(overrides?: { codTrustScore?: number; loyaltyTier?: string }) {
  const db = new InMemoryOrderDb();
  const config: OrderRmaConfig = {
    serviceName: '@atelier/order-rma',
    boundedContext: 'order-rma',
    port: 4006,
    nodeEnv: 'test',
    internalServiceSecret: 'test-internal',
    corsAllowedOrigins: [],
    reservationTtlSeconds: 900,
    sweeperIntervalMs: 60_000,
    database: {
      envVar: 'ORDER_DATABASE_URL',
      configured: false,
      url: 'postgresql://localhost/order_db',
      targetDatabase: 'order_db',
      host: '127.0.0.1',
      port: 5432,
    },
    rabbitmq: { configured: false, url: 'amqp://localhost:5672' },
    upstreams: {
      authCustomerServiceUrl: 'http://127.0.0.1:4001',
      catalogLookbookServiceUrl: 'http://127.0.0.1:4002',
      inventoryServiceUrl: 'http://127.0.0.1:4004',
      cartOutfitServiceUrl: 'http://127.0.0.1:4005',
      paymentPromoServiceUrl: 'http://127.0.0.1:4007',
      notifyReviewServiceUrl: 'http://127.0.0.1:4008',
      bffUrl: 'http://127.0.0.1:4000',
    },
    infra: { rabbitmqConfigured: false },
    shipping: {
      originProvinceCode: '01',
      originProvinceName: 'Thành phố Hà Nội',
      originDistrictCode: '001',
      originDistrictName: 'Quận Ba Đình',
      originWardCode: '00013',
      originWardName: 'Phường Quán Thánh',
      originAddress: '18 Phan Đình Phùng',
      originPhone: '02438882026',
      originName: 'Tầm Xuân Atelier',
      ghn: { token: null, shopId: null, apiUrl: 'https://ghn.test', webhookSecret: 'ghn-sec', fromDistrictId: 1482, fromWardCode: '1A0107' },
      ghtk: { token: null, apiUrl: 'https://ghtk.test', webhookSecret: 'ghtk-sec' },
      ahamove: { token: null, apiUrl: 'https://aha.test', webhookSecret: 'aha-sec' },
    },
  };

  const skuCatalog = new Map<string, CatalogSkuSnapshot>([
    [
      SKU_1,
      {
        skuId: SKU_1,
        skuCode: 'AT-BLZ-M',
        productId: PROD_1,
        productSlug: 'ao-blazer-linen',
        productName: 'Áo Blazer Linen Hữu Cơ',
        variantId: 'var-1',
        colorName: 'Ngà',
        colorHex: '#F5F0E6',
        sizeCode: 'M',
        imageUrl: null,
        basePriceVnd: 1_500_000,
        salePriceVnd: 1_500_000,
        effectivePriceVnd: 1_500_000,
        weightGrams: 550,
        isReturnable: true,
        inStock: true,
      },
    ],
    [
      SKU_2,
      {
        skuId: SKU_2,
        skuCode: 'AT-SLK-S',
        productId: PROD_2,
        productSlug: 'ao-lua-co-tau',
        productName: 'Áo Lụa Cổ Tàu',
        variantId: 'var-2',
        colorName: 'Kem',
        colorHex: '#EFE8DC',
        sizeCode: 'S',
        imageUrl: null,
        basePriceVnd: 1_000_000,
        salePriceVnd: 1_000_000,
        effectivePriceVnd: 1_000_000,
        weightGrams: 280,
        isReturnable: true,
        inStock: true,
      },
    ],
    [
      SKU_3,
      {
        skuId: SKU_3,
        skuCode: 'AT-QAU-M',
        productId: PROD_3,
        productSlug: 'quan-au-ong-suong',
        productName: 'Quần Âu Ống Suông',
        variantId: 'var-3',
        colorName: 'Đen',
        colorHex: '#181818',
        sizeCode: 'M',
        imageUrl: null,
        basePriceVnd: 1_200_000,
        salePriceVnd: 1_200_000,
        effectivePriceVnd: 1_200_000,
        weightGrams: 420,
        isReturnable: true,
        inStock: true,
      },
    ],
  ]);

  const upstream = {
    fetchCart: vi.fn(async () => ({ items: [], packagingOptionId: null, giftNote: null })),
    fetchSkusSnapshot: vi.fn(async () => skuCatalog),
    evaluatePromotions: vi.fn(async (input: { voucherCode?: string | null; subtotalVnd: number; comboDistinctSlots: number }) => {
      const comboPct = input.comboDistinctSlots >= 3 ? 10 : input.comboDistinctSlots === 2 ? 5 : 0;
      const comboDiscountVnd = Math.round((input.subtotalVnd * comboPct) / 100);
      const voucherDiscountVnd = input.voucherCode === 'VIP200' ? 200_000 : 0;
      return {
        valid: input.voucherCode !== 'BADCODE',
        reason: input.voucherCode === 'BADCODE' ? 'Voucher không hợp lệ' : null,
        promotionId: input.voucherCode ? 'promo-1' : null,
        promoType: input.voucherCode ? 'FIXED' : null,
        comboDiscountVnd,
        voucherDiscountVnd,
        discountVnd: comboDiscountVnd + voucherDiscountVnd,
        shippingFeeVnd: null,
        shippingDiscountVnd: 0,
        allocatedItems: [],
      };
    }),
    resolvePackagingOption: vi.fn(async () => null),
    fetchCustomerCheckoutProfile: vi.fn(async () => ({
      email: 'khach@atelier.vn',
      codTrustScore: overrides?.codTrustScore ?? 85,
      loyaltyTier: overrides?.loyaltyTier ?? 'GOLD',
    })),
    reserveStock: vi.fn(async () => ({
      reservationId: 'res-001',
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
      items: [{ skuId: SKU_1, warehouseCode: 'HN_ATELIER', qty: 1 }],
    })),
    commitReservation: vi.fn(async () => undefined),
    releaseReservationNonFatal: vi.fn(async () => true),
    lockPromotion: vi.fn(async () => undefined),
    releasePromotionNonFatal: vi.fn(async () => undefined),
    createPaymentIntent: vi.fn(async (req: { orderId: string; orderCode: string; provider: string; amountVnd: number }) => ({
      transactionId: 'tx-001',
      orderId: req.orderId,
      orderCode: req.orderCode,
      provider: req.provider,
      paymentUrl: null,
      vietQrPayload: '000201...',
      vietQrImageUrl: 'data:image/svg+xml;base64,...',
      amountVnd: req.amountVnd,
      expiresAt: new Date(Date.now() + 900_000).toISOString(),
    })),
    createRefund: vi.fn(async (req: { orderId: string; orderCode: string; amountVnd: number }) => ({
      refundId: 'ref-001',
      orderId: req.orderId,
      orderCode: req.orderCode,
      rmaId: null,
      amountVnd: req.amountVnd,
      status: 'COMPLETED',
      provider: 'VIETQR',
      idempotentReplay: false,
      refundedAt: new Date().toISOString(),
    })),
    rmaRestock: vi.fn(async () => undefined),
    clearCartNonFatal: vi.fn(async () => undefined),
    emitRealtimeOrderEventNonFatal: vi.fn(async () => undefined),
    notifyOrderConfirmedNonFatal: vi.fn(async () => undefined),
    notifyOrderPackedNonFatal: vi.fn(async () => undefined),
    notifyRmaRejectedNonFatal: vi.fn(async () => true),
    grantTryOnBonusNonFatal: vi.fn(async () => undefined),
  } as unknown as UpstreamServicesClient;

  const rabbitmq = {
    publishDomainEvent: vi.fn(async () => true),
  } as unknown as OrderRabbitMqService;

  const shippingRegistry = new ShippingProviderRegistry(config);
  const service = new OrderRmaService(
    config,
    db as unknown as OrderDbService,
    rabbitmq,
    upstream,
    shippingRegistry,
  );

  const actor: OrderActorContext = {
    userId: USER_ID,
    actorEmail: 'khach@atelier.vn',
    guestSessionId: null,
    loyaltyTier: overrides?.loyaltyTier ?? 'GOLD',
    actorRoles: ['CUSTOMER'],
    isInternal: false,
    correlationId: 'corr-ord-1',
  };

  return { service, db, upstream, rabbitmq, shippingRegistry, actor };
}

const SAMPLE_ADDRESS = {
  recipientName: 'Nguyễn Thanh Mai',
  phone: '0901234567',
  provinceName: 'Thành phố Hà Nội',
  districtName: 'Quận Ba Đình',
  wardName: 'Phường Quán Thánh',
  streetLine: '18 Phan Đình Phùng',
  provinceCode: '01',
  districtCode: '001',
  wardCode: '00013',
};

describe('computeProportionalAllocations — Exact Integer VND Invariance', () => {
  it('guarantees SUM(allocatedDiscountVnd) === totalDiscountVnd across indivisible VND amounts', () => {
    const cases = [
      {
        lines: [
          { skuId: 'a', unitPriceVnd: 333_333, qty: 1 },
          { skuId: 'b', unitPriceVnd: 333_333, qty: 1 },
          { skuId: 'c', unitPriceVnd: 333_334, qty: 1 },
        ],
        discount: 100_000,
      },
      {
        lines: [
          { skuId: 'a', unitPriceVnd: 500_000, qty: 1 },
          { skuId: 'b', unitPriceVnd: 500_000, qty: 1 },
          { skuId: 'c', unitPriceVnd: 500_000, qty: 1 },
        ],
        discount: 100_001, // prime / indivisible by 3
      },
      {
        lines: [
          { skuId: 'a', unitPriceVnd: 1_250_000, qty: 2 },
          { skuId: 'b', unitPriceVnd: 890_000, qty: 3 },
        ],
        discount: 477_777,
      },
      {
        lines: [
          { skuId: 'a', unitPriceVnd: 400_000, qty: 1 },
          { skuId: 'b', unitPriceVnd: 600_000, qty: 1 },
        ],
        discount: 1_500_000, // exceeds subtotal -> capped at 1,000,000
      },
    ];

    for (const tc of cases) {
      const subtotal = tc.lines.reduce((s, l) => s + l.unitPriceVnd * l.qty, 0);
      const expectedTotal = Math.min(subtotal, tc.discount);
      const result = computeProportionalAllocations(tc.lines, tc.discount);

      const sumAllocated = result.reduce((s, r) => s + r.allocatedDiscountVnd, 0);
      expect(sumAllocated).toBe(expectedTotal);

      result.forEach((alloc, idx) => {
        const line = tc.lines[idx]!;
        expect(Number.isInteger(alloc.allocatedDiscountVnd)).toBe(true);
        expect(Number.isInteger(alloc.netRefundableUnitVnd)).toBe(true);
        expect(alloc.allocatedDiscountVnd).toBeLessThanOrEqual(line.unitPriceVnd * line.qty);
        expect(alloc.netRefundableUnitVnd).toBe(
          Math.max(0, Math.round((line.unitPriceVnd * line.qty - alloc.allocatedDiscountVnd) / line.qty)),
        );
      });
    }

    // Zero discount preserves full unitPriceVnd
    const zero = computeProportionalAllocations([{ skuId: 'a', unitPriceVnd: 990_000, qty: 2 }], 0);
    expect(zero).toEqual([{ allocatedDiscountVnd: 0, netRefundableUnitVnd: 990_000 }]);
  });
});

describe('OrderRmaService — Checkout Saga, COD Risk Shield & Fulfillment', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('executes Checkout Saga with proportional discount allocation, idempotency, and COD Risk Shield enforcement', async () => {
    const { service, actor } = createOrderHarness({ codTrustScore: 85 });

    // Missing Idempotency-Key -> 400
    await expect(
      service.createOrder({ shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR }, undefined, actor),
    ).rejects.toMatchObject({ code: ErrorCode.VALIDATION_ERROR });

    // 1. Multi-slot outfit checkout with voucher (3 distinct slots -> 10% combo + 200k voucher)
    const order = await service.createOrder(
      {
        shippingAddress: SAMPLE_ADDRESS,
        shippingMethod: ShippingMethod.GHN,
        paymentMethod: PaymentMethod.VIETQR,
        voucherCode: 'VIP200',
        items: [
          { skuId: SKU_1, qty: 1 }, // 1,500,000 OUTERWEAR
          { skuId: SKU_2, qty: 2 }, // 2,000,000 TOP
          { skuId: SKU_3, qty: 1 }, // 1,200,000 BOTTOM
        ],
      },
      'idem-checkout-01',
      actor,
    );

    expect(order.status).toBe(OrderStatus.AWAITING_PAYMENT);
    expect(order.subtotalVnd).toBe(4_700_000);
    expect(order.comboDiscountVnd).toBe(470_000);
    expect(order.voucherDiscountVnd).toBe(200_000);
    const totalAllocated = order.items.reduce((s, i) => s + i.allocatedDiscountVnd, 0);
    expect(totalAllocated).toBe(670_000);
    // Verify netRefundableUnitVnd for qty=2 line respects pro-rated discount
    const sku2Line = order.items.find((i) => i.skuId === SKU_2)!;
    expect(sku2Line.netRefundableUnitVnd).toBe(
      Math.round((2_000_000 - sku2Line.allocatedDiscountVnd) / 2),
    );

    // Idempotent replay returns exact same order
    const replay = await service.createOrder(
      {
        shippingAddress: SAMPLE_ADDRESS,
        shippingMethod: ShippingMethod.GHN,
        paymentMethod: PaymentMethod.VIETQR,
        items: [{ skuId: SKU_1, qty: 1 }],
      },
      'idem-checkout-01',
      actor,
    );
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.id).toBe(order.id);

    // 2. COD Risk Shield — High Value (> 3,000,000 VND) without confirmCodDeposit MUST fail
    await expect(
      service.createOrder(
        {
          shippingAddress: SAMPLE_ADDRESS,
          shippingMethod: ShippingMethod.GHN,
          paymentMethod: PaymentMethod.COD,
          items: [{ skuId: SKU_1, qty: 3 }], // 4,500,000 VND > 3M
        },
        'idem-cod-high',
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.COD_RISK_DEPOSIT_REQUIRED });

    // With confirmCodDeposit=true -> succeeds with 20% deposit & immediate CONFIRMED + shipment
    const codConfirmed = await service.createOrder(
      {
        shippingAddress: SAMPLE_ADDRESS,
        shippingMethod: ShippingMethod.GHN,
        paymentMethod: PaymentMethod.COD,
        confirmCodDeposit: true,
        items: [{ skuId: SKU_1, qty: 3 }],
      },
      'idem-cod-high-ok',
      actor,
    );
    expect(codConfirmed.status).toBe(OrderStatus.CONFIRMED);
    expect(codConfirmed.depositRequiredVnd).toBe(Math.round(codConfirmed.grandTotalVnd * 0.2));
    expect(codConfirmed.shipment?.codCollectVnd).toBe(
      codConfirmed.grandTotalVnd - codConfirmed.depositRequiredVnd,
    );

    // 3. COD Risk Shield — Low Trust Score (< 60) blocks even low-value COD order (< 3M)
    const lowTrustHarness = createOrderHarness({ codTrustScore: 42 });
    await expect(
      lowTrustHarness.service.createOrder(
        {
          shippingAddress: SAMPLE_ADDRESS,
          shippingMethod: ShippingMethod.GHN,
          paymentMethod: PaymentMethod.COD,
          items: [{ skuId: SKU_2, qty: 1 }], // 1,000,000 VND < 3M, but codTrustScore=42 < 60
        },
        'idem-cod-low-trust',
        lowTrustHarness.actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.COD_RISK_DEPOSIT_REQUIRED });
  });

  it('compensates cleanly on reservation conflict, voucher lock failure, and payment intent failure', async () => {
    const { service, db, upstream, actor } = createOrderHarness();

    vi.mocked(upstream.reserveStock).mockRejectedValueOnce(
      new ApiDomainException(HttpStatus.CONFLICT, ErrorCode.INSUFFICIENT_STOCK, 'Out of stock'),
    );
    await expect(
      service.createOrder(
        { shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR, items: [{ skuId: SKU_1, qty: 1 }] },
        'idem-oos',
        actor,
      ),
    ).rejects.toMatchObject({ code: ErrorCode.INSUFFICIENT_STOCK });
    expect(db.state.orders[0]?.status).toBe(OrderStatus.FAILED_OUT_OF_STOCK);

    vi.mocked(upstream.createPaymentIntent).mockRejectedValueOnce(new Error('PayOS down'));
    await expect(
      service.createOrder(
        { shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR, voucherCode: 'VIP200', items: [{ skuId: SKU_1, qty: 1 }] },
        'idem-pay-fail',
        actor,
      ),
    ).rejects.toThrow('PayOS down');
    expect(upstream.releaseReservationNonFatal).toHaveBeenCalled();
    expect(upstream.releasePromotionNonFatal).toHaveBeenCalled();
  });

  it('handles payment-succeeded, late payment refund, expiry sweep, shipping webhook & RMA partial/full refund', async () => {
    const { service, db, upstream, actor } = createOrderHarness({ loyaltyTier: 'GOLD' });
    const adminActor: OrderActorContext = { ...actor, actorRoles: ['SUPER_ADMIN'] };

    // Create online order with 2 units of SKU_2 + 1 unit of SKU_1 (combo 5% = 175k)
    const order = await service.createOrder(
      {
        shippingAddress: SAMPLE_ADDRESS,
        shippingMethod: ShippingMethod.GHN,
        paymentMethod: PaymentMethod.VIETQR,
        items: [
          { skuId: SKU_1, qty: 1 }, // 1,500,000
          { skuId: SKU_2, qty: 2 }, // 2,000,000
        ],
      },
      'idem-full-flow',
      actor,
    );

    // Confirm payment -> CONFIRMED + dedup check
    const paid = await service.handlePaymentSucceededEvent(
      { eventId: 'evt-pay-1', orderId: order.id, amountVnd: order.grandTotalVnd },
      'corr-pay-1',
    );
    expect(paid.status).toBe(OrderStatus.CONFIRMED);

    const paidDup = await service.handlePaymentSucceededEvent(
      { eventId: 'evt-pay-1', orderId: order.id },
      'corr-pay-1',
    );
    expect(paidDup.deduplicated).toBe(true);

    // Ownership isolation check
    await expect(
      service.getOrderByCode(order.orderCode, { ...actor, userId: OTHER_USER_ID }),
    ).rejects.toMatchObject({ code: ErrorCode.FORBIDDEN });
    expect((await service.listMyOrders(USER_ID)).length).toBe(1);

    // Shipping quote + Pack + Ship + Webhook delivered + Complete
    const quote = await service.quoteShipping({ provinceCode: '01', districtCode: '001', orderValueVnd: 1_500_000 });
    expect(quote.quotes).toHaveLength(4);
    expect(quote.freeShippingEligible).toBe(false);

    const packed = await service.packOrder(order.orderCode, { packPhotoUrl: 'https://cdn.test/pack.jpg' }, 'corr-pack');
    expect(packed.status).toBe(OrderStatus.PACKING);

    const shipped = await service.shipOrder(order.orderCode, 'corr-ship');
    expect(shipped.status).toBe(OrderStatus.SHIPPED);
    const trackingCode = shipped.shipment!.trackingCode;

    // Tampered shipping webhook rejected with 401
    const whPayload = { OrderCode: trackingCode, ClientOrderCode: order.orderCode, Status: 'delivered', eventId: 'ghn-evt-1' };
    const whRaw = JSON.stringify(whPayload);
    await expect(
      service.handleShippingWebhook('ghn', whPayload, whRaw, { 'x-ghn-signature': 'bad-sig' }, 'corr-wh'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    // Valid HMAC shipping webhook marks order DELIVERED
    const validSig = crypto.createHmac('sha256', 'ghn-sec').update(whRaw, 'utf8').digest('hex');
    const whResult = await service.handleShippingWebhook('ghn', whPayload, whRaw, { 'x-ghn-signature': validSig }, 'corr-wh');
    expect(whResult.orderUpdated).toBe(true);
    expect(whResult.mappedOrderStatus).toBe(OrderStatus.DELIVERED);

    // Check delivered purchase eligibility
    expect(await service.checkDeliveredPurchase(USER_ID, PROD_2)).toMatchObject({ eligible: true, orderId: order.id });

    // RMA PARTIAL REFUND (qty 1 of 2 on SKU_2) -> respects pro-rated netRefundableUnitVnd!
    const sku2Item = order.items.find((i) => i.skuId === SKU_2)!;
    const rmaRefund = await service.createRmaRequest(
      order.orderCode,
      {
        orderItemId: sku2Item.id,
        qty: 1,
        type: RmaType.RETURN_REFUND,
        reasonCode: RmaReasonCode.SAI_KICH_CO_CHAT,
        customerNote: 'Mặc hơi chật vai',
      },
      actor,
    );
    expect(rmaRefund.refundAmountVnd).toBe(sku2Item.netRefundableUnitVnd);

    await service.approveRma(rmaRefund.id, {}, 'corr-rma-app');
    const qcPassed = await service.completeRmaQc(
      rmaRefund.id,
      { tagsIntact: true, unwashed: true, noStainsOrOdor: true, passed: true },
      'corr-rma-qc',
    );
    expect(qcPassed.status).toBe(RmaStatus.RMA_COMPLETED);
    expect(qcPassed.refundAmountVnd).toBe(sku2Item.netRefundableUnitVnd);
    expect(upstream.createRefund).toHaveBeenCalledWith(
      expect.objectContaining({ amountVnd: sku2Item.netRefundableUnitVnd }),
      'corr-rma-qc',
    );

    // RMA SIZE_EXCHANGE INSTANT_2WAY + rejectRma + stats + metrics
    const sku1Item = order.items.find((i) => i.skuId === SKU_1)!;
    const rmaExchange = await service.createRmaRequest(
      order.orderCode,
      {
        orderItemId: sku1Item.id,
        qty: 1,
        type: RmaType.SIZE_EXCHANGE,
        exchangeMode: RmaExchangeMode.INSTANT_2WAY,
        reasonCode: RmaReasonCode.SAI_KICH_CO_RONG,
        targetSkuId: SKU_EXCHANGE_L,
        customerNote: 'Đổi sang size L',
      },
      actor,
    );
    const approvedExch = await service.approveRma(rmaExchange.id, {}, 'corr-exch-app');
    expect(approvedExch.status).toBe(RmaStatus.INSTANT_2WAY_DISPATCHED);
    const rejectedExch = await service.rejectRma(rmaExchange.id, { reason: 'Hết hàng kiểm định' }, adminActor);
    expect(rejectedExch.after.status).toBe(RmaStatus.RMA_REJECTED);

    const completed = await service.completeOrder(order.orderCode, { note: 'Xác nhận hoàn tất' }, adminActor);
    expect(completed.after.status).toBe(OrderStatus.COMPLETED);

    // Expiry sweep & Late-Payment auto-refund flow on a second order
    const expOrder = await service.createOrder(
      { shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR, items: [{ skuId: SKU_1, qty: 1 }] },
      'idem-exp-flow',
      actor,
    );
    await service.testExpireOrder({ orderId: expOrder.id });
    const sweepRes = await service.runExpirySweep('corr-sweep');
    expect(sweepRes.expiredCount).toBe(1);
    expect(db.state.orders.find((o) => o.id === expOrder.id)?.status).toBe(OrderStatus.CANCELLED);

    // Late payment arrives AFTER cancellation -> LATE_PAYMENT_NEEDS_REFUND (no commitReservation!)
    vi.mocked(upstream.commitReservation).mockClear();
    const lateRes = await service.handlePaymentSucceededEvent(
      { eventId: 'evt-late-1', orderId: expOrder.id, amountVnd: expOrder.grandTotalVnd },
      'corr-late',
    );
    expect(lateRes.status).toBe(OrderStatus.LATE_PAYMENT_NEEDS_REFUND);
    expect(upstream.commitReservation).not.toHaveBeenCalled();

    const lateRefund = await service.refundLatePayment(expOrder.orderCode, 'corr-late-ref');
    expect(lateRefund.order.status).toBe(OrderStatus.CANCELLED);
    expect(lateRefund.order.latePaymentRefunded).toBe(true);

    // Customer cancel + Admin cancel + Ops metrics & RMA stats
    const cOrder = await service.createOrder(
      { shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR, items: [{ skuId: SKU_2, qty: 1 }] },
      'idem-cust-cancel',
      actor,
    );
    const custCancelled = await service.cancelOrderByCustomer(cOrder.orderCode, { reason: 'Đổi ý' }, actor);
    expect(custCancelled.status).toBe(OrderStatus.CANCELLED);

    const aOrder = await service.createOrder(
      { shippingAddress: SAMPLE_ADDRESS, shippingMethod: ShippingMethod.GHN, paymentMethod: PaymentMethod.VIETQR, items: [{ skuId: SKU_2, qty: 1 }] },
      'idem-admin-cancel',
      actor,
    );
    const adminCancelled = await service.cancelOrderByAdmin(aOrder.orderCode, { reason: 'Hủy vận hành' }, adminActor);
    expect(adminCancelled.after.status).toBe(OrderStatus.CANCELLED);

    expect((await service.listAdminOrders({})).length).toBeGreaterThanOrEqual(4);
    expect((await service.listAdminRmas({})).length).toBeGreaterThanOrEqual(2);
    expect((await service.listOrderRmas(order.orderCode, actor)).length).toBe(2);
    expect((await service.getOrderOpsMetrics()).totalOrders).toBeGreaterThanOrEqual(4);
    expect((await service.getRmaStats({ periodDays: 30 })).totalRmaCount).toBe(2);

    service.onModuleInit();
    service.onModuleDestroy();
  });
});
