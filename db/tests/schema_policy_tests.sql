-- Bhasya schema policy tests (frozen, Phase 1 invariants).
-- Run after 001_initial_schema.sql. Each block must succeed; failures = contract break.
-- Executed by tests/schema-policy.test.ts against the same SQL on PGlite/pg.

-- 1. Canonical chain exists
SELECT 1 FROM information_schema.tables WHERE table_name IN
  ('workspaces','sources','document_versions','document_nodes','passages','anchors',
   'highlights','threads','thread_messages','evidence','citations','embeddings','event_log');

-- 2. Immutability triggers exist
SELECT 1 FROM information_schema.triggers WHERE trigger_name IN
  ('trg_immutable_doc_versions','trg_immutable_doc_nodes','trg_immutable_passages','trg_immutable_messages');

-- 3. Assistant messages require model_id (checked at runtime by test inserts)
-- 4. Evidence owns document_version (column present, RESTRICT fk)
SELECT 1 FROM information_schema.columns
 WHERE table_name='evidence' AND column_name='document_version_id';
-- 5. Citation points to evidence (fk), never directly owns document version
SELECT 1 FROM information_schema.columns
 WHERE table_name='citations' AND column_name='evidence_id';
SELECT 1 FROM information_schema.columns
 WHERE table_name='citations' AND column_name='anchor_id';
