-- ============================================================================
-- @atelier/media-pipeline — Isolated PostgreSQL 16 Schema (media_db ONLY)
-- Idempotent migration executed automatically on service boot.
-- ============================================================================

CREATE TABLE IF NOT EXISTS media_assets (
  id UUID PRIMARY KEY,
  asset_type VARCHAR(48) NOT NULL CHECK (
    asset_type IN (
      'RACK_CUTOUT_2_3',
      'STUDIO_LAYER_2_3',
      'PACKAGING_LAYER',
      'TRYON_FLAT_3_4',
      'LOOKBOOK_PHOTO',
      'HERO_VIDEO'
    )
  ),
  bucket_name VARCHAR(128) NOT NULL,
  original_key TEXT NOT NULL,
  variants_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  mime_type VARCHAR(128) NOT NULL,
  size_bytes BIGINT NOT NULL DEFAULT 0,
  width INT,
  height INT,
  has_alpha BOOLEAN NOT NULL DEFAULT FALSE,
  dominant_hex VARCHAR(16),
  uploaded_by UUID,
  supplier_id UUID,
  status VARCHAR(24) NOT NULL DEFAULT 'PENDING' CHECK (
    status IN ('PENDING', 'READY', 'REJECTED')
  ),
  rejection_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS asset_spatial_metadata (
  asset_id UUID PRIMARY KEY REFERENCES media_assets(id) ON DELETE CASCADE,
  hanger_anchor_x DOUBLE PRECISION NOT NULL DEFAULT 0.5,
  hanger_anchor_y DOUBLE PRECISION NOT NULL DEFAULT 0.14,
  bounding_box_jsonb JSONB DEFAULT '{"shoulderY":0.14,"waistY":0.44,"hipY":0.60,"hemY":0.90}'::jsonb,
  layer_z_hint INT DEFAULT 10,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE asset_spatial_metadata
  ALTER COLUMN hanger_anchor_y SET DEFAULT 0.14;

CREATE INDEX IF NOT EXISTS idx_media_assets_type_status
  ON media_assets (asset_type, status, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_supplier_id
  ON media_assets (supplier_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_media_assets_uploaded_by
  ON media_assets (uploaded_by);
