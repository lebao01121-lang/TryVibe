-- ============================================================================
-- @atelier/cart-outfit — Isolated PostgreSQL 16 Schema (cart_db ONLY)
-- Idempotent migration executed automatically on service boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS carts (
  id UUID PRIMARY KEY,
  owner_key VARCHAR(128) UNIQUE NOT NULL,
  user_id UUID,
  guest_session_id VARCHAR(128),
  packaging_option_id VARCHAR(64),
  gift_note VARCHAR(140) NOT NULL DEFAULT '',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS cart_items (
  id UUID PRIMARY KEY,
  cart_id UUID NOT NULL REFERENCES carts(id) ON DELETE CASCADE,
  sku_id UUID NOT NULL,
  product_id UUID NOT NULL,
  variant_id UUID NOT NULL,
  slot VARCHAR(24) NOT NULL DEFAULT 'TOP',
  qty INT NOT NULL CHECK (qty > 0),
  bundle_group_id VARCHAR(64),
  from_ai_tryon BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS saved_outfits (
  id UUID PRIMARY KEY,
  user_id UUID,
  guest_session_id VARCHAR(128),
  share_code VARCHAR(16) UNIQUE NOT NULL,
  title VARCHAR(160) NOT NULL,
  slots_jsonb JSONB NOT NULL,
  packaging_option_id VARCHAR(64),
  gift_note VARCHAR(140) NOT NULL DEFAULT '',
  preview_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_carts_user_id
  ON carts (user_id);

CREATE INDEX IF NOT EXISTS idx_carts_guest_session_id
  ON carts (guest_session_id);

CREATE INDEX IF NOT EXISTS idx_cart_items_cart_id
  ON cart_items (cart_id, created_at ASC);

CREATE INDEX IF NOT EXISTS idx_saved_outfits_user_id
  ON saved_outfits (user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_saved_outfits_guest_session_id
  ON saved_outfits (guest_session_id, created_at DESC);
