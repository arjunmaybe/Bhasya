-- Bhasya app-user link to Better Auth — 003_app_users_external_id.sql (ADDITIVE ONLY)
-- Inspection (2026-09-29): 001_initial_schema.sql defines
--   users(id UUID PK, email TEXT UNIQUE, display_name, created_at)
-- with NO external_user_id column anywhere (grep: no matches). Better Auth
-- owns its own `user` table; this column links the canonical app user to the
-- Better Auth user id. Does NOT touch the canonical
-- document/passage/anchor/highlight/thread/evidence/citation model and does
-- NOT alter frozen transaction/resolver contracts. Does NOT extend or rename
-- the custom auth_sessions table (002) as a substitute for Better Auth.

ALTER TABLE users ADD COLUMN IF NOT EXISTS external_user_id TEXT UNIQUE;
