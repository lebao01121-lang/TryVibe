-- ============================================================================
-- @atelier/order-rma — Isolated order_db PostgreSQL 16 Schema (Idempotent DDL)
-- ============================================================================

CREATE TABLE IF NOT EXISTS orders (
  id UUID PRIMARY KEY,
  order_code VARCHAR(32) NOT NULL UNIQUE,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  user_id UUID NULL,
  guest_session_id VARCHAR(128) NULL,
  customer_email VARCHAR(255) NULL,
  customer_phone VARCHAR(32) NULL,
  status VARCHAR(40) NOT NULL,
  subtotal_vnd BIGINT NOT NULL DEFAULT 0,
  combo_discount_vnd BIGINT NOT NULL DEFAULT 0,
  voucher_discount_vnd BIGINT NOT NULL DEFAULT 0,
  voucher_code VARCHAR(64) NULL,
  packaging_fee_vnd BIGINT NOT NULL DEFAULT 0,
  shipping_fee_vnd BIGINT NOT NULL DEFAULT 0,
  deposit_required_vnd BIGINT NOT NULL DEFAULT 0,
  grand_total_vnd BIGINT NOT NULL DEFAULT 0,
  payment_method VARCHAR(24) NOT NULL,
  shipping_method VARCHAR(24) NOT NULL,
  delivery_date VARCHAR(32) NULL,
  delivery_slot VARCHAR(64) NULL,
  shipping_address_jsonb JSONB NOT NULL,
  packaging_option_jsonb JSONB NULL,
  gift_note VARCHAR(140) NULL,
  reservation_id VARCHAR(64) NULL,
  reservation_expires_at TIMESTAMPTZ NULL,
  late_payment_refunded BOOLEAN NOT NULL DEFAULT FALSE,
  paid_at TIMESTAMPTZ NULL,
  delivered_at TIMESTAMPTZ NULL,
  cancelled_at TIMESTAMPTZ NULL,
  cancel_reason TEXT NULL,
  payment_intent_jsonb JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE orders ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS payment_intent_jsonb JSONB NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS late_payment_refunded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS deposit_required_vnd BIGINT NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS order_items (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  variant_id UUID NOT NULL,
  sku_id UUID NOT NULL,
  sku_code VARCHAR(64) NOT NULL,
  product_name VARCHAR(255) NOT NULL,
  color_name VARCHAR(100) NOT NULL,
  size_code VARCHAR(16) NOT NULL,
  image_url TEXT NULL,
  unit_price_vnd BIGINT NOT NULL,
  allocated_discount_vnd BIGINT NOT NULL DEFAULT 0,
  net_refundable_unit_vnd BIGINT NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  bundle_group_id VARCHAR(64) NULL,
  is_returnable BOOLEAN NOT NULL DEFAULT TRUE,
  supplier_batch_code VARCHAR(64) NULL
);

CREATE TABLE IF NOT EXISTS shipments (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  warehouse_code VARCHAR(32) NOT NULL,
  carrier VARCHAR(24) NOT NULL,
  tracking_code VARCHAR(64) NOT NULL UNIQUE,
  status VARCHAR(32) NOT NULL,
  pack_photo_url TEXT NULL,
  cod_collect_vnd BIGINT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS rma_requests (
  id UUID PRIMARY KEY,
  rma_code VARCHAR(32) NOT NULL UNIQUE,
  order_id UUID NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id UUID NULL,
  rma_type VARCHAR(32) NOT NULL,
  exchange_mode VARCHAR(32) NOT NULL,
  status VARCHAR(40) NOT NULL,
  reason_code VARCHAR(32) NOT NULL,
  customer_note VARCHAR(300) NOT NULL DEFAULT '',
  evidence_photos_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  qc_checklist_jsonb JSONB NULL,
  replacement_sku_id UUID NULL,
  exchange_reservation_id VARCHAR(64) NULL,
  refund_amount_vnd BIGINT NOT NULL DEFAULT 0,
  refund_transaction_id VARCHAR(128) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE rma_requests ADD COLUMN IF NOT EXISTS refund_transaction_id VARCHAR(128) NULL;

CREATE TABLE IF NOT EXISTS rma_items (
  id UUID PRIMARY KEY,
  rma_id UUID NOT NULL REFERENCES rma_requests(id) ON DELETE CASCADE,
  order_item_id UUID NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL,
  product_id UUID NOT NULL,
  size_purchased VARCHAR(16) NOT NULL,
  qty INT NOT NULL CHECK (qty > 0),
  supplier_batch_code VARCHAR(64) NULL
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_name VARCHAR(128) NOT NULL,
  aggregate_type VARCHAR(64) NOT NULL,
  aggregate_id VARCHAR(128) NOT NULL,
  correlation_id VARCHAR(128) NOT NULL,
  payload_jsonb JSONB NOT NULL,
  published_at TIMESTAMPTZ NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id TEXT PRIMARY KEY,
  event_name VARCHAR(128) NOT NULL DEFAULT 'unknown',
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_orders_user_created
  ON orders(user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_orders_status_expires
  ON orders(status, reservation_expires_at);

CREATE INDEX IF NOT EXISTS idx_order_items_order_id
  ON order_items(order_id);

CREATE INDEX IF NOT EXISTS idx_order_items_product_id
  ON order_items(product_id);

CREATE INDEX IF NOT EXISTS idx_shipments_order_id
  ON shipments(order_id);

CREATE INDEX IF NOT EXISTS idx_rma_order_id
  ON rma_requests(order_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rma_reason_created
  ON rma_requests(reason_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_rma_items_rma_id
  ON rma_items(rma_id);

CREATE INDEX IF NOT EXISTS idx_rma_items_product_id
  ON rma_items(product_id);
