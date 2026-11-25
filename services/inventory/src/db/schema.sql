-- ==============================================================================
-- Fashion Atelier AI Platform (v3.0) — Inventory Microservice Isolated Schema
-- Database: inventory_db (svc_inventory)
-- Idempotent migration script (PostgreSQL 16 / PGlite compatible)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS warehouses (
  id UUID PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  type VARCHAR(24) NOT NULL CHECK (type IN ('CENTRAL', 'SHOWROOM')),
  province_code VARCHAR(32) NOT NULL,
  city VARCHAR(120) NOT NULL DEFAULT '',
  address TEXT,
  supports_2h_delivery BOOLEAN NOT NULL DEFAULT FALSE,
  priority INTEGER NOT NULL DEFAULT 10,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE warehouses ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS stock_levels (
  sku_id UUID NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id) ON DELETE CASCADE,
  product_id UUID NOT NULL,
  sku_code VARCHAR(64),
  available_qty INTEGER NOT NULL CHECK (available_qty >= 0),
  reserved_qty INTEGER NOT NULL DEFAULT 0 CHECK (reserved_qty >= 0),
  committed_qty INTEGER NOT NULL DEFAULT 0 CHECK (committed_qty >= 0),
  damaged_qty INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0),
  safety_threshold INTEGER NOT NULL DEFAULT 3 CHECK (safety_threshold >= 0),
  version INTEGER NOT NULL DEFAULT 1,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (sku_id, warehouse_id)
);

ALTER TABLE stock_levels ADD COLUMN IF NOT EXISTS sku_code VARCHAR(64);
ALTER TABLE stock_levels ADD COLUMN IF NOT EXISTS damaged_qty INTEGER NOT NULL DEFAULT 0 CHECK (damaged_qty >= 0);

CREATE INDEX IF NOT EXISTS idx_stock_levels_sku
  ON stock_levels (sku_id);

CREATE INDEX IF NOT EXISTS idx_stock_levels_product
  ON stock_levels (product_id);

CREATE INDEX IF NOT EXISTS idx_stock_levels_warehouse
  ON stock_levels (warehouse_id);

CREATE TABLE IF NOT EXISTS stock_reservations (
  id UUID PRIMARY KEY,
  idempotency_key VARCHAR(128) NOT NULL UNIQUE,
  reservation_type VARCHAR(32) NOT NULL
    CHECK (reservation_type IN ('CHECKOUT', 'SIZE_EXCHANGE')),
  reference_id VARCHAR(128) NOT NULL,
  status VARCHAR(24) NOT NULL
    CHECK (status IN ('ACTIVE', 'COMMITTED', 'RELEASED', 'EXPIRED')),
  expires_at TIMESTAMPTZ NOT NULL,
  committed_at TIMESTAMPTZ,
  released_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS committed_at TIMESTAMPTZ;
ALTER TABLE stock_reservations ADD COLUMN IF NOT EXISTS released_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_stock_res_active_exp
  ON stock_reservations (status, expires_at)
  WHERE status = 'ACTIVE';

CREATE INDEX IF NOT EXISTS idx_stock_res_reference
  ON stock_reservations (reference_id);

CREATE TABLE IF NOT EXISTS stock_reservation_items (
  id UUID PRIMARY KEY,
  reservation_id UUID NOT NULL REFERENCES stock_reservations(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL,
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  qty INTEGER NOT NULL CHECK (qty > 0)
);

CREATE INDEX IF NOT EXISTS idx_stock_res_items_reservation
  ON stock_reservation_items (reservation_id);

CREATE INDEX IF NOT EXISTS idx_stock_res_items_sku
  ON stock_reservation_items (sku_id);

CREATE TABLE IF NOT EXISTS inventory_ledger (
  id UUID PRIMARY KEY,
  sku_id UUID NOT NULL,
  warehouse_id UUID NOT NULL,
  delta_available INTEGER NOT NULL DEFAULT 0,
  delta_reserved INTEGER NOT NULL DEFAULT 0,
  delta_committed INTEGER NOT NULL DEFAULT 0,
  delta_damaged INTEGER NOT NULL DEFAULT 0,
  balance_available_after INTEGER NOT NULL,
  before_qty INTEGER,
  after_qty INTEGER,
  reason VARCHAR(32) NOT NULL
    CHECK (
      reason IN (
        'INITIAL_SEED',
        'RESERVE',
        'COMMIT',
        'RELEASE_EXPIRED',
        'CANCEL_RELEASE',
        'GRN_INBOUND',
        'RMA_RESTOCK',
        'ADJUSTMENT',
        'TRANSFER_OUT',
        'TRANSFER_IN'
      )
    ),
  reason_code VARCHAR(64),
  reference_id VARCHAR(128),
  transfer_ref VARCHAR(128),
  actor_id VARCHAR(128),
  actor_email VARCHAR(255),
  note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS delta_committed INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS delta_damaged INTEGER NOT NULL DEFAULT 0;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS before_qty INTEGER;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS after_qty INTEGER;
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS reason_code VARCHAR(64);
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS transfer_ref VARCHAR(128);
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS actor_id VARCHAR(128);
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS actor_email VARCHAR(255);
ALTER TABLE inventory_ledger ADD COLUMN IF NOT EXISTS note TEXT;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'inventory_ledger'::regclass
      AND contype = 'c'
      AND (conname = 'inventory_ledger_reason_check' OR pg_get_constraintdef(oid) ILIKE '%INITIAL_SEED%')
  LOOP
    EXECUTE format('ALTER TABLE inventory_ledger DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
  ALTER TABLE inventory_ledger
    ADD CONSTRAINT inventory_ledger_reason_check CHECK (
      reason IN (
        'INITIAL_SEED',
        'RESERVE',
        'COMMIT',
        'RELEASE_EXPIRED',
        'CANCEL_RELEASE',
        'GRN_INBOUND',
        'RMA_RESTOCK',
        'ADJUSTMENT',
        'TRANSFER_OUT',
        'TRANSFER_IN'
      )
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_created
  ON inventory_ledger (created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_sku
  ON inventory_ledger (sku_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_warehouse
  ON inventory_ledger (warehouse_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_reason
  ON inventory_ledger (reason, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_inventory_ledger_transfer_ref
  ON inventory_ledger (transfer_ref);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_name VARCHAR(120) NOT NULL,
  payload_jsonb JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_outbox_events_unpublished
  ON outbox_events (published, created_at ASC)
  WHERE published = FALSE;

CREATE TABLE IF NOT EXISTS processed_events (
  event_id VARCHAR(128) PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ==============================================================================
-- Phase 5: B2B Procurement (Suppliers -> PO -> Partial/Defect GRN -> Payables)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS suppliers (
  id UUID PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(160) NOT NULL,
  contact_name VARCHAR(160),
  contact_email VARCHAR(255) NOT NULL,
  contact_phone VARCHAR(64),
  address TEXT,
  lead_time_days INTEGER NOT NULL DEFAULT 7 CHECK (lead_time_days > 0),
  payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0),
  defect_rate_pct NUMERIC(5,2) NOT NULL DEFAULT 0 CHECK (defect_rate_pct >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'SUSPENDED')),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_name VARCHAR(160);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS contact_phone VARCHAR(64);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS address TEXT;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS payment_terms_days INTEGER NOT NULL DEFAULT 30 CHECK (payment_terms_days >= 0);
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE suppliers ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS purchase_orders (
  id UUID PRIMARY KEY,
  po_number VARCHAR(32) NOT NULL UNIQUE,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  status VARCHAR(32) NOT NULL
    CHECK (
      status IN (
        'NHAP_AI',
        'CHO_NCC_XAC_NHAN',
        'NCC_DA_XAC_NHAN',
        'HOAN_TAT_MOT_PHAN',
        'HOAN_TAT',
        'DA_HUY',
        'CANCELLED',
        'SUPPLIER_REJECTED'
      )
    ),
  created_source VARCHAR(24) NOT NULL DEFAULT 'USER'
    CHECK (created_source IN ('USER', 'AI_COPILOT')),
  expected_delivery_date VARCHAR(32) NOT NULL,
  confirmed_delivery_date VARCHAR(32),
  supplier_note TEXT,
  total_amount_vnd BIGINT NOT NULL DEFAULT 0,
  notes TEXT,
  rationale TEXT,
  created_by VARCHAR(64),
  approved_by VARCHAR(64),
  approved_at TIMESTAMPTZ,
  confirmed_by VARCHAR(64),
  confirmed_at TIMESTAMPTZ,
  cancel_reason TEXT,
  cancelled_by VARCHAR(64),
  cancelled_at TIMESTAMPTZ,
  supplier_rejection_reason TEXT,
  proposed_delivery_date VARCHAR(32),
  rejected_by VARCHAR(64),
  rejected_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancel_reason TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled_by VARCHAR(64);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS supplier_rejection_reason TEXT;
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS proposed_delivery_date VARCHAR(32);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rejected_by VARCHAR(64);
ALTER TABLE purchase_orders ADD COLUMN IF NOT EXISTS rejected_at TIMESTAMPTZ;

DO $$
DECLARE
  c RECORD;
BEGIN
  FOR c IN
    SELECT conname
    FROM pg_constraint
    WHERE conrelid = 'purchase_orders'::regclass
      AND contype = 'c'
      AND (conname = 'purchase_orders_status_check' OR pg_get_constraintdef(oid) ILIKE '%NHAP_AI%')
  LOOP
    EXECUTE format('ALTER TABLE purchase_orders DROP CONSTRAINT IF EXISTS %I', c.conname);
  END LOOP;
  ALTER TABLE purchase_orders
    ADD CONSTRAINT purchase_orders_status_check CHECK (
      status IN (
        'NHAP_AI',
        'CHO_NCC_XAC_NHAN',
        'NCC_DA_XAC_NHAN',
        'HOAN_TAT_MOT_PHAN',
        'HOAN_TAT',
        'DA_HUY',
        'CANCELLED',
        'SUPPLIER_REJECTED'
      )
    );
END $$;

CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier_status
  ON purchase_orders (supplier_id, status, created_at DESC);

CREATE TABLE IF NOT EXISTS purchase_order_items (
  id UUID PRIMARY KEY,
  po_id UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL,
  sku_code VARCHAR(64) NOT NULL,
  product_id UUID NOT NULL,
  product_name VARCHAR(255),
  ordered_qty INTEGER NOT NULL CHECK (ordered_qty > 0),
  received_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_qty >= 0),
  received_accepted_qty INTEGER NOT NULL DEFAULT 0 CHECK (received_accepted_qty >= 0),
  rejected_defect_qty INTEGER NOT NULL DEFAULT 0 CHECK (rejected_defect_qty >= 0),
  unit_cost_vnd BIGINT NOT NULL DEFAULT 0 CHECK (unit_cost_vnd >= 0)
);

CREATE INDEX IF NOT EXISTS idx_po_items_po
  ON purchase_order_items (po_id);

CREATE TABLE IF NOT EXISTS goods_receipts (
  id UUID PRIMARY KEY,
  grn_number VARCHAR(32) NOT NULL UNIQUE,
  po_id UUID NOT NULL REFERENCES purchase_orders(id),
  warehouse_id UUID NOT NULL REFERENCES warehouses(id),
  inspected_by VARCHAR(64),
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_goods_receipts_po
  ON goods_receipts (po_id, created_at DESC);

CREATE TABLE IF NOT EXISTS goods_receipt_items (
  id UUID PRIMARY KEY,
  grn_id UUID NOT NULL REFERENCES goods_receipts(id) ON DELETE CASCADE,
  po_item_id UUID NOT NULL REFERENCES purchase_order_items(id),
  sku_id UUID NOT NULL,
  received_qty INTEGER NOT NULL CHECK (received_qty > 0),
  accepted_qty INTEGER NOT NULL CHECK (accepted_qty >= 0),
  rejected_defect_qty INTEGER NOT NULL CHECK (rejected_defect_qty >= 0),
  batch_code VARCHAR(64) NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_grn_items_grn
  ON goods_receipt_items (grn_id);

CREATE TABLE IF NOT EXISTS supplier_payables (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL REFERENCES suppliers(id),
  grn_id UUID NOT NULL REFERENCES goods_receipts(id),
  po_id UUID NOT NULL REFERENCES purchase_orders(id),
  amount_payable_vnd BIGINT NOT NULL DEFAULT 0 CHECK (amount_payable_vnd >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'UNPAID'
    CHECK (status IN ('UNPAID', 'PAID')),
  due_date VARCHAR(32) NOT NULL,
  bank_reference VARCHAR(160),
  paid_at TIMESTAMPTZ,
  paid_by VARCHAR(128),
  settlement_note TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS bank_reference VARCHAR(160);
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS paid_at TIMESTAMPTZ;
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS paid_by VARCHAR(128);
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS settlement_note TEXT;
ALTER TABLE supplier_payables ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_supplier_payables_supplier
  ON supplier_payables (supplier_id, status, created_at DESC);
