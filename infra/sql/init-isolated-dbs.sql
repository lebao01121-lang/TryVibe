-- =============================================================================
-- Fashion Atelier AI Platform (v3.0) - Phase 0 Database-per-Service Init Script
-- Engine: PostgreSQL 16 (pgvector/pgvector:pg16)
-- Idempotent script mounted at /docker-entrypoint-initdb.d/01-init-isolated-dbs.sql
--
-- Creates 10 isolated logical databases and 10 least-privilege service roles.
-- Cross-database connections (e.g., svc_order -> auth_db) are strictly denied
-- by PostgreSQL via REVOKE ALL ON DATABASE <db> FROM PUBLIC.
-- =============================================================================

\set ON_ERROR_STOP on

-- -----------------------------------------------------------------------------
-- 1. Create / update 10 isolated least-privilege service roles (idempotent)
-- -----------------------------------------------------------------------------
DO $$
DECLARE
  role_spec RECORD;
BEGIN
  FOR role_spec IN
    SELECT * FROM (VALUES
      ('svc_auth',      'Atelier_Auth2026!'),
      ('svc_catalog',   'Atelier_Cat2026!'),
      ('svc_media',     'Atelier_Media2026!'),
      ('svc_inventory', 'Atelier_Inv2026!'),
      ('svc_cart',      'Atelier_Cart2026!'),
      ('svc_order',     'Atelier_Order2026!'),
      ('svc_payment',   'Atelier_Pay2026!'),
      ('svc_notify',    'Atelier_Notify2026!'),
      ('svc_tryon',     'Atelier_TryOn2026!'),
      ('svc_rag',       'Atelier_Rag2026!')
    ) AS t(role_name, role_password)
  LOOP
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_spec.role_name) THEN
      EXECUTE format(
        'CREATE ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
        role_spec.role_name,
        role_spec.role_password
      );
    ELSE
      EXECUTE format(
        'ALTER ROLE %I WITH LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT',
        role_spec.role_name,
        role_spec.role_password
      );
    END IF;
  END LOOP;
END
$$;

-- -----------------------------------------------------------------------------
-- 2. Create 10 logical databases idempotently via psql \gexec
--    (CREATE DATABASE cannot execute inside a DO $$ transaction block)
-- -----------------------------------------------------------------------------
SELECT 'CREATE DATABASE auth_db OWNER svc_auth ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'auth_db')\gexec

SELECT 'CREATE DATABASE catalog_db OWNER svc_catalog ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'catalog_db')\gexec

SELECT 'CREATE DATABASE media_db OWNER svc_media ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'media_db')\gexec

SELECT 'CREATE DATABASE inventory_db OWNER svc_inventory ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'inventory_db')\gexec

SELECT 'CREATE DATABASE cart_db OWNER svc_cart ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'cart_db')\gexec

SELECT 'CREATE DATABASE order_db OWNER svc_order ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'order_db')\gexec

SELECT 'CREATE DATABASE payment_db OWNER svc_payment ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'payment_db')\gexec

SELECT 'CREATE DATABASE notify_db OWNER svc_notify ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'notify_db')\gexec

SELECT 'CREATE DATABASE tryon_db OWNER svc_tryon ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'tryon_db')\gexec

SELECT 'CREATE DATABASE rag_vector_db OWNER svc_rag ENCODING ''UTF8'''
WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'rag_vector_db')\gexec

-- -----------------------------------------------------------------------------
-- 3. Enforce strict Database-level isolation (deny PUBLIC, grant only owner)
-- -----------------------------------------------------------------------------
ALTER DATABASE auth_db OWNER TO svc_auth;
REVOKE ALL ON DATABASE auth_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE auth_db TO svc_auth;

ALTER DATABASE catalog_db OWNER TO svc_catalog;
REVOKE ALL ON DATABASE catalog_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE catalog_db TO svc_catalog;

ALTER DATABASE media_db OWNER TO svc_media;
REVOKE ALL ON DATABASE media_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE media_db TO svc_media;

ALTER DATABASE inventory_db OWNER TO svc_inventory;
REVOKE ALL ON DATABASE inventory_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE inventory_db TO svc_inventory;

ALTER DATABASE cart_db OWNER TO svc_cart;
REVOKE ALL ON DATABASE cart_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE cart_db TO svc_cart;

ALTER DATABASE order_db OWNER TO svc_order;
REVOKE ALL ON DATABASE order_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE order_db TO svc_order;

ALTER DATABASE payment_db OWNER TO svc_payment;
REVOKE ALL ON DATABASE payment_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE payment_db TO svc_payment;

ALTER DATABASE notify_db OWNER TO svc_notify;
REVOKE ALL ON DATABASE notify_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE notify_db TO svc_notify;

ALTER DATABASE tryon_db OWNER TO svc_tryon;
REVOKE ALL ON DATABASE tryon_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE tryon_db TO svc_tryon;

ALTER DATABASE rag_vector_db OWNER TO svc_rag;
REVOKE ALL ON DATABASE rag_vector_db FROM PUBLIC;
GRANT CONNECT, TEMP ON DATABASE rag_vector_db TO svc_rag;

-- -----------------------------------------------------------------------------
-- 4. Lock down public schema per database and install pgvector where required
-- -----------------------------------------------------------------------------

-- 4.1 auth_db
\connect auth_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_auth;
GRANT ALL ON SCHEMA public TO svc_auth;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_auth IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.2 catalog_db (+ pgvector)
\connect catalog_db
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_catalog;
GRANT ALL ON SCHEMA public TO svc_catalog;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_catalog IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.3 media_db
\connect media_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_media;
GRANT ALL ON SCHEMA public TO svc_media;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_media IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.4 inventory_db
\connect inventory_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_inventory;
GRANT ALL ON SCHEMA public TO svc_inventory;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_inventory IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.5 cart_db
\connect cart_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_cart;
GRANT ALL ON SCHEMA public TO svc_cart;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_cart IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.6 order_db
\connect order_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_order;
GRANT ALL ON SCHEMA public TO svc_order;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_order IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.7 payment_db
\connect payment_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_payment;
GRANT ALL ON SCHEMA public TO svc_payment;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_payment IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.8 notify_db
\connect notify_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_notify;
GRANT ALL ON SCHEMA public TO svc_notify;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_notify IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.9 tryon_db
\connect tryon_db
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_tryon;
GRANT ALL ON SCHEMA public TO svc_tryon;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_tryon IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

-- 4.10 rag_vector_db (+ pgvector + HNSW & Versioning Schema)
\connect rag_vector_db
CREATE EXTENSION IF NOT EXISTS vector;
REVOKE ALL ON SCHEMA public FROM PUBLIC;
ALTER SCHEMA public OWNER TO svc_rag;
GRANT ALL ON SCHEMA public TO svc_rag;
ALTER DEFAULT PRIVILEGES FOR ROLE svc_rag IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;

SET ROLE svc_rag;

CREATE TABLE IF NOT EXISTS rag_documents (
  id TEXT PRIMARY KEY,
  domain TEXT NOT NULL DEFAULT 'general',
  category TEXT NOT NULL DEFAULT 'general',
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  source_uri TEXT NOT NULL DEFAULT '',
  metadata_jsonb JSONB NOT NULL DEFAULT '{}'::jsonb,
  embedding vector(768) NOT NULL,
  version INTEGER NOT NULL DEFAULT 1,
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  updated_by TEXT NOT NULL DEFAULT 'system',
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  parent_doc_id TEXT,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  embedding_status TEXT NOT NULL DEFAULT 'EMBEDDED',
  embedding_model TEXT NOT NULL DEFAULT 'nomic-embed-text'
);

ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_by TEXT DEFAULT 'system';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS parent_doc_id TEXT;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS chunk_index INTEGER DEFAULT 0;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_status TEXT DEFAULT 'EMBEDDED';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'nomic-embed-text';

CREATE INDEX IF NOT EXISTS idx_rag_documents_active_category
  ON rag_documents (is_active, category, domain);

CREATE INDEX IF NOT EXISTS idx_rag_documents_parent_chunk
  ON rag_documents (parent_doc_id, chunk_index);

CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding_hnsw
  ON rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX IF NOT EXISTS idx_rag_documents_fts_simple
  ON rag_documents
  USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));

RESET ROLE;

\connect postgres
