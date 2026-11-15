# Bhasya

Bhasya is a reading and knowledge workspace for long-form web pages. It imports a page into an immutable, passage-addressable document model and keeps AI explanations, highlights, discussion threads, evidence, and citations attached to the exact passage they came from.

## Live staging

| Item | Value |
|---|---|
| Web app | https://bhasya-web.devmesh-8143.workers.dev |
| API | https://bhasya-api.devmesh-8143.workers.dev |
| Status | Deployed and working, staging only |

Staging is a validation environment, not production. It runs the `dev-grounded-1` model adapter: a deterministic, extractive adapter used for development and contract testing, not a production AI integration. Public sign-up is disabled; accounts are provisioned by the operator. Do not treat staging as a production service or use it for sensitive material.

## What Bhasya does

Reading a long article with a general-purpose chat usually means copying text out of the page. The explanation loses its source, the conversation cannot be reopened in context, and there is no reliable way to see which passage a claim came from.

Bhasya treats the document as the primary object. A URL is fetched and normalized into a canonical node tree and passage list. Every explanation is grounded in the selected passage and its nearby context. Highlights, threads, and citations reference passages by stable identifiers, so reopening a document restores the source context rather than a detached chat log.

The project is built around the Phase 1 question recorded in [`ARCHITECTURE.md`](ARCHITECTURE.md): can a person open a document or web page, select a passage, immediately get an AI explanation attached to that passage, and later return to the same thread and source context?

## Reading workflow

1. Paste a publicly accessible page URL in the library. The server fetches it through the SSRF-guarded intake path.
2. Bhasya extracts the title, language, node tree, and passages, then writes an immutable document version (version 1 for a new source). The raw HTML is stored in private object storage.
3. The library lists recent sources and filters them by title or URL. Selecting a source opens `/read/<versionId>`.
4. The reader renders the canonical node tree. Each passage is addressable by id, ordinal, and structural path.
5. Selecting text resolves an anchor: selected text, start and end offsets, passage id, structural path, text hash, and a context fingerprint. The anchor is the stable reference used by the highlight and the passage thread.
6. Choosing **Explain** creates or reuses the passage thread, persists the user message, and assembles the explanation context: the exact passage (L0) plus nearby passages (L1).
7. The model response is persisted as an assistant message with evidence rows, a citation, and a highlight for the anchor. Streaming endpoints deliver the same result incrementally.
8. Citations in the side panel navigate back to the cited passage. The passage thread reloads with its messages on reopen.
9. Reading progress is saved periodically and on page hide for the current user and document version. When a saved position exists and is not at the beginning, the reader offers **Resume reading** or **Start from beginning**. It never jumps automatically before the reader chooses.
10. **Export PDF** renders the article and a "Bhasya Reading Session" appendix containing the caller's own threads, messages, evidence, and citations.

## Implemented features

**URL-based source ingestion.** `POST /api/sources/ingest` accepts a URL, validates it with the project schema, and fetches it through `packages/core`'s secure intake. Redirects are capped at 3, response size at 2 MB, each fetch times out at 12 seconds, and content types are limited to `text/html` and `text/plain`. URL credentials, loopback, private, link-local, and internal hostnames are rejected, and DNS results are checked before the request. Character encoding is detected from headers and the document head. Identical content in the same workspace reuses the existing version; `POST /api/sources/:id/reingest` creates a new immutable version when the content changes.

**Immutable document versions and structured passages.** A version owns a `document_nodes` tree and a passage list. Node types are `document`, `heading`, `section`, `paragraph`, `list`, `list_item`, `quote`, `code`, `figure`, and `caption`. Database triggers reject `UPDATE` and `DELETE` on document versions, nodes, passages, and thread messages. Passages carry a generated full-text search vector and a text hash.

**Passage-level explanations.** `POST /api/threads/explain` and `POST /api/threads/explain/stream` produce an explanation for an anchor. `POST /api/threads/:id/messages` and its streaming variant add follow-up turns. Explanations are scoped to the selected passage; the service does not silently broaden to whole-document context.

**Anchored highlights.** `POST /api/anchors/resolve` maps a selection to a passage and stores the anchor. `POST /api/highlights` persists a highlight for an anchor, and `GET /api/documents/:versionId/highlights` loads them for the reader. The explanation action creates the highlight for its anchor; the web reader has no separate highlight-only control. Persisted highlights render as marked slices of passage text.

**Persistent discussion threads.** Explanations reuse one passage-scoped thread per anchor. `GET /api/threads/by-anchor/:anchorId` returns the thread for an anchor, and `GET /api/threads/:id` returns a thread with its messages. Messages are append-only.

**Evidence-backed citations.** An assistant message records L0 evidence for the exact passage, a citation whose locator contains the passage id and structural path, and up to two L1 evidence rows for nearby passages. `GET /api/citations/:id` resolves a citation, and `POST /api/citations/:id/clicked` records the interaction. The citation chain resolves `Citation -> Evidence -> Passage -> DocumentVersion`.

**Per-user reading progress and resume.** `GET` and `PUT /api/documents/:versionId/progress` store one resume point per document version and authenticated user: a passage id plus a relative position from 0 to 1 inside that passage. Writes from one reader instance carry an instance id and a sequence number, so an older request from the same instance cannot overwrite a newer one. The response is always `Cache-Control: no-store`, including error responses. A missing or invalid saved passage falls back to the beginning. If progress cannot be loaded, the reader does not guess and does not overwrite the saved row.

**Reading-session PDF export.** `POST /api/documents/:versionId/exports` renders the document from canonical rows and appends the caller's own threads with their messages, evidence, and citations. `GET /api/exports/:id` serves the bytes from private storage through the authorized API. Generation is synchronous in this version. PDF work stays server-side; the browser only requests generation and downloads the artifact.

**Library.** The library lists up to 50 recent sources and filters them by title or URL. Sources with a version link to their latest version; sources without a version display as **Not ready**.

## Architecture

```text
Browser
  |  same-origin /api/*  (session cookie stays first-party)
  v
Next.js App Router (apps/web)
  |  Server Components + Route Handler proxy
  v
Hono API (apps/api)
  |-- authorization/   resolve resource -> derive workspace -> membership check
  |-- packages/ai      ModelRouter -> provider adapter (dev-grounded-1 fallback)
  |-- StoragePort      Supabase Storage | R2 (optional) | filesystem (local)
  `-- PostgreSQL + pgvector
```

The API process is the same Hono router in both environments: `@hono/node-server` locally and a Cloudflare Worker in deployment. The browser never calls the API origin directly. It calls `/api/*` on the web origin, and the Route Handler proxy forwards the request to `BHASYA_API_URL`, preserving the method, body, status, `Set-Cookie`, streaming responses, and client cancellation.

### Canonical data model

```text
Workspace
`-- Source
    `-- DocumentVersion (immutable)
        `-- DocumentNode tree
            `-- Passage
                `-- Anchor
                    |-- Highlight
                    `-- Thread
                        `-- Message
                            `-- Evidence
                                `-- Citation
```

`reading_progress` and `exports` are auxiliary tables, not part of the canonical chain. The canonical chain is unchanged by either feature.

### Request and data flow

**Ingestion.** The API fetches the URL, normalizes the HTML into canonical nodes and passages, writes the raw HTML to `StoragePort` at `sources/<id>.html`, then writes the source, version, nodes, and passages in one transaction. Network work happens before the transaction, and the transaction contains no network or model calls.

**Explanation.** The API authorizes the anchor, retrieves L0 and L1 context, creates or reuses the thread and writes the user message, then calls the provider outside any transaction. A second transaction persists the assistant message, evidence, citation, and highlight.

**Progress.** The reader snapshots the passage at the reading line, sends the passage id and relative offset with an instance id and sequence number, and the API applies a guarded upsert scoped to the authenticated user and authorized version.

**Export.** The service authorizes the version, loads canonical rows plus only the caller's threads, builds the export intermediate representation, renders the PDF, stores it at `exports/<versionId>/<exportId>.pdf`, and inserts the `exports` row last. A renderer failure leaves no row and no artifact.

### Explanation context

`packages/ai` currently assembles explanation context as follows:

- **L0**: the exact selected passage, always rank 0.
- **L1**: up to three passages from the same section, identified by a structural path prefix and ordered by ordinal. If the section has no other passages, retrieval falls back to PostgreSQL full-text search over the document version using the first 40 tokens of L0. A failed full-text query degrades to no L1 context.

The provider receives L0 plus L1. The persisted record keeps L0 evidence with a citation and up to two L1 evidence rows. There is no L2 or L3 broadening.

pgvector is available at the database layer: the schema enables the `vector` extension and defines an `embeddings` table with `vector(1536)`. The current explanation workflow does not generate embeddings or execute vector similarity queries. Vector retrieval is provisioned in the database but is not active in the product flow.

### Storage and transactions

Application code sees only `StoragePort.put` and `StoragePort.get`. Selection order is: R2 bucket binding, then Supabase Storage credentials, then the local filesystem adapter. Production fails closed when neither remote backend is configured. Local development never uses a remote bucket unless configured.

Transaction boundaries live in `db/transactions.ts`. No provider call or network fetch runs inside a transaction. Resource resolvers determine existence and authoritative workspace, while a separate authorization layer checks membership.

## Technology stack

| Area | Implementation |
|---|---|
| Language | TypeScript 5.9, Node.js 22 in CI |
| Workspace | npm workspaces (`apps/*`, `packages/*`) |
| Web | Next.js 16.4.6 App Router, React 19.3.1, Server Components |
| API | Hono 4.13.18, `@hono/node-server` locally, Cloudflare Workers in deployment |
| Auth | Better Auth 1.7.22 with email/password sessions and the bearer plugin |
| Database | PostgreSQL with pgvector; Docker dev image `pgvector/pgvector:pg16`; Supabase PostgreSQL; Cloudflare Hyperdrive on staging |
| Storage | Supabase Storage behind `StoragePort`; filesystem locally; R2 optional |
| Validation | Zod 4.6.7 |
| AI | Provider adapters for an OpenAI-compatible HTTP endpoint, Gemini, and Groq; deterministic `dev-grounded-1` fallback |
| PDF | pdf-lib 1.17.x |
| Tests | Vitest 5.1.0, PGlite, embedded PostgreSQL for the test harness |
| Deployment | OpenNext Cloudflare 1.20.17, Wrangler 4.161.0 |
| Rust | `core-rs`, a mirror of the canonical contracts |

## Repository layout

```text
apps/
  web/                  Next.js library, reader, sign-in, and API proxy
  api/                  Hono routes, services, Worker entry, PDF export, progress
packages/
  core/                 canonical types, HTML normalization, SSRF guard, hashing
  ai/                   ModelRouter, provider adapters, retrieval context, streaming
  db/                   database client, migrations replay, Better Auth, storage, events
authorization/          resource resolvers and the authorization pipeline
db/
  migrations/           sequential SQL migrations 001 through 005
  transactions.ts       database transaction boundary
core-rs/                Rust mirror of the canonical contracts
scripts/                migration, seed, acceptance, smoke, and latency scripts
tests/                  Vitest test suites
docs/                   staging acceptance notes
.github/workflows/      CI workflow
```

## Local development on Windows

### Prerequisites

- Node.js 22 (the version used in CI). There is no `engines` pin.
- npm, included with Node.js.
- Git.
- Docker Desktop only if you want a real PostgreSQL instance. The default path does not need it.

### Quick start with PGlite

Open two PowerShell terminals at the repository root.

```powershell
npm ci
```

```powershell
# Terminal 1: API
npm run dev:api
```

```powershell
# Terminal 2: web app
npm run dev:web
```

Open http://localhost:3000.

`dev:api` starts the Hono app on port 8787 with a PGlite database at `apps/api/.bhasya-pglite` and filesystem object storage at `apps/api/.bhasya-objects`. It applies the migrations and seeds the single local development user and workspace on startup. With `BHASYA_USE_AUTH` unset, that seeded identity is used; there is no sign-in step locally.

`dev:web` starts Next.js on port 3000. When `BHASYA_API_URL` is unset, the web app proxies `/api/*` to `http://localhost:8787`.

Both local data directories are gitignored. Delete them only when you intend to discard local data.

### Environment variables

The API reads `process.env` directly. The npm scripts do not load a `.env` file: there is no `dotenv` dependency and no `--env-file` flag in the scripts. Copying `.env.example` to `.env` does not configure the API by itself.

Set variables in the same PowerShell session that starts the API:

```powershell
$env:BHASYA_MODEL_API_KEY = "..."
$env:BHASYA_MODEL_ID = "your-model-id"
npm run dev:api
```

[`.env.example`](.env.example) documents the supported variables. The web app is a separate process; set `BHASYA_API_URL` there if the API runs on another origin.

### Optional PostgreSQL

```powershell
docker compose up -d postgres
$env:DATABASE_URL = "postgres://bhasya:bhasya@localhost:5432/bhasya"
npm run db:migrate
npm run dev:api
```

`npm run db:migrate` applies the migrations and seeds the development identity. Keep `DATABASE_URL` set in the API terminal; if it is empty or unset, the API falls back to PGlite.

### Optional real model provider

The default is `dev-grounded-1`, which produces deterministic extractive text and does not call a network model. To use a real provider, configure one of the supported adapters in the API process. Environment variables are read when the API process starts. Stop any existing API process before changing providers, then start it again in the same PowerShell session.

OpenAI-compatible HTTP endpoint:

```powershell
$env:BHASYA_MODEL_API_KEY = "..."
$env:BHASYA_MODEL_ID = "..."
$env:BHASYA_MODEL_ENDPOINT = "https://api.openai.com/v1/chat/completions"
npm run dev:api
```

Dedicated providers:

```powershell
$env:BHASYA_PROVIDER = "gemini"
$env:GEMINI_API_KEY = "..."
$env:GEMINI_MODEL_ID = "gemini-3.1-flash-lite"
# Start the API in this same session.
npm run dev:api
```

```powershell
$env:BHASYA_PROVIDER = "groq"
$env:GROQ_API_KEY = "..."
$env:GROQ_MODEL_ID = "openai/gpt-oss-20b"
# Start the API in this same session.
npm run dev:api
```

A missing provider key falls back to `dev-grounded-1`. `scripts/measure-latency.ts` measures a configured provider; see `.env.example` for the required variables.

### Local Better Auth mode

The PGlite/seeded-identity quick start above is the recommended local path. `BHASYA_USE_AUTH=1` does not use that path. It switches the API to the production fail-closed configuration, which requires a PostgreSQL `DATABASE_URL` and a configured remote `StoragePort` backend, such as Supabase Storage. PGlite and the local filesystem adapter are not selected in this mode. Configure the Better Auth URL, secret, and trusted web origin for the API as well; the API reads them from `process.env` like the other variables.

Local Better Auth testing also requires an existing account. Public sign-up is disabled by default, so the first account must be provisioned separately by the operator, not through the application UI. The library and reader pages require a session when this mode is enabled.

### Troubleshooting

- **PGlite WAL or startup error.** Stop the API cleanly with Ctrl+C so PGlite can checkpoint. The development server handles SIGINT and SIGTERM for this reason.
- **Port conflict.** Set `API_PORT` for the API. The web dev server uses port 3000.
- **Web shows an API unavailable or configuration error.** Start the API first, or set `BHASYA_API_URL` in the web process.
- **PowerShell aliases.** Use `curl.exe` rather than `curl` when you need the real curl binary.

## Tests, typecheck, and builds

| Command | What it does |
|---|---|
| `npm test` | Runs the Vitest suites (the config includes `tests/**/*.test.ts` and any `packages/*/tests/**/*.test.ts`) |
| `npx vitest run tests/reading-progress.test.ts` | Runs one focused suite |
| `npm run typecheck` | Runs `next typegen` in `apps/web`, then `tsc --noEmit` |
| `npm run build:web` | Production Next.js build |
| `npm run build --workspace apps-api` | API TypeScript check (`tsc --noEmit`) |
| `npm run cf:build --workspace apps-web` | OpenNext Cloudflare Worker build |
| `npm run build` | Runs the build script in every workspace that has one |

The test harness boots one embedded PostgreSQL cluster in global setup and runs Vitest with forked workers. Tests do not use the local development database.

CI (`.github/workflows/ci.yml`) runs on pushes and pull requests to `main` with Node.js 22: install dependencies, run tests, typecheck, build the API, and build the Cloudflare Worker for the web app.

## Security and privacy

**Identity and authorization.** In authenticated deployments, identity comes only from the Better Auth session. `getIdentityForRequest` accepts headers, not URL selectors, so `?user=` and `x-user-id`-style values cannot select an identity. Every protected route requires an authenticated identity and scopes reads and writes to that identity's workspace. Resource-specific routes use the resolver pipeline or an equivalent explicit workspace or owner check. Unauthenticated requests return 401. For resource-specific routes, authenticated requests for inaccessible resources return 404 rather than 403, so resource existence is not leaked. Workspace and object scoping is enforced in the API and data layer, not by hidden UI.

**Ingestion.** The SSRF guard allows only HTTP and HTTPS, rejects URL credentials, blocks loopback, private, link-local, and internal hostnames, and validates resolved DNS addresses before fetching. Redirects are revalidated. Response size, time, and content type are capped. Imported content is treated as untrusted data, never as instructions.

**AI boundary.** Provider calls receive the selected passage and nearby context. Imported document text is never interpreted as agent instructions. There is no silent broadening from L0/L1 to a whole-document request.

**Storage.** Artifacts live in a private bucket or the local filesystem. The Supabase service key stays server-side. No public artifact URL is minted. Export downloads pass through the authorized API, and only the caller's own threads are included.

**Progress.** Reading progress is scoped by authenticated user and authorized document version. Responses carry `Cache-Control: no-store`. The passage must belong to the requested version, and a stale or mismatched row is never resumed.

**Web/API proxy.** The proxy forwards an allowlist of request headers, caps request bodies at 1 MB, preserves `Set-Cookie` and streamed responses, and fails closed with 503 in production when `BHASYA_API_URL` is unset. `BHASYA_API_URL` is server-only and never reaches a client bundle.

**Telemetry.** The append-only `event_log` records metadata only. `source_imported` events from the initial ingest path store the final source URL and title; re-ingest events record only a re-ingest marker and version number. Explanation events store model identifiers, timing, and input/output size estimates, including character counts and token estimates. These event paths do not store prompts, assistant response bodies, or the full document body. Source URLs and titles can themselves contain sensitive information, so they should be treated accordingly when `event_log` data is accessed or retained.

**Accounts.** Public sign-up is disabled in authenticated deployments; an explicit disable flag always wins. The library and reader routes are marked `noindex`. Better Auth uses explicit trusted origins and does not trust proxy headers for origin decisions.

## Staging and production

| Area | Staging | Production |
|---|---|---|
| Web | https://bhasya-web.devmesh-8143.workers.dev | Not deployed |
| API | https://bhasya-api.devmesh-8143.workers.dev | Not deployed |
| Database | Supabase PostgreSQL via Hyperdrive (`bhasya-staging-verified`) | Placeholder profile only |
| Storage | Supabase Storage, private `bhasya-artifacts` bucket | Placeholder R2 profile only |
| Auth | Better Auth sessions | Not deployed |
| Sign-up | Disabled; operator-provisioned accounts | Policy defined, not deployed |
| AI adapter | `dev-grounded-1` | Not deployed; template defaults to `dev-grounded-1` when no provider key is configured |
| Purpose | Validation and acceptance | None yet |

Staging is the default Wrangler deployment and runs on the $0 baseline: Supabase PostgreSQL with pgvector, Supabase Storage behind `StoragePort`, and no R2 billing.

There is no production deployment. The `[env.production]` block in `apps/api/wrangler.toml` is an optional template for a future R2 and separate Hyperdrive profile. It contains replacement values such as `api.bhasya.example` and `REPLACE_WITH_HYPERDRIVE_ID`, and it must not be treated as a live environment. This repository does not claim a production launch, production traffic, or production AI behavior.

## Current limitations and deferred work

- **Ingestion is HTML and text only.** EPUB, Markdown, and DOCX conversion are deferred, and there is no upload UI. The schema supports `upload` and `text` source kinds, but only URL ingestion is exposed.
- **Re-ingestion is API-only.** `POST /api/sources/:id/reingest` exists, but the web UI imports new sources only.
- **The staging AI adapter is not a production model.** `dev-grounded-1` is deterministic and extractive. It accepts thread history for contract parity but does not reason over it. Real provider adapters exist behind the same interface and are not enabled on staging.
- **Vector retrieval is not active.** pgvector and the `embeddings` table exist at the database layer, but the explanation workflow uses L0 plus same-section L1 with an FTS fallback, and does not generate or query embeddings.
- **PDF export is synchronous and lossy.** Figures and images from the original page are omitted; captions render as text. Author, byline, tables, and rich links are not preserved. Oversized appendices are truncated with an explicit note. Asynchronous export jobs are deferred.
- **Public sign-up is closed.** Accounts are created by the operator. There is no self-serve registration, billing, or subscription tier.
- **Progress is per document version.** A new immutable version starts without a saved position; progress does not carry across versions.
- **The web app is the only client.** A browser extension, Tauri desktop client, offline sync, SQLite replica, and collaborative editing are deferred per `ARCHITECTURE.md`, along with anchor remapping workflows, additional conversion artifacts, Qdrant, GraphRAG, CRDTs, advanced model routing, and large-scale export.
- **No production deployment exists.** Staging is the only deployed environment in this repository.

## Documentation

- [`ARCHITECTURE.md`](ARCHITECTURE.md): frozen architecture and canonical contracts
- [`PHASE2_VALIDATION.md`](PHASE2_VALIDATION.md): validation questions mapped to existing telemetry
- [`docs/staging-acceptance.md`](docs/staging-acceptance.md): authenticated staging acceptance procedure
- [`.env.example`](.env.example): environment variable reference
- [`.github/workflows/ci.yml`](.github/workflows/ci.yml): CI validation steps
