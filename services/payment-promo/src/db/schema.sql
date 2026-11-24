-- ============================================================================
-- @atelier/payment-promo — Isolated PostgreSQL 16 Schema (payment_db ONLY)
-- Idempotent migration executed automatically on service boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS payment_transactions (
  id UUID PRIMARY KEY,
  order_id UUID NOT NULL,
  order_code VARCHAR(32) NOT NULL,
  provider VARCHAR(24) NOT NULL,
  tx_type VARCHAR(16) NOT NULL CHECK (tx_type IN ('CHARGE', 'REFUND')),
  amount_vnd BIGINT NOT NULL CHECK (amount_vnd >= 0),
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'SUCCEEDED', 'FAILED', 'EXPIRED', 'LATE_SUCCEEDED', 'REFUNDED')
  ),
  provider_tx_id VARCHAR(128),
  idempotency_key VARCHAR(128) UNIQUE NOT NULL,
  qr_payload TEXT,
  payment_url TEXT,
  signature_verified BOOLEAN NOT NULL DEFAULT FALSE,
  raw_payload_jsonb JSONB,
  expires_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS processed_webhooks (
  provider VARCHAR(24) NOT NULL,
  provider_event_id VARCHAR(128) NOT NULL,
  order_code VARCHAR(32),
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (provider, provider_event_id)
);

CREATE TABLE IF NOT EXISTS promotions (
  id UUID PRIMARY KEY,
  code VARCHAR(64) UNIQUE NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  promo_type VARCHAR(32) NOT NULL CHECK (
    promo_type IN ('PERCENT', 'FIXED', 'FREESHIP', 'OUTFIT_COMBO', 'FLASH_SALE', 'CLEARANCE_ODD_SIZE')
  ),
  discount_value INT NOT NULL CHECK (discount_value >= 0),
  max_discount_vnd BIGINT NOT NULL DEFAULT 0,
  min_order_vnd BIGINT NOT NULL DEFAULT 0,
  target_sizes_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_product_ids_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  target_sku_codes_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  bonus_tryon_credits INT NOT NULL DEFAULT 0,
  usage_limit INT NOT NULL DEFAULT 1000,
  used_count INT NOT NULL DEFAULT 0,
  per_user_limit INT NOT NULL DEFAULT 1,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE' CHECK (
    status IN ('NHAP_AI', 'ACTIVE', 'PAUSED', 'EXPIRED')
  ),
  created_by_actor_type VARCHAR(24) NOT NULL DEFAULT 'SYSTEM',
  start_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  end_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '365 days'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS voucher_redemptions (
  id UUID PRIMARY KEY,
  promotion_id UUID NOT NULL REFERENCES promotions(id) ON DELETE CASCADE,
  user_id VARCHAR(64),
  order_id UUID NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'LOCKED' CHECK (
    status IN ('LOCKED', 'REDEEMED', 'RELEASED')
  ),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS outbox_events (
  id UUID PRIMARY KEY,
  event_name VARCHAR(128) NOT NULL,
  payload_jsonb JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS processed_events (
  event_id VARCHAR(128) PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payment_tx_order_code
  ON payment_transactions (order_code, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_payment_tx_order_id_type
  ON payment_transactions (order_id, tx_type);

CREATE INDEX IF NOT EXISTS idx_voucher_redemptions_order
  ON voucher_redemptions (order_id, status);

CREATE INDEX IF NOT EXISTS idx_promotions_status_code
  ON promotions (status, code);
