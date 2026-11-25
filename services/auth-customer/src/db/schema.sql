-- ==============================================================================
-- Fashion Atelier AI Platform (v3.0) — Auth & Customer Service Isolated Schema
-- Database: auth_db (svc_auth)
-- Idempotent migration script (PostgreSQL 16 / PGlite compatible)
-- ==============================================================================

CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  phone VARCHAR(32) UNIQUE,
  password_hash TEXT NOT NULL,
  full_name VARCHAR(160) NOT NULL,
  avatar_url TEXT,
  status VARCHAR(24) NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE', 'LOCKED', 'PENDING')),
  mfa_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  permission_version INTEGER NOT NULL DEFAULT 1,
  loyalty_tier VARCHAR(24) NOT NULL DEFAULT 'BRONZE'
    CHECK (loyalty_tier IN ('BRONZE', 'SILVER', 'GOLD', 'DIAMOND')),
  cod_trust_score INTEGER NOT NULL DEFAULT 100,
  supplier_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE users ADD COLUMN IF NOT EXISTS is_active BOOLEAN NOT NULL DEFAULT TRUE;
ALTER TABLE users ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ NULL;

CREATE TABLE IF NOT EXISTS roles (
  id UUID PRIMARY KEY,
  code VARCHAR(64) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS permissions (
  id UUID PRIMARY KEY,
  code VARCHAR(120) NOT NULL UNIQUE,
  domain VARCHAR(64) NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS role_permissions (
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  permission_id UUID NOT NULL REFERENCES permissions(id) ON DELETE CASCADE,
  PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE IF NOT EXISTS user_roles (
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role_id UUID NOT NULL REFERENCES roles(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, role_id)
);

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  refresh_token_hash VARCHAR(64) NOT NULL UNIQUE,
  token_family_id UUID NOT NULL,
  csrf_token VARCHAR(128),
  last_access_jti VARCHAR(128),
  device_info TEXT,
  ip_address VARCHAR(64),
  mfa_verified BOOLEAN NOT NULL DEFAULT FALSE,
  expires_at TIMESTAMPTZ NOT NULL,
  revoked BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS csrf_token VARCHAR(128);
ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS last_access_jti VARCHAR(128);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user_revoked_exp
  ON auth_sessions (user_id, revoked, expires_at);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_family
  ON auth_sessions (token_family_id);

CREATE TABLE IF NOT EXISTS two_factor_auth (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  method VARCHAR(24) NOT NULL CHECK (method IN ('TOTP', 'EMAIL_OTP')),
  totp_secret_encrypted TEXT,
  recovery_codes_jsonb JSONB NOT NULL DEFAULT '[]'::jsonb,
  verified_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS customer_addresses (
  id UUID PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  recipient_name VARCHAR(120) NOT NULL,
  phone VARCHAR(32) NOT NULL,
  province_code VARCHAR(32) NOT NULL,
  province_name VARCHAR(120) NOT NULL,
  district_code VARCHAR(32) NOT NULL,
  district_name VARCHAR(120) NOT NULL,
  ward_code VARCHAR(32) NOT NULL,
  ward_name VARCHAR(120) NOT NULL,
  street_line VARCHAR(255) NOT NULL,
  is_default BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_customer_addresses_user
  ON customer_addresses (user_id, is_default DESC, created_at DESC);

CREATE TABLE IF NOT EXISTS customer_body_profiles (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  height_cm DOUBLE PRECISION NOT NULL,
  weight_kg DOUBLE PRECISION NOT NULL,
  bust_cm DOUBLE PRECISION,
  waist_cm DOUBLE PRECISION,
  hip_cm DOUBLE PRECISION,
  shoulder_cm DOUBLE PRECISION,
  fit_preference VARCHAR(24) NOT NULL DEFAULT 'REGULAR'
    CHECK (fit_preference IN ('SLIM', 'REGULAR', 'RELAXED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS tryon_quotas (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_limit INTEGER NOT NULL DEFAULT 5,
  used_today INTEGER NOT NULL DEFAULT 0,
  reset_at TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '1 day')
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id UUID PRIMARY KEY,
  actor_id UUID,
  actor_email VARCHAR(255),
  actor_type VARCHAR(24) NOT NULL CHECK (actor_type IN ('USER', 'AI_COPILOT', 'SYSTEM')),
  action VARCHAR(120) NOT NULL,
  resource_type VARCHAR(120) NOT NULL,
  resource_id VARCHAR(128),
  before_jsonb JSONB,
  after_jsonb JSONB,
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  correlation_id VARCHAR(128),
  ip_address VARCHAR(64),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_type VARCHAR(32) NOT NULL DEFAULT 'USER';
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS actor_email VARCHAR(255);
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb;

CREATE INDEX IF NOT EXISTS idx_audit_logs_created_actor_action
  ON audit_logs (created_at DESC, actor_type, action);
