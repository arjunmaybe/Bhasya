-- Bhasya per-user reader progress — 005_reading_progress.sql (ADDITIVE ONLY)
-- New reading_progress table stores one resume point per (document version,
-- authenticated user): a stable passage anchor plus the reading line's
-- relative position inside that passage (0..1). Identity always comes from
-- the authenticated session; workspace ownership is derived through
-- document_versions -> sources, so no workspace_id is duplicated here.
--
-- writer_instance_id / writer_sequence are an ordering guard for ONE reader
-- instance (a mounted reader tab). Every save dispatch carries the instance's
-- opaque UUID and a strictly increasing sequence; an older request that
-- arrives after a newer one from the same instance is ignored. A different
-- instance always wins, so the agreed multi-tab last-write-wins behavior is
-- preserved.
--
-- Does NOT touch the canonical document/passage/anchor/highlight/thread/
-- evidence/citation model and does NOT alter frozen transaction/resolver
-- contracts. event_log is unchanged (its event_type CHECK is frozen).

CREATE TABLE IF NOT EXISTS reading_progress (
  document_version_id UUID NOT NULL REFERENCES document_versions(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  passage_id UUID NOT NULL REFERENCES passages(id) ON DELETE CASCADE,
  offset_ratio DOUBLE PRECISION NOT NULL DEFAULT 0
    CHECK (offset_ratio >= 0 AND offset_ratio <= 1),
  writer_instance_id UUID NOT NULL,
  writer_sequence BIGINT NOT NULL DEFAULT 0
    CHECK (writer_sequence >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (document_version_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_reading_progress_user ON reading_progress(user_id);
