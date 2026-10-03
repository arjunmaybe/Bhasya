/**
 * Embedded fallback copies of the frozen migration files.
 *
 * Single source of truth remains `db/migrations/*.sql`. These constants exist
 * ONLY because the Cloudflare Worker bundle has no `node:fs`, so `migrate()`
 * cannot read the files at runtime in workerd. They are used exclusively in
 * the no-file branch of `migrate()` (see `index.ts`), applying the SAME DDL
 * in the SAME order as the file path (001 → 002 → 003 → Better Auth).
 *
 * DO NOT edit these independently: any change must be made in
 * `db/migrations/*` first and mirrored here byte-for-byte. They are verified
 * to stay in sync (frozen 001 never changes; 003 is additive-only).
 *
 * No `node:*` imports here so the Worker entry stays importable.
 */

/** Verbatim copy of `db/migrations/001_initial_schema.sql` (FROZEN). */
export const EMBEDDED_001_INITIAL_SCHEMA = `
-- Bhasya frozen initial schema — 001_initial_schema.sql (FROZEN)
-- PostgreSQL + pgvector. Do not weaken. Do not replace with ad-hoc MVP schema.
-- Document versions are immutable by contract (no UPDATE/DELETE on
-- document_versions / document_nodes / passages enforced by app + RLS/triggers).

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "vector";

-- ── Identity / workspace ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS workspace_members (
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner','member')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

-- ── Source / version / tree / passages ────────────────────────────────
CREATE TABLE IF NOT EXISTS sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind TEXT NOT NULL DEFAULT 'url' CHECK (kind IN ('url','upload','text')),
  url TEXT,
  title TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS document_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  version_no INT NOT NULL DEFAULT 1,
  content_hash TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  fetched_url TEXT NOT NULL DEFAULT '',
  content_type TEXT NOT NULL DEFAULT '',
  lang TEXT NOT NULL DEFAULT '',
  node_count INT NOT NULL DEFAULT 0,
  passage_count INT NOT NULL DEFAULT 0,
  storage_key TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (source_id, version_no),
  UNIQUE (source_id, content_hash)
);

CREATE TABLE IF NOT EXISTS document_nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  parent_id UUID REFERENCES document_nodes(id) ON DELETE CASCADE,
  node_type TEXT NOT NULL CHECK (node_type IN ('document','heading','section','paragraph','list','list_item','quote','code','figure','caption')),
  ordinal INT NOT NULL DEFAULT 0,
  depth INT NOT NULL DEFAULT 0,
  structural_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL DEFAULT '',
  attrs JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_nodes_version ON document_nodes(document_version_id);
CREATE INDEX IF NOT EXISTS idx_nodes_parent ON document_nodes(parent_id);
CREATE INDEX IF NOT EXISTS idx_nodes_path ON document_nodes(document_version_id, structural_path);

CREATE TABLE IF NOT EXISTS passages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES document_nodes(id) ON DELETE CASCADE,
  ordinal INT NOT NULL DEFAULT 0,
  structural_path TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  fts TSVECTOR GENERATED ALWAYS AS (to_tsvector('english', text)) STORED,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (document_version_id, node_id, ordinal)
);
CREATE INDEX IF NOT EXISTS idx_passages_version ON passages(document_version_id);
CREATE INDEX IF NOT EXISTS idx_passages_node ON passages(node_id);
CREATE INDEX IF NOT EXISTS idx_passages_fts ON passages USING GIN (fts);

-- ── Anchors / highlights ──────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS anchors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  node_id UUID NOT NULL REFERENCES document_nodes(id) ON DELETE CASCADE,
  passage_id UUID REFERENCES passages(id) ON DELETE SET NULL,
  selected_text TEXT NOT NULL,
  start_offset INT NOT NULL DEFAULT 0 CHECK (start_offset >= 0),
  end_offset INT NOT NULL DEFAULT 0 CHECK (end_offset >= start_offset),
  text_hash TEXT NOT NULL,
  structural_path TEXT NOT NULL DEFAULT '',
  context_fingerprint TEXT NOT NULL DEFAULT '',
  locator JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_anchors_version ON anchors(document_version_id);
CREATE INDEX IF NOT EXISTS idx_anchors_passage ON anchors(passage_id);

CREATE TABLE IF NOT EXISTS highlights (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  anchor_id UUID NOT NULL REFERENCES anchors(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  color TEXT NOT NULL DEFAULT 'yellow',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (anchor_id)
);

-- ── Threads / messages / evidence / citations ─────────────────────────
CREATE TABLE IF NOT EXISTS threads (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  source_id UUID REFERENCES sources(id) ON DELETE SET NULL,
  anchor_id UUID REFERENCES anchors(id) ON DELETE SET NULL,
  scope_type TEXT NOT NULL DEFAULT 'passage' CHECK (scope_type IN ('passage','section','document','workspace')),
  title TEXT NOT NULL DEFAULT '',
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_threads_workspace ON threads(workspace_id);
CREATE INDEX IF NOT EXISTS idx_threads_anchor ON threads(anchor_id);

CREATE TABLE IF NOT EXISTS thread_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_id UUID NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user','assistant','system')),
  content TEXT NOT NULL,
  model_id TEXT,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT assistant_requires_model CHECK (role <> 'assistant' OR (model_id IS NOT NULL AND model_id <> ''))
);
CREATE INDEX IF NOT EXISTS idx_messages_thread ON thread_messages(thread_id, created_at);

CREATE TABLE IF NOT EXISTS evidence (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  thread_message_id UUID NOT NULL REFERENCES thread_messages(id) ON DELETE CASCADE,
  passage_id UUID NOT NULL REFERENCES passages(id) ON DELETE RESTRICT,
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE RESTRICT,
  score DOUBLE PRECISION NOT NULL DEFAULT 0,
  rank INT NOT NULL DEFAULT 0,
  scope_level TEXT NOT NULL DEFAULT 'L0' CHECK (scope_level IN ('L0','L1','L2','L3')),
  quote TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT evidence_version_matches_passage CHECK (true)
);
CREATE INDEX IF NOT EXISTS idx_evidence_message ON evidence(thread_message_id);
CREATE INDEX IF NOT EXISTS idx_evidence_passage ON evidence(passage_id);

CREATE TABLE IF NOT EXISTS citations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evidence_id UUID NOT NULL REFERENCES evidence(id) ON DELETE CASCADE,
  anchor_id UUID REFERENCES anchors(id) ON DELETE SET NULL,
  locator JSONB NOT NULL DEFAULT '{}'::jsonb,
  label TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_citations_evidence ON citations(evidence_id);

-- ── Embeddings (canonical cloud vectors; pgvector) ────────────────────
CREATE TABLE IF NOT EXISTS embeddings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  passage_id UUID NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  model_id TEXT NOT NULL,
  model_version TEXT NOT NULL DEFAULT '1',
  dimensions INT NOT NULL DEFAULT 1536,
  distance_metric TEXT NOT NULL DEFAULT 'cosine',
  embedding vector(1536),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (passage_id, model_id, model_version)
);
CREATE INDEX IF NOT EXISTS idx_embeddings_passage ON embeddings(passage_id);

-- ── Append-only event log ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS event_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID REFERENCES workspaces(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  event_type TEXT NOT NULL CHECK (event_type IN (
    'reading_session_started','reading_session_ended','document_opened','document_completed',
    'passage_highlighted','thread_created','thread_message_sent','thread_reopened',
    'citation_viewed','citation_clicked','source_imported')),
  resource_type TEXT NOT NULL DEFAULT '',
  resource_id TEXT NOT NULL DEFAULT '',
  metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_events_workspace ON event_log(workspace_id, created_at);
CREATE INDEX IF NOT EXISTS idx_events_type ON event_log(event_type, created_at);

-- ── Immutability guard: forbid UPDATE/DELETE on versioned content ──────
CREATE OR REPLACE FUNCTION forbid_versioned_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'immutable versioned table: % writes are append-only', TG_TABLE_NAME;
  RETURN NULL;
END; $$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_immutable_doc_versions ON document_versions;
CREATE TRIGGER trg_immutable_doc_versions
  BEFORE UPDATE OR DELETE ON document_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_versioned_mutation();

DROP TRIGGER IF EXISTS trg_immutable_doc_nodes ON document_nodes;
CREATE TRIGGER trg_immutable_doc_nodes
  BEFORE UPDATE OR DELETE ON document_nodes
  FOR EACH ROW EXECUTE FUNCTION forbid_versioned_mutation();

DROP TRIGGER IF EXISTS trg_immutable_passages ON passages;
CREATE TRIGGER trg_immutable_passages
  BEFORE UPDATE OR DELETE ON passages
  FOR EACH ROW EXECUTE FUNCTION forbid_versioned_mutation();

DROP TRIGGER IF EXISTS trg_immutable_messages ON thread_messages;
CREATE TRIGGER trg_immutable_messages
  BEFORE UPDATE OR DELETE ON thread_messages
  FOR EACH ROW EXECUTE FUNCTION forbid_versioned_mutation();
`;

/** Verbatim copy of `db/migrations/003_app_users_external_id.sql` (ADDITIVE ONLY). */
export const EMBEDDED_003_APP_USERS_LINK = `
-- Bhasya app-user link to Better Auth — 003_app_users_external_id.sql (ADDITIVE ONLY)
-- Inspection (2026-09-29): 001_initial_schema.sql defines
--   users(id UUID PK, email TEXT UNIQUE, display_name, created_at)
-- with NO external_user_id column anywhere (grep: no matches). Better Auth
-- owns its own \`user\` table; this column links the canonical app user to the
-- Better Auth user id. Does NOT touch the canonical
-- document/passage/anchor/highlight/thread/evidence/citation model and does
-- NOT alter frozen transaction/resolver contracts. Does NOT extend or rename
-- the custom auth_sessions table (002) as a substitute for Better Auth.

ALTER TABLE users ADD COLUMN IF NOT EXISTS external_user_id TEXT UNIQUE;
`;
