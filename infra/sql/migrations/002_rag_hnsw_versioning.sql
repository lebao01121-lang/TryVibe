-- =============================================================================
-- Fashion Atelier AI Platform (v3.2) - Migration 002: RAG HNSW & Versioning
-- Target Database: rag_vector_db (PostgreSQL 16 + pgvector)
-- Idempotent & Zero-Downtime Safe: safe to re-run multiple times.
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS vector;

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

-- Safe idempotent column upgrades for legacy rag_documents tables
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS category TEXT DEFAULT 'general';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS version INTEGER DEFAULT 1;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS is_active BOOLEAN DEFAULT TRUE;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_by TEXT DEFAULT 'system';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT NOW();
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS parent_doc_id TEXT;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS chunk_index INTEGER DEFAULT 0;
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_status TEXT DEFAULT 'EMBEDDED';
ALTER TABLE rag_documents ADD COLUMN IF NOT EXISTS embedding_model TEXT DEFAULT 'nomic-embed-text';

-- Backfill logical grouping & defaults for existing rows
UPDATE rag_documents
SET
  category = COALESCE(NULLIF(category, ''), NULLIF(domain, ''), 'general'),
  version = COALESCE(version, 1),
  is_active = COALESCE(is_active, TRUE),
  updated_by = COALESCE(NULLIF(updated_by, ''), 'system'),
  updated_at = COALESCE(updated_at, NOW()),
  parent_doc_id = COALESCE(NULLIF(parent_doc_id, ''), id),
  chunk_index = COALESCE(chunk_index, 0),
  embedding_status = COALESCE(NULLIF(embedding_status, ''), 'EMBEDDED'),
  embedding_model = COALESCE(NULLIF(embedding_model, ''), 'nomic-embed-text')
WHERE
  parent_doc_id IS NULL
  OR category IS NULL
  OR version IS NULL
  OR is_active IS NULL
  OR updated_by IS NULL
  OR chunk_index IS NULL
  OR embedding_status IS NULL
  OR embedding_model IS NULL;

-- Supporting metadata & chunk-grouping indexes
CREATE INDEX IF NOT EXISTS idx_rag_documents_active_category
  ON rag_documents (is_active, category, domain);

CREATE INDEX IF NOT EXISTS idx_rag_documents_parent_chunk
  ON rag_documents (parent_doc_id, chunk_index);

-- HNSW Approximate Nearest Neighbor Vector Index (cosine distance, m=16, ef_construction=64)
CREATE INDEX IF NOT EXISTS idx_rag_documents_embedding_hnsw
  ON rag_documents
  USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Full-Text Search GIN Index (Hybrid RAG lexical signal)
CREATE INDEX IF NOT EXISTS idx_rag_documents_fts_simple
  ON rag_documents
  USING gin (to_tsvector('simple', coalesce(title, '') || ' ' || coalesce(content, '')));
