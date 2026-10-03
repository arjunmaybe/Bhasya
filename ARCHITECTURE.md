# Bhasya — Frozen $0 Architecture

> This file is the authoritative Bhasya $0 architecture and is FROZEN.
> Do not redesign. Phase 1 implements inside these contracts.

## Product question (Phase 1 slice)

> Can a person open a document/webpage, select a passage, immediately get an AI
> explanation attached to that passage, and later return to the same thread and
> source context?

## Clients

- Next.js App Router web app (Phase 1)
- Browser extension: later phase (deferred)
- Tauri v2 + Rust desktop: later phase (deferred)

Rule: Server Components by default. Client Components only for selection,
highlighting, floating thread UI, streaming, browser APIs.

## Edge

- Cloudflare DNS / CDN / WAF / DDoS / bot controls (production)
- Cloudflare Workers + Hono API (production gateway)
- Local dev: Hono served via Node (`@hono/node-server`); same router, same contracts.

Do NOT replace Hono with Next.js API routes.

## State

- PostgreSQL (application state, authoritative)
- pgvector (canonical cloud embeddings, inside PostgreSQL)
- Supabase Storage behind `StoragePort` (source/artifact object storage;
  $0 baseline, private bucket `bhasya-artifacts`)
- Optional future production provider behind the same `StoragePort`:
  Cloudflare R2 (`R2StorageAdapter`). Not required for $0 staging/deploy.
- Application code is provider-blind through `StoragePort` (`put`/`get`
  only): it must not know whether storage is Supabase Storage or R2, and
  must not depend directly on Supabase Storage.
- Local dev equivalents (NOT competing architectures):
  - PostgreSQL via container, or PGlite (Postgres-WASM, same SQL dialect) when
    no server is available. No JSON persistence. No second schema.
  - Filesystem-backed `StoragePort` implementing the same `StoragePort` contract.
  - Synchronous job execution implementing the same Queue contract.

Do NOT replace PostgreSQL with JSON files. Do NOT replace pgvector with Qdrant.

### Storage selection ($0 baseline, locked)

- $0 baseline = Supabase Storage (`SupabaseStorageAdapter`, Worker-safe
  `fetch` REST, `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` + private bucket
  `bhasya-artifacts`). Default/staging Worker configuration uses this and
  must NOT require an R2 bucket binding or R2 billing.
- Optional future production provider = Cloudflare R2 (`R2StorageAdapter`,
  bucket binding such as `BHASYA_BUCKET`). Isolated behind a separate
  production environment/profile; never required for $0 staging.
- Selection order: R2 bucket binding present → R2; else Supabase env present
  → Supabase; else production fails closed, local dev uses the filesystem
  adapter. Fail closed only when neither configured backend is available.

## Async

- Cloudflare Queues + isolated workers (production)
- Local dev: synchronous execution through the same `QueuePort` interface.
  Same job names, same payloads, same idempotency keys.

## Core

Shared canonical contracts (defined here, implemented in `packages/core` and
mirrored in `core-rs`):

- canonical document / normalization / anchoring / conversion contracts
- `Workspace → Source → DocumentVersion → DocumentNode tree → Passage → Anchor → (Highlight, Thread → Message → Evidence → Citation)`
- Document versions are immutable. Re-ingestion creates a new version.
- Citation resolves `Citation → Evidence → Passage → DocumentVersion`.

Do NOT invent a second document model. Do NOT collapse to `Document → text → chat`.

## AI

- retrieval: PostgreSQL FTS + pgvector → merge/rank → rerank → evidence
- ModelRouter + provider adapters (`packages/ai`)
- Phase 1 primary action: `Explain this passage` with L0 (exact selection) + L1
  (nearby context). No silent broadening to L3.
- Imported document content is untrusted source material, never instructions.
- Client embeddings are never authoritative.

## Auth

- Production: Better Auth (session lifecycle).
- Validation build: single seeded dev user/workspace. Workspace ownership is
  server-derived via resource resolvers + authorization layer, never
  client-supplied. Hono boundary stays Better-Auth compatible.

## Transaction / authorization boundaries (frozen)

- `db/transactions.ts`: owns DB transaction boundaries. No network/model work
  inside a transaction. PG statement timeout is a backstop only.
- `authorization/resource-resolvers.ts`: resolve existence + authoritative
  workspace. Resolvers do NOT authorize. Authorization is a separate layer.
  Combined pipeline yields enumeration-safe HTTP behavior (401/404 discipline).

## Deferred (do NOT pull forward)

browser extension, Tauri desktop, offline sync, SQLite replica, anchor remapping
workflows, PDF/EPUB/Markdown/DOCX conversion UI, conversion artifacts beyond
Phase 1, Qdrant, GraphRAG, CRDTs, advanced model routing, collaborative editing,
billing, large-scale export.

## Phase 1 build order

URL → secure intake → canonical version → node tree → passages → anchor/highlight
→ passage thread → grounded explanation → evidence → version-aware citation → reopen.
Plus: Hono API, Next.js reader, event log, existing security/transaction boundaries.

## Validation gate and later phases (preserved)

- Phase 1 / Phase 2 validation gate: the existing verification loop stays
  authoritative — `npm test` (including the `StoragePort` contract tests),
  `npm run typecheck`, `npm run build:web` — plus staging migration
  verification against Supabase PostgreSQL + pgvector. Later phases begin
  only after this gate passes with no R2 billing enabled.
- Later phases remain deferred per the list above. No phase renames the
  product: the product is Bhasya.
