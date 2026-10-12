-- Bhasya reading-session PDF exports — 004_exports.sql (ADDITIVE ONLY)
-- New `exports` table records server-generated PDF artifacts for the
-- synchronous reading-session export (canonical document + persisted
-- session threads). Does NOT touch the canonical
-- document/passage/anchor/highlight/thread/evidence/citation model and does
-- NOT alter frozen transaction/resolver contracts. `status` admits future
-- async states; the MVP writes 'complete' only (no job infrastructure).

CREATE TABLE IF NOT EXISTS exports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  created_by UUID REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'complete'
    CHECK (status IN ('complete', 'pending', 'processing', 'failed')),
  storage_key TEXT NOT NULL DEFAULT '',
  byte_size INT NOT NULL DEFAULT 0 CHECK (byte_size >= 0),
  input_hash TEXT NOT NULL DEFAULT '',
  thread_count INT NOT NULL DEFAULT 0 CHECK (thread_count >= 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_exports_version ON exports(document_version_id);
CREATE INDEX IF NOT EXISTS idx_exports_workspace ON exports(workspace_id);
