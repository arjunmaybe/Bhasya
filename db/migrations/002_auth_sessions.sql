-- Bhasya auth sessions — 002_auth_sessions.sql (ADDITIVE ONLY)
-- Better Auth session lifecycle (production). Does NOT modify the canonical
-- document/passage/anchor/highlight/thread/evidence/citation model from 001,
-- and does NOT alter frozen transaction/resolver contracts.
--
-- Production: Better Auth owns session lifecycle. The Hono boundary resolves
-- the session server-side (cookie `better-auth.session_token` /
-- `__Secure-better-auth.session_token` or `Authorization: Bearer <token>`)
-- and derives identity (user + workspace) from the database. Query parameters
-- and arbitrary request headers NEVER select the user.
--
-- Local dev (BHASYA_USE_AUTH != "1"): single seeded dev user/workspace via
-- seedDev(). This table is unused in that mode.

CREATE TABLE IF NOT EXISTS auth_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash TEXT NOT NULL UNIQUE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expires ON auth_sessions(expires_at);
