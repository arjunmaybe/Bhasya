# Bhasya — Phase 2 Validation Measurement Plan

Phase 2: **14 days, 5 external users, real reading usage.**
Question: is the existing core workflow actually useful?

This document maps each validation question to the existing `event_log`
telemetry (via `logEvent`, `GET /api/events`) or to existing tables — no new
infrastructure, no analytics SaaS, no new dependencies. Architecture stays
frozen (`ARCHITECTURE.md`); the canonical chain
`Source → DocumentVersion → Passage → Anchor → Highlight → Thread → Evidence → Citation`
is unchanged.

## 1. Acquisition / activation (per user, via `event_log.user_id`)

| Question | Signal (existing) |
|---|---|
| Users successfully authenticate | `users` row count / `created_at`; Better Auth `user` table; first `event_log` row per `user_id`. No auth event type exists by design (would need a schema change); count identities, not logins. |
| Users open/read a source | `reading_session_started`, `document_opened`, `source_imported` |
| Users create ≥1 highlight | `passage_highlighted` (direct + auto-created by explanations) |
| Users create/use a passage thread | `thread_created`, `thread_reopened`, `thread_message_sent` |

Funnel queries (PostgreSQL, additive reads only):

```sql
-- Activated users: distinct users with any event
SELECT count(DISTINCT user_id) FROM event_log WHERE user_id IS NOT NULL;
-- Per-user funnel (one row per user, 1 = reached)
SELECT user_id,
  max((event_type = 'document_opened')::int) AS opened,
  max((event_type = 'passage_highlighted')::int) AS highlighted,
  max((event_type IN ('thread_created','thread_message_sent'))::int) AS threaded,
  max((event_type IN ('citation_viewed','citation_clicked'))::int) AS cited
FROM event_log GROUP BY user_id;
```

## 2. Core workflow funnel (existing events, in order)

`source_imported` → `reading_session_started` / `document_opened` →
`passage_highlighted` → `thread_created` → `thread_message_sent` →
`citation_viewed` / `citation_clicked` (+ `thread_reopened`, `document_completed`).

Notes:

- "Passage viewed" has no dedicated event type (adding one would require a
  frozen-schema migration). Proxy: `document_opened` + `reading_session_started`
  — the reader renders passages immediately after both.
- `citation_viewed` is emitted by `GET /api/citations/:id` (added for Phase 2;
  the type was allowed but never written). `citation_clicked` remains the
  explicit-click signal from the reader.
- `GET /api/events` returns per-event `user_id` (workspace-scoped, auth-gated)
  so the funnel is queryable through the API without direct DB access.
- `thread_created` / `thread_message_sent` metadata carries `modelId` +
  `durationMs` (AI latency signal). Metadata never contains prompts, responses,
  document text, or personal data.

## 3. Return usage (existing `event_log.created_at` + session markers)

```sql
-- First vs subsequent activity per user
SELECT user_id, min(created_at) AS first_seen, max(created_at) AS last_seen,
  count(*) AS events,
  count(DISTINCT date_trunc('day', created_at)) AS active_days
FROM event_log GROUP BY user_id;
-- Repeat use of existing artifacts (reopens, re-clicks)
SELECT event_type, count(*) FROM event_log
WHERE event_type IN ('thread_reopened','citation_clicked','citation_viewed','document_completed')
GROUP BY event_type;
-- Sessions per user (reader emits start/end around each document visit)
SELECT user_id, count(*) FILTER (WHERE event_type='reading_session_started') AS sessions
FROM event_log GROUP BY user_id;
```

A user is "returning" when `active_days > 1` or a second
`reading_session_started` appears after the first session's events.

## 4. Reliability (no new failure tables; observe via HTTP + logs)

Failures keep their existing representation (no new event types, no schema
change — failed operations write no success events, so absence + status codes
is the signal):

| Failure class | Detection (existing) |
|---|---|
| API failures | HTTP status via `err()` mapping: 401 unauthenticated, 404 enumeration-safe, 400 bad input, 500 internal. Worker/Node logs. |
| Ingestion failures | `POST /api/sources/ingest` non-201 (400/500); no `source_imported` row. |
| Auth failures | 401 with no attributed event (covered by `tests/phase2-validation.test.ts`). |
| Citation/evidence resolution failures | 404 (authenticated, no access) with no `citation_viewed` row. |
| Thread persistence failures | `withTransaction` throws → 500; no partial thread/message rows (atomic). |
| AI failures/latency | Provider throw → 500; latency via `metadata.durationMs` on thread events; model via `metadata.modelId`. |
| Frontend errors | Local `ReaderClient` error state only (no reporting endpoint by design — no new architecture). Collect qualitatively during the trial. |

Retry safety: reads (`GET` citation/thread) are idempotent — re-requests append
only analytic events, never duplicate threads/messages/citations (covered by
`tests/phase2-validation.test.ts`).

## 5. Data / privacy rules (enforced)

- Event metadata: ids, `modelId`, `durationMs` only. Never raw document
  content, prompts, responses, IPs, or personal identifiers.
- Identity: stable internal `users.id` UUIDs, server-derived from the Better
  Auth session. `GET /api/events` is workspace-scoped and auth-gated.
- No RLS/auth weakening was made for telemetry.

## 6. 14-day / 5-user ops checklist

1. Deploy staging per `apps/api/wrangler.toml` ($0: Supabase PG/pgvector +
   Supabase Storage; secrets via wrangler, never committed). No R2 required.
2. Confirm `GET /healthz` 200 and Better Auth sign-up → `get-session` → user.
3. Onboard 5 users; each imports ≥1 real page.
4. Weekly: run the funnel / return-usage queries above; note drop-off steps.
5. Collect qualitative notes (was the explanation grounded? did threads reopen
   correctly?). No product changes mid-trial unless reliability-critical.
6. Gate decision only after 14 days of real usage — no premature success claims.

## 7. What changed for Phase 2 (vs what already existed)

Changed (3 minimal, additive, no migration):

- `apps/api/src/app.ts` — `GET /api/citations/:id` emits `citation_viewed`
  after authorize + existence check; `GET /api/events` includes `user_id`.
- `apps/api/src/services.ts` — `explainSelection` records `modelId` +
  `durationMs` in thread-event metadata (outside transactions).
- `tests/phase2-validation.test.ts` — 7 tests: correct attribution,
  unauthenticated 401 + no attribution, cross-workspace 404 + no leak,
  events `user_id`, retry idempotence, metadata content/privacy, 404 failures.

Deliberately unchanged: Better Auth wiring, resolvers, transactions, schema
(`001` frozen; no `004` migration needed), StoragePort selection, ModelRouter,
reader flow, and all existing tests.
