CREATE TABLE IF NOT EXISTS categories (
  id UUID PRIMARY KEY,
  parent_id UUID NULL REFERENCES categories(id) ON DELETE SET NULL,
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE IF NOT EXISTS size_charts (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  gender TEXT NOT NULL DEFAULT 'WOMEN',
  garment_group TEXT NOT NULL,
  fit_note TEXT NULL,
  measurements_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb
);

ALTER TABLE size_charts ADD COLUMN IF NOT EXISTS category_id UUID NULL REFERENCES categories(id) ON DELETE SET NULL;
ALTER TABLE size_charts ADD COLUMN IF NOT EXISTS stretch_level TEXT NOT NULL DEFAULT 'NONE';
ALTER TABLE size_charts ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS products (
  id UUID PRIMARY KEY,
  category_id UUID NOT NULL REFERENCES categories(id),
  slug TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  subtitle TEXT NULL,
  brand_name TEXT NOT NULL DEFAULT 'TryVibe Atelier',
  description TEXT NOT NULL,
  fabric_composition TEXT NOT NULL,
  fit_type TEXT NOT NULL DEFAULT 'REGULAR',
  stretch_level TEXT NOT NULL DEFAULT 'NONE',
  fabric_weight DOUBLE PRECISION NOT NULL DEFAULT 180,
  gender TEXT NOT NULL DEFAULT 'WOMEN',
  is_tryon_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  tryon_garment_category TEXT NOT NULL DEFAULT 'NONE',
  tryon_flat_asset_url TEXT NULL,
  fit_calibration_note TEXT NULL,
  min_price_vnd INTEGER NOT NULL DEFAULT 0,
  stock_status_summary TEXT NOT NULL DEFAULT 'IN_STOCK',
  status TEXT NOT NULL DEFAULT 'PUBLISHED',
  size_chart_id UUID NULL REFERENCES size_charts(id),
  occasion_slugs JSONB NOT NULL DEFAULT '[]'::jsonb,
  season_slugs JSONB NOT NULL DEFAULT '[]'::jsonb,
  fit_stats_jsonb JSONB NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE products ADD COLUMN IF NOT EXISTS fit_stats_jsonb JSONB;
ALTER TABLE products ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE INDEX IF NOT EXISTS idx_products_category_status ON products(category_id, status);
CREATE INDEX IF NOT EXISTS idx_products_min_price ON products(min_price_vnd);
CREATE INDEX IF NOT EXISTS idx_products_tryon ON products(is_tryon_enabled);

CREATE TABLE IF NOT EXISTS product_variants (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  color_name TEXT NOT NULL,
  color_hex TEXT NOT NULL,
  lookbook_main_url TEXT NULL,
  rack_front_asset_id TEXT NULL,
  rack_back_asset_id TEXT NULL,
  studio_layer_asset_id TEXT NULL,
  tryon_flat_preview_url TEXT NULL,
  rack_front_url TEXT NULL,
  rack_back_url TEXT NULL,
  studio_layer_url TEXT NULL,
  layer_spec_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_product_variants_product ON product_variants(product_id);

CREATE TABLE IF NOT EXISTS skus (
  id UUID PRIMARY KEY,
  variant_id UUID NOT NULL REFERENCES product_variants(id) ON DELETE CASCADE,
  sku_code TEXT NOT NULL UNIQUE,
  size_code TEXT NOT NULL,
  base_price_vnd INTEGER NOT NULL,
  sale_price_vnd INTEGER NULL,
  cost_price_vnd INTEGER NOT NULL DEFAULT 0,
  supplier_id UUID NULL,
  weight_grams INTEGER NOT NULL DEFAULT 300,
  in_stock BOOLEAN NOT NULL DEFAULT TRUE,
  is_returnable BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE INDEX IF NOT EXISTS idx_skus_variant ON skus(variant_id);
CREATE INDEX IF NOT EXISTS idx_skus_size_stock ON skus(size_code, in_stock);

ALTER TABLE skus ADD COLUMN IF NOT EXISTS barcode TEXT NULL;
ALTER TABLE skus ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;

CREATE TABLE IF NOT EXISTS occasion_lookbooks (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  palette_bg TEXT NOT NULL DEFAULT '#FBF7EF',
  palette_ink TEXT NOT NULL DEFAULT '#1C1410',
  palette_accent TEXT NOT NULL DEFAULT '#B08A4A',
  is_dark BOOLEAN NOT NULL DEFAULT FALSE,
  badge_tag TEXT NULL,
  hero_image_url TEXT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE occasion_lookbooks ADD COLUMN IF NOT EXISTS description TEXT NULL;
ALTER TABLE occasion_lookbooks ADD COLUMN IF NOT EXISTS cover_image_url TEXT NULL;
ALTER TABLE occasion_lookbooks ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE occasion_lookbooks ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS occasion_lookbook_items (
  id UUID PRIMARY KEY,
  occasion_id UUID NOT NULL REFERENCES occasion_lookbooks(id) ON DELETE CASCADE,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  slot_label TEXT NOT NULL DEFAULT 'FEATURED',
  sort_order INTEGER NOT NULL DEFAULT 0,
  UNIQUE(occasion_id, product_id)
);

CREATE TABLE IF NOT EXISTS seasonal_collections (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  months TEXT NOT NULL DEFAULT 'T1–T12',
  title TEXT NOT NULL,
  season_tag TEXT NOT NULL,
  subtitle TEXT NOT NULL,
  palette_hex TEXT NOT NULL DEFAULT '#B08A4A',
  hero_image_url TEXT NULL,
  is_current BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS code TEXT NULL;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS short_name TEXT NULL;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS material_headline TEXT NULL;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS swatches_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS palette_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS lookbook_meta_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS spu_ids_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS product_slugs_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE seasonal_collections ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS packaging_options (
  id UUID PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  description TEXT NOT NULL,
  swatch_hex TEXT NOT NULL DEFAULT '#EFE7DA',
  price_vnd INTEGER NOT NULL DEFAULT 0,
  image_url TEXT NULL,
  back_image_url TEXT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  sort_order INTEGER NOT NULL DEFAULT 0
);

ALTER TABLE packaging_options ADD COLUMN IF NOT EXISTS back_image_url TEXT NULL;

CREATE TABLE IF NOT EXISTS homepage_campaigns (
  id UUID PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  eyebrow TEXT NOT NULL DEFAULT 'TRYVIBE · FASHION ATELIER',
  hero_title TEXT NOT NULL,
  hero_subtitle TEXT NOT NULL,
  atelier_manifesto TEXT NOT NULL,
  cta_label TEXT NOT NULL DEFAULT 'Khám phá bộ sưu tập',
  service_note TEXT NOT NULL DEFAULT 'May đo theo số đo · Đổi size 7–14 ngày · Xóa ảnh AI sau 15 phút',
  privacy_guarantee_minutes INTEGER NOT NULL DEFAULT 15,
  hero_image_url TEXT NULL,
  intro_jsonb JSONB NULL,
  hero_jsonb JSONB NULL,
  atelier_steps_jsonb JSONB NULL,
  finale_jsonb JSONB NULL,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE homepage_campaigns ADD COLUMN IF NOT EXISTS intro_jsonb JSONB;
ALTER TABLE homepage_campaigns ADD COLUMN IF NOT EXISTS hero_jsonb JSONB;
ALTER TABLE homepage_campaigns ADD COLUMN IF NOT EXISTS atelier_steps_jsonb JSONB;
ALTER TABLE homepage_campaigns ADD COLUMN IF NOT EXISTS finale_jsonb JSONB;
ALTER TABLE homepage_campaigns ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE TABLE IF NOT EXISTS supplier_product_submissions (
  id UUID PRIMARY KEY,
  supplier_id UUID NOT NULL,
  proposed_name TEXT NOT NULL,
  category_slug TEXT NOT NULL,
  wholesale_price_vnd INTEGER NOT NULL,
  suggested_retail_vnd INTEGER NOT NULL,
  fabric_composition TEXT NOT NULL,
  available_sizes_jsonb JSONB NOT NULL DEFAULT '["S","M","L"]'::jsonb,
  color_name TEXT NOT NULL DEFAULT 'Trắng Ngà',
  color_hex TEXT NOT NULL DEFAULT '#EFE7DA',
  asset_ids_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  raw_size_spec_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  flat_asset_url TEXT NULL,
  rack_asset_url TEXT NULL,
  notes TEXT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING_REVIEW',
  reviewer_id UUID NULL,
  review_note TEXT NULL,
  reviewed_at TIMESTAMPTZ NULL,
  created_product_id UUID NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_supplier_submissions_supplier ON supplier_product_submissions(supplier_id, status);

CREATE TABLE IF NOT EXISTS lookbook_studio_sessions (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  virtual_model_code VARCHAR(64) NOT NULL,
  scene_prompt TEXT NOT NULL,
  source_garment_url TEXT NULL,
  result_url TEXT NOT NULL,
  object_key TEXT NOT NULL,
  provider_used VARCHAR(32) NOT NULL,
  status VARCHAR(24) NOT NULL DEFAULT 'GENERATED',
  attached_at TIMESTAMPTZ NULL,
  created_by VARCHAR(64) NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_lookbook_studio_sessions_product
  ON lookbook_studio_sessions(product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS product_media (
  id UUID PRIMARY KEY,
  product_id UUID NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  variant_id UUID NULL REFERENCES product_variants(id) ON DELETE SET NULL,
  media_type VARCHAR(32) NOT NULL DEFAULT 'LOOKBOOK',
  url TEXT NOT NULL,
  object_key TEXT NULL,
  source_session_id UUID NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_product_media_product
  ON product_media(product_id, sort_order ASC, created_at DESC);
