-- ============================================================================
-- @atelier/notify-review — Isolated notify_db PostgreSQL 16 Schema (Idempotent)
-- Database owner: svc_notify (Database-per-Service strict isolation)
-- ============================================================================

CREATE TABLE IF NOT EXISTS product_reviews (
  id UUID PRIMARY KEY,
  order_id UUID NULL,
  order_item_id UUID UNIQUE NULL,
  product_id UUID NOT NULL,
  sku_id UUID NOT NULL,
  user_id UUID NOT NULL,
  reviewer_name VARCHAR(120) NOT NULL,
  rating INT NOT NULL CHECK (rating BETWEEN 1 AND 5),
  fit_feedback VARCHAR(24) NOT NULL CHECK (fit_feedback IN ('RUNS_SMALL', 'TRUE_TO_SIZE', 'RUNS_LARGE')),
  reviewer_height_cm INT NOT NULL,
  reviewer_weight_kg INT NOT NULL,
  size_purchased VARCHAR(16) NOT NULL,
  comment TEXT NOT NULL,
  photo_urls_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  sentiment_score DOUBLE PRECISION NOT NULL DEFAULT 0.75,
  sentiment_label VARCHAR(16) NOT NULL DEFAULT 'POSITIVE',
  moderation_status VARCHAR(24) NOT NULL DEFAULT 'APPROVED' CHECK (moderation_status IN ('APPROVED', 'PENDING', 'REJECTED')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Idempotent v3.1 Ollama NLP sentiment columns for pre-existing notify_db tables
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS sentiment_score NUMERIC(4,3) DEFAULT 0.75;
ALTER TABLE product_reviews ADD COLUMN IF NOT EXISTS sentiment_label VARCHAR(16) DEFAULT 'POSITIVE';

CREATE INDEX IF NOT EXISTS idx_product_reviews_prod_mod_fit
  ON product_reviews (product_id, moderation_status, fit_feedback);

CREATE INDEX IF NOT EXISTS idx_product_reviews_prod_created
  ON product_reviews (product_id, created_at DESC);

CREATE TABLE IF NOT EXISTS notification_logs (
  id UUID PRIMARY KEY,
  event_id VARCHAR(128) NOT NULL,
  channel VARCHAR(24) NOT NULL CHECK (channel IN ('EMAIL', 'ZALO_ZNS', 'SMS')),
  recipient VARCHAR(255) NOT NULL,
  template_code VARCHAR(64) NOT NULL,
  subject VARCHAR(255) NULL,
  payload_jsonb JSONB NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'SENT',
  retry_count INT NOT NULL DEFAULT 0,
  sent_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT uq_notify_event_channel UNIQUE (event_id, channel)
);

-- Idempotent Phase 5 column upgrades for pre-existing Phase 3/4 notify_db tables
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS subject VARCHAR(255) NULL;
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS payload_jsonb JSONB NULL;
ALTER TABLE notification_logs ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();

CREATE INDEX IF NOT EXISTS idx_notification_logs_sent_at
  ON notification_logs (sent_at DESC);

CREATE INDEX IF NOT EXISTS idx_notification_logs_created_at
  ON notification_logs (created_at DESC);
