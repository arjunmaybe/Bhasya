# Authenticated staging acceptance ($0)

Targets the already-deployed staging Worker through the real Better Auth flow.
The unauthenticated `scripts/acceptance.ts` loop is local-dev only (seeded dev
user); staging enforces sessions and returns `401` without one, by design.

## Run

```sh
BHASYA_API_URL=https://bhasya-api.devmesh-8143.workers.dev npx tsx scripts/acceptance-staging-auth.ts
```

`BHASYA_API_URL` defaults to the staging URL above when unset.
`BHASYA_REQ_TIMEOUT_MS` (default `30000`) is a per-request probe backstop only.

## Credentials

* Set **both** `BHASYA_STAGING_EMAIL` and `BHASYA_STAGING_PASSWORD` to sign in
  with an existing staging test account, or
* set neither: the script creates one unique temporary identity
  (`staging-acceptance-<ts>@bhasya.test`) via the real Better Auth signup
  endpoint. Email/password auth is enabled in staging; if signup were ever
  disabled there, the script reports that prerequisite and stops (exit 2)
  instead of altering auth.

Generated passwords live in process memory only. Never print, commit, or store
credentials. The script logs statuses, ids, and counts only — never passwords,
cookies, tokens, secrets, or authorization headers. On a failed step it also
logs the redacted response body (credential-shaped fields stripped) as evidence.

## Transport ($0 staging, locked)

Worker → direct `DATABASE_URL` → Supabase PostgreSQL/pgvector, Supabase
Storage behind `StoragePort`. **Hyperdrive is intentionally not involved**
(future production profile only); R2 is not configured in staging. This
harness binds nothing and deploys nothing.

## Coverage

`[1]` healthz · `[2]` signup · `[3]` sign-in · `[4]` get-session ·
`[5]` ingest (implies DB writes + `StoragePort` artifact write — `put` runs
before the DB transaction, so `201` proves both) · `[6]` source list ·
`[7]` document/tree reads · `[8]` storage note (artifact read/delete have no
public route, so only the ingest write is verifiable; no admin API is
invented) · `[9]` sign-out · `[10]` post-logout `401`.

Fails fast (non-zero exit) on the first unexpected result.

## Test data

Each run leaves one temporary Better Auth user plus its source/version rows.
The application exposes no account/source deletion API by design, so no
cleanup is performed — this is preferable to bypassing the security boundary
with service credentials.
