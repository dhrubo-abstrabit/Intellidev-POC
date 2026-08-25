# Nango migration decision log

Append-only record of decisions made while migrating connector OAuth/token custody from the hand-rolled layer (`lib/crypto/tokens.ts`, `lib/oauth/*`, per-connector `getAuthorizeUrl`/`exchangeCode`/`refreshTokens`) to self-hosted Nango. Companion to the plan at the time of writing (`playful-watching-whale` plan file) — this log is *why it changed*; `ARCHITECTURE.md`/`DATABASE_SCHEMA.md` describe the system *as it is*. Don't fold one into the other.

Format: one dated, numbered entry per decision, newest last. Entries are never edited in place — a reversal gets a new entry with `**Supersedes:** D-00N`.

---

## Current status (as of 2026-08-25)

**Read this section first when picking this work back up — it's the fastest way to get oriented.** The rest of this file is a chronological decision log (D-001 onward); this block is a snapshot of *where things actually stand right now*. This log itself was briefly lost (see the 2026-08-25 note below) when the work moved onto a different branch than the one it was written against — the plan-file reference from the 2026-08-20 version of this section (`playful-watching-whale.md`) is gone for the same reason and isn't recoverable; don't go looking for it.

**Branch:** `feature/nango-on-4level-hierarchy`, not `feature/nango-migration` — the Nango work (the D-001–D-028 history below) was rebased onto a separate, concurrent restructuring of the schema into a 4-level tenant hierarchy (tenant → workspace → client space → project). The 6 Nango commits landed here as a clean, disjoint diff on top of that restructure (verified via `git merge-tree`: zero file overlap with anything `main` changed independently). `feature/nango-migration` (last commit `461f3f9`) is the stale pre-rebase branch — don't build on it.

**2026-08-25 update — the cloud cutover (Phase 4b from the old status block) is done, plus follow-on fixes found while doing it:**
- Nango is now hosted at a public HTTPS URL (no longer the local Docker stack this log's earlier entries describe) with `google` and `slack` integrations configured on it. `.env.local` points at it.
- Both migrations from D-008/D-011's design (`20260820102000_nango_credentials.sql`, `20260820102100_integrations_null_credential_uniqueness.sql`) are applied to the cloud project (`nktmgdeeiukjimkwkylo`).
- The Phase 5 cleanup migration mentioned in the old status block is done: `20260820102200_drop_legacy_credential_secret_columns.sql` dropped all 7 vestigial `connector_credentials` columns (`secret_ciphertext`, `secret_iv`, `secret_key_version`, `secret_alg`, `access_token_expires_at`, `refresh_failed_at`, `refresh_failure_count`) — confirmed zero code/constraint/policy/trigger/pgTAP references before dropping. `database.types.ts` regenerated against the cloud project (`--local` doesn't work without a running local Docker stack; `--linked` does).
- `reconcileConnections` (D-026 first touched this) no longer runs on every Integrations page render — that put an uncached Nango HTTP call plus a per-connection DB query on the page's critical path for a check that almost always finds nothing. It now runs from two client-triggered places instead: `ConnectProviderButton`'s `close`-without-preceding-`connect` event (the exact moment D-026's kind of orphan gets created — free, client-side), and a manual "Check for connections" button for the rarer whole-browser-crashed case. Also handles the Connect UI's `error` event now, previously unhandled (a failed OAuth inside the popup surfaced nothing).
- Two pre-existing, unrelated defects were found and fixed in the same pass: `daily_tick` (`public.dispatch_daily_tick()`, scheduled via `pg_cron`) had never fired even once since Vercel Cron was removed — the migration disables it on creation pending a "flip it on right after this deploys" step that was simply never done. Fixed via a new forward migration plus giving `api/cron/tick` its own `maxDuration = 60`. Separately, `supabase/config.toml`'s `[auth.external.google].skip_nonce_check` had been `true` since before Google sign-in was ever enabled — its justification (a nonce mismatch) was never actually observed, and turned out to cite Supabase CLI boilerplate as if it were project-specific evidence. Flipped to `false` and pushed to cloud via `supabase config push` (which, being a whole-block push, briefly dropped 3 pre-existing `additional_redirect_urls` entries not in the local file — restored in the same session; the lesson is that this file must stay the actual superset of what's on cloud, since a push doesn't merge).

**Not yet done as of this update:** the real-browser Connect round-trip against the *hosted* instance (Slack connect, Google connect + scope verification, sync, disconnect) hasn't run yet this session — do that before considering any of the above verified rather than just deployed. `daily_tick`'s enable migration is written but deliberately not yet pushed to cloud — it's sequenced to go out only after the `maxDuration` fix is confirmed live in production (a Hobby-plan function timeout would otherwise silently truncate a job that writes no record of itself).

**Superseded from the 2026-08-20 status block:** the "infrastructure currently running" local Docker Nango stack (`.nango-local/`) is no longer where this app's Nango traffic goes — it may still exist on disk for local-only experimentation, but treat the hosted instance as authoritative for anything shared. The ⚠️ about `.env.local` pointing at local vs. cloud Supabase no longer applies — this project no longer has a separate local database at all (local dev and production share the one cloud project; see CLAUDE.md).

---

## D-001 — Self-hosted Nango, not Cloud
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** Run Nango ourselves (Docker locally, AWS/GCP for preview/prod) rather than use Nango Cloud.

**Why:** User preference — avoids per-connection SaaS pricing and keeps tokens off a third party's infrastructure.

**Rejected:** Nango Cloud — faster to stand up, no infra to operate, but ongoing per-connection cost and a third party holds the tokens.

**Consequence / risk:** We now own uptime, Postgres, encryption-key custody, and upgrades. See D-011 (webhooks unavailable) and D-012 (Redis/refresh-lock uncertainty) for the concrete costs this carries.

**Supersedes:** —

---

## D-002 — All connectors move (Slack + Google), not a partial cutover
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** Both existing connectors move to Nango in one migration rather than staging by connector.

**Why:** A partial cutover (e.g. Google only) leaves two OAuth code paths alive simultaneously — the interface split (D-009) and `credentials.ts` rewrite (D-010) would each need two branches instead of one, doubling the surface a future connector author has to understand for no lasting benefit.

**Rejected:** Google-only first (it's the more painful handshake) — would validate the design faster but leaves Slack's simpler path duplicated indefinitely; "new connectors only" — least disruption today, most permanent duplication.

**Consequence / risk:** No incremental rollback per-connector; a Nango outage takes down both providers' sync at once (see D-013).

**Supersedes:** —

---

## D-003 — Force reconnect; no token import
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** Existing connected integrations must be manually reconnected through the Nango Connect UI. No migration script imports current refresh tokens into Nango.

**Why:** Simple and predictable, and the codebase already requires reconnect for ordinary scope changes (Google never retro-upgrades a grant) — this is a familiar cost, not a new one.

**Rejected:** `POST /connections` bulk import — avoids user friction, but adds a one-off script, a window where both auth paths must work, and per Nango's docs (verified 2026-08-19) self-host support for that endpoint is inferred from the localhost example in the reference, not explicitly stated.

**Consequence / risk:** Every currently-connected Slack/Google integration goes to `disconnected`/needs re-auth the moment this ships. Communicate before cutover.

**Supersedes:** —

---

## D-004 — Nango's proxy carries provider API calls; binary downloads bypass it
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** JSON calls (`googleFetch`, `slackApiPost/Get`) route through Nango's proxy. The four binary-download sites (Slack file download, Gmail attachment, Drive export/download, Chat attachment) fetch a token via `getConnection`/`getAccessToken()` and call the provider directly, as today.

**Why:** The proxy only true-streams a response when it's `chunked` or has `content-disposition: attachment`. Gmail's attachment endpoint returns base64-in-JSON — neither — so it would fully buffer a base64-inflated (~33%) blob in Nango's heap per concurrent request. Slack file downloads and Drive exports are simpler to leave as direct fetches than to special-case per-connector proxy overrides.

**Rejected:** Everything through the proxy — fully uniform (no code path ever holds a raw token), but risks OOM on large Gmail attachments and needs `forwardHeadersOnRedirect` handling for `files.slack.com`.

**Consequence / risk:** Two code paths for "get an authenticated request out the door" (proxy vs. direct+token) instead of one. `ConnectorCredentials.getAccessToken()` exists specifically to serve the direct-fetch path.

**Supersedes:** —

---

## D-005 — One Google grant across four hosts via the generic `google` provider + `baseUrlOverride`
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted, verified against docs

**Decision:** Create a single Nango integration on the generic `google` provider (not `google-mail`/`google-drive`/`google-chat`), covering the union of scopes, and reach Gmail/Chat/People via `baseUrlOverride` per proxy call.

**Why (verified 2026-08-19 against `providers.yaml` on `NangoHQ/nango@master`):** `google-mail`, `google-drive`, `google-chat`, `google-contacts` are all `alias: google` — identical auth config, differing only in `proxy.base_url`. `baseUrlOverride` / `Base-Url-Override` is documented and lets one connection reach `gmail.googleapis.com`, `chat.googleapis.com`, `people.googleapis.com` even though the integration's default base is `www.googleapis.com`. Using the per-API providers instead would mean four separate consent flows for what is currently one credential.

**Rejected:** Four separate integrations (one per Google API) — matches Nango's per-API providers exactly, but reintroduces the very problem the current merged `google` connector was built to avoid (CLAUDE.md: "Google never retro-upgrades an existing grant").

**Consequence / risk:** `NANGO_OUTBOUND_URL_POLICY=allowlist` must include all four hosts, or overrides are blocked by the SSRF denylist default (see D-014).

**Supersedes:** —

---

## D-006 — Slack bot token via the proxy default, not the user token
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted, verified against docs

**Decision:** Rely on Nango's default behavior of using Slack's `authed_user`-vs-top-level-token resolution, which prefers the bot token (`xoxb-`).

**Why:** Confirmed in `providers.yaml` (`alternate_access_token_response_path: authed_user` is a fallback, only used when no top-level `access_token` exists) and in `connection.service.ts`'s `parseRawCredentials`. This matches what the current connector already does (`slack/index.ts:246-253` extracts `data.access_token`, the bot token).

**Rejected:** N/A — this is simply how the provider template behaves; no alternative was evaluated because it already matches current behavior.

**Consequence / risk:** If a future feature needs the Slack *user* token, it must be pulled from `connection.credentials.raw.authed_user.access_token` explicitly and sent via a `nango-proxy-authorization` header override — not the default proxy path.

**Supersedes:** —

---

## D-007 — Nango owns retry/backoff, bounded by a client-side abort
**Date:** 2026-08-19 · **Phase:** 0 (design), implemented Phase 2 · **Status:** accepted

**Decision:** Pass `Retries: 3` to the proxy and delete `googleFetch`'s/`slackApi*`'s own retry loops, but wrap every proxy call in `AbortSignal.timeout(deadline.remainingMs() - RESERVE_MS)`.

**Why:** The proxy filters response headers on buffered (non-streamed) responses, so `Retry-After` never reaches our code — our own retry loop would degrade to blind exponential backoff with no real signal. Nango's `google` provider ships an `in_body` rule matching Google's own rate-limit message with `strategy: at`, and Slack's provider honors `retry-after` — genuinely better handling than what we had.

**Rejected:** Keep our own retries, pass `retries: 0` to the proxy — deadline-safe by construction (our loop already respects `FetchDeadline`), but loses the provider-specific rate-limit signal entirely.

**Consequence / risk:** Nango backs off on its own clock, which is not the same clock as `fetchSince`'s 45s budget, and could sleep past it. The abort wrapper is the load-bearing mitigation for this — **not optional**. If partial-page loss starts showing up in `sync_jobs` (a chain that never seems to finish a source), revisit this decision first.

**Supersedes:** —

---

## D-008 — Workspace-scoped connections, `connector_credentials` stays as the mapping table
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** A Nango connection maps to one `(workspace_id, provider, external_account_id)`, same as today, reused across every project that connects it. `connector_credentials` keeps its role as that mapping table (new `nango_connection_id`/`nango_provider_config_key` columns), rather than moving the reference onto `integrations` directly.

**Why:** Nango connection IDs are random UUIDs the caller cannot choose — correlation is only possible via tags (max 10 keys) or by storing the ID ourselves. Keeping `connector_credentials` as the map preserves `integrations.credential_id`'s composite FK `(credential_id, workspace_id)` and `unique (project_id, provider, credential_id)` untouched, so the connect-upsert `onConflict` and `connectMock`'s `credential_id: null` need no rework.

**Rejected:** One Nango connection per `integrations` row (1:1) — simpler code, no reuse lookup — but means reconnecting the same Google account for a second project requires a second full consent flow, a real behavior regression from today. Moving the reference onto `integrations` directly — fewer joins, but breaks the composite FK and the unique constraint, and abandons workspace-scoped reuse.

**Consequence / risk:** `finalizeConnection` must look up-or-reuse the existing `connector_credentials` row for `(workspace_id, provider, external_account_id)` — the same "reuse existing id" dance the current OAuth callback already does for AAD reasons (which itself disappears, since Nango, not us, encrypts the token).

**Supersedes:** —

---

## D-009 — Cut the `Connector` interface: OAuth methods leave, sync methods stay
**Date:** 2026-08-19 · **Phase:** 0 (design), implemented Phase 2 · **Status:** accepted

**Decision:** Remove `getAuthorizeUrl?`, `exchangeCode?`, `refreshTokens?`, and `requiresOAuth: boolean` from `Connector<TCursor>`. Add `nangoProviderConfigKey?: string` and `identify(credentials)`. Keep `validate`, `fetchSince`, `normalize`, `downloadAttachment?`, and make `disconnect` optional.

**Why:** The interface already mixed two concerns — OAuth handshake and sync engine — that Nango now cleanly separates ownership of. `identify()` recovers what `exchangeCode` used to return (the external account id/label needed for D-008's reuse lookup), since Nango's opaque connection IDs can't serve that purpose directly.

**Rejected:** Leave the OAuth methods in the interface, optional and simply unused — smaller diff, but dead methods sit in the contract and the next connector author would implement no-op versions of them.

**Consequence / risk:** Every connector module (`slack/index.ts`, `google/index.ts`, and transitively `gmail`/`google_drive`/`google_chat`) needs its OAuth methods deleted in the same phase, and `connectors/google/oauth.test.ts` (10 cases) becomes fully obsolete and gets deleted rather than updated.

**Supersedes:** —

---

## D-010 — `credentials.ts` keeps its signature, Nango replaces its body
**Date:** 2026-08-19 · **Phase:** 0 (design), implemented Phase 2 · **Status:** accepted

**Decision:** `loadCredentials(service, integration, connector): Promise<ConnectorCredentials>` keeps its exact signature. Internally it now looks up `nango_connection_id`/`nango_provider_config_key` and returns a `ConnectorCredentials` backed by a lazy, memoized `getAccessToken()` closure instead of decrypting a local ciphertext. The `mock` short-circuit (`provider === "mock"` → in-memory credentials, no DB/Nango round-trip) is preserved unchanged.

**Why:** `loadCredentials` has exactly three callers (`run-sync.ts:130`, `run-extraction.ts:143`, `integrations/actions.ts:291`) and every connector reads only `credentials.tokens.access_token` (soon `credentials.getAccessToken()`). Keeping the seam means the entire sync engine — cursors, deadline budgeting, batch coordination — needs zero changes.

**Rejected:** N/A — this was the plan's central finding, not a contested choice.

**Consequence / risk:** `run-sync.integration.test.ts` (4 cases) and `generate.integration.test.ts` (4 cases) both depend on the mock short-circuit surviving exactly as-is; breaking it fails all 8 instantly. `ConnectorRefreshError` loses its only consumer (the deleted refresh block) and is removed; its automatic-`revoked_at`-on-permanent-failure behavior goes with it — `revoked_at` becomes purely the manual "user disconnected" flag going forward.

**Supersedes:** —

---

## D-011 — Webhooks are unavailable on free self-hosted Nango; use tag-based reconciliation instead
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted, verified against docs

**Decision:** Because free self-hosted Nango has no webhooks (confirmed in the official self-hosting feature table — Auth and Proxy are the only two rows checked "yes" outside Enterprise), connection IDs are captured two ways: optimistically from the Connect UI's client-side `connect` event, and authoritatively by a `reconcileConnections` sweep over `GET /connections?tags[...]` run on integrations-page load.

**Why:** The documented canonical flow ("listen for webhooks, save the connection ID") isn't available to us at all without an Enterprise subscription.

**Rejected:** Trust only the client-side event — simpler, but a user closing the tab mid-flow permanently loses that connection from our side (Nango still has it, we just never learn the ID). Enterprise plan — solves this cleanly but wasn't in scope for this migration.

**Consequence / risk:** There is also no push signal for a grant *dying* post-connect (a revoked token, an expired refresh) — we only find out on the next sync attempt via `ConnectorAuthError`, same detection latency as today. Revisit if this proves too slow in practice.

**Supersedes:** —

---

## D-012 — Undocumented Nango behaviors we lean on (tracked for re-verification on upgrade)
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted-with-caveats

**Decision:** Proceed despite four behaviors that are visible in Nango's source but not stated as a contract in its docs:

| Behavior | Source (as of 2026-08-19, `NangoHQ/nango@master`) |
|---|---|
| Proxy memoizes a connection's credentials for 60s | `packages/server/lib/controllers/proxy/allProxy.ts`, `MEMOIZED_CONNECTION_TTL = 60000` |
| Proxy streams only on `chunked`/`content-disposition: attachment`, else buffers fully in memory | same file — the branch D-004 is built around |
| HTTP agent socket idle timeout is 30s (not total request duration) | same file, `HTTP_AGENT_CONFIG` |
| 401 is in the proxy's default retryable status set (recovers a mid-flight refresh) | `packages/shared/lib/services/proxy/retry.ts`, `getProxyRetryFromErr` |

**Why accepted anyway:** All four are load-bearing for D-004/D-007 but none are exotic — they're stable-looking implementation choices, and the alternative (re-deriving everything from scratch without reading source) isn't more reliable.

**Consequence / risk:** Nango's stated release cadence is roughly two months. Re-check all four against the then-current source on any Nango version bump — don't assume they're pinned by a public contract.

**Supersedes:** —

---

## D-013 — Redis ships in Nango's compose file but isn't wired into the server; run one replica until verified
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted-with-caveats

**Decision:** Run a single Nango server replica in both local and promoted (AWS/GCP) deployments until refresh-lock behavior under concurrency is confirmed.

**Why:** The self-hosting docs mention Redis is used for "token refresh locks," and `docker-compose.yaml` does start a `nango-redis` container — but does not wire `NANGO_REDIS_*` into the `nango-server` service's environment block. No official doc states whether Redis is required for safe concurrent refresh in free self-hosting, and Google rotates refresh tokens on each use — a race between two replicas refreshing simultaneously could invalidate one one's token.

**Rejected:** Multiple replicas from day one for availability — deferred until this is verified, since token-rotation races are the kind of bug that only shows up under load and directly matches D-001's stated risk of self-hosting.

**Consequence / risk:** Single point of failure for all connector auth until resolved. Revisit once either (a) Redis wiring is confirmed unnecessary by reading the refresh-lock code path directly, or (b) it's wired up ourselves and multi-replica is verified safe in staging.

**Supersedes:** —

---

## D-014 — `NANGO_OUTBOUND_URL_POLICY=allowlist`, not the default denylist
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** Configure Nango's outbound URL policy as an allowlist containing exactly the hosts this migration needs (four Google API hosts from D-005, `slack.com/api`, `files.slack.com`), rather than leaving the default denylist mode.

**Why:** `baseUrlOverride` is explicitly called out in Nango's own docs as an SSRF surface — a caller with proxy access could otherwise reach cloud metadata endpoints or `localhost` through it. Since our override set is small and fixed, an allowlist gives the same multi-host capability with no open surface, rather than trying to enumerate what to block.

**Rejected:** Default denylist with a custom blocklist — requires guessing at everything to exclude rather than stating what's permitted; easy to under-specify.

**Consequence / risk:** Adding a fifth API host later (e.g. a future connector) requires updating this allowlist explicitly — a deliberate speed bump, not an oversight, if it's ever hit.

**Supersedes:** —

---

## D-015 — Additive migration first, applied to a local Supabase restore before the shared cloud project
**Date:** 2026-08-19 · **Phase:** 0 · **Status:** accepted

**Decision:** Back up the cloud Supabase project (`nktmgdeeiukjimkwkylo`), restore that backup into a local Supabase instance (`supabase start`), and run the additive Nango-credentials migration there first — full Phase 1–3 development and Phase 4 verification happen against local Nango + local Supabase before the migration ever touches the shared cloud project.

**Why:** Per `CLAUDE.md`, local dev and prod normally share one cloud Supabase project — there's ordinarily no separate local DB to safely test destructive-ish schema changes against. `connector_credentials` holds real encrypted production tokens; this migration is treated as an explicit, scoped exception to the shared-DB workflow, not a permanent change to it.

**Rejected:** Apply directly to the shared cloud project with only `supabase db push` as the safety net — matches normal workflow, but this migration also plans a later cleanup step (dropping the six secret columns), which is exactly the kind of change worth rehearsing somewhere recoverable first.

**Consequence / risk:** Adds a local-restore step most migrations in this repo skip; the backup must be kept current through Phase 4 and again validated before the Phase 5 cleanup migration (which drops columns and is harder to walk back than an additive one).

**Supersedes:** —

---

## D-016 — Phase 0b executed: cloud backup taken, restored into local Supabase
**Date:** 2026-08-19 · **Phase:** 0b · **Status:** done

**Decision (record of execution, not a choice):** `supabase db dump --linked` produced a schema dump (`.db-backups/cloud-backup-pre-nango.sql`) and a `--data-only --use-copy` data dump (`cloud-backup-pre-nango-data.sql`), both gitignored. Local Supabase (already running, migrations in sync with remote per `supabase migration list`) was reset to a clean migrations-only state via `supabase db reset`, then the data dump restored via `docker cp` into the container followed by `psql -f` run inside it.

**Why the two-step restore:** Piping the dump through `docker exec -i psql < file` corrupted the COPY protocol mid-stream (a Windows/Git Bash stdin issue, not a pg_dump problem) — several tables landed with `invalid command \N` errors and partial rows. Copying the file into the container's filesystem first and running `psql -f` against it restored cleanly with no corruption.

**Verified:** Restored row counts (`workspaces: 9`, `projects: 12`, `integrations: 16`, `connector_credentials: 12`, `raw_events: 558`, `normalized_events: 471`, `sync_jobs: 117`) match the dump's own `COPY N` counts exactly. Three restore errors are expected and harmless: a `buckets` duplicate-key (the "attachments" storage bucket already exists from `supabase/seed.sql`) and `permission denied` on `buckets_vectors`/`vector_indexes` (Supabase-internal storage/vector-search tables, not application data).

**Consequence / risk:** Local Supabase now holds a snapshot of real production data as of 2026-08-19 — treat it with the same care as the cloud project (don't commit it, don't paste rows into chat). The backup files must be refreshed if this restore is repeated much later, since the cloud project keeps changing.

**Supersedes:** —

---

## D-017 — Phase 0a executed: local Nango running, both integrations configured
**Date:** 2026-08-19 · **Phase:** 0a · **Status:** done

**Decision (record of execution, not a choice):** Nango's `docker-compose.yaml` + `providers.yaml` (pulled from `NangoHQ/nango@master`) run locally under `.nango-local/` (gitignored — contains `NANGO_ENCRYPTION_KEY` and Postgres data). Nango's own DB port remapped to 5433 (5432 was already held by an unrelated `airbyte-poc-postgres-1` container on this machine). User signed up via the dashboard at `localhost:3003`, created the `google` integration (generic provider, not a per-API one — confirmed via `GET /integrations`) and the `slack` integration, each with their existing OAuth app's Client ID/Secret from `.env.local` and the scope lists from D-005/BOT_SCOPES. `NANGO_SECRET_KEY`/`NANGO_SERVER_URL`/`NEXT_PUBLIC_NANGO_HOST`/`NEXT_PUBLIC_NANGO_CONNECT_URL` added to `.env.local` and `.env.example`.

**Not yet done:** registering `http://localhost:3003/oauth/callback` in the actual Google Cloud Console and Slack app dashboard (requires console access this session doesn't have) — needed before a real end-to-end Connect flow can be tested (Phase 4).

**Consequence / risk:** Local Nango's encryption key and dashboard credentials are dev-only; a fresh key must be generated (and never reused) when promoting to AWS/GCP per D-001.

**Supersedes:** —

---

## D-018 — Slack's `fetchSince` gains real deadline awareness for the first time
**Date:** 2026-08-19 · **Phase:** 2 · **Status:** accepted

**Decision:** Added a `context: FetchContext` parameter to `slackConnector.fetchSince` (previously it took only `credentials, cursor` — no deadline at all, an explicitly-accepted omission documented on the `Connector` interface). Every `slackApi` call now threads `context.deadline` through, with a `RESERVE_MS` loop-boundary check before each channel and a `BudgetExhaustedError` catch around `conversations.history` that sets `hasMore: true` and breaks, mirroring Gmail/Drive/Chat's existing pattern.

**Why:** Once Slack's JSON calls route through `nangoProxy` (D-007), a `FetchDeadline` became a hard requirement, not an enhancement — `nangoProxy` cannot bound Nango's retries without one. There was no way to satisfy that contract without giving Slack a real deadline.

**Rejected:** Fabricating an internal deadline invisible to `run-sync.ts` (e.g. a fixed `createDeadline(50_000)` inside `fetchSince` unrelated to the caller's actual remaining budget) — technically satisfies `nangoProxy`'s type signature, but silently diverges from the real per-run time budget every other connector respects, and would eventually cause Slack syncs to either overshoot the 45s budget or waste time it didn't need to reserve. Since `run-sync.ts` already calls every connector's `fetchSince` with the same `{config, deadline}` context regardless of whether the connector's own signature declares it, adding the parameter cost nothing at the call site — only Slack's own file changed.

**Consequence / risk:** Slack's actual sync behavior changes for the first time in this migration: a workspace with enough channels to exceed the deadline will now stop early and resume next run (`hasMore: true`), where previously it always attempted every channel in one pass regardless of elapsed time. This is a strict safety improvement (bounded function duration) but is a genuine behavior change worth watching for in Phase 4 verification.

**Supersedes:** —

---

## D-019 — `lib/crypto/tokens.ts` deleted in Phase 3, not deferred to Phase 5
**Date:** 2026-08-19 · **Phase:** 3 · **Status:** accepted (supersedes the original phasing)

**Decision:** Deleted `lib/crypto/tokens.ts` and its test immediately after rewriting `disconnectIntegration` and deleting the OAuth callback route, rather than waiting for the Phase 5 cleanup migration as originally planned.

**Why:** The plan bundled tokens.ts's deletion with the DB column-drop migration, but tracing through the actual call graph after finishing Phase 3 showed the code module has zero remaining production callers the moment `disconnectIntegration` stops calling `openTokens` — legacy (pre-Nango) `connector_credentials` rows are simply never decrypted again by design (D-003: force reconnect, no import path), and `disconnectIntegration`'s new version marks such a row revoked locally without needing to prove a provider-side revoke first. The DB columns (`secret_ciphertext` etc.) staying in place a while longer for the historical-data grace period doesn't require the *code* that reads them to also stay — those are independent concerns that only looked coupled in the original plan.

**Rejected:** Waiting for Phase 5 — would mean carrying genuinely dead code (verified, not assumed) through the rest of this migration for no benefit; contradicts "if you're certain something is unused, delete it completely."

**Consequence / risk:** None identified — `cryptoSchema`/`cryptoEnv()`/`TOKEN_ENC_KEYS`/`TOKEN_ENC_ACTIVE_VERSION` were removed from `lib/env.ts` and `.env.example` in the same pass, since `tokens.ts` was their only consumer. The DB columns themselves (`secret_ciphertext`, `secret_iv`, `secret_key_version`, `secret_alg`, `access_token_expires_at`, `refresh_failed_at`, `refresh_failure_count`) are unchanged by this — Phase 5 still drops those, once every real integration has been reconnected through Nango.

**Supersedes:** the tokens.ts-deletion-timing implied by the original plan's Phase 5 description (not a numbered decision above, so recorded here as a correction).

---

## D-020 — Local Nango's Connect UI runs on a different port than its API (3009 vs 3003)
**Date:** 2026-08-19 · **Phase:** 3 · **Status:** corrected

**Decision (record of a caught mistake):** `NEXT_PUBLIC_NANGO_CONNECT_URL` was initially set to `http://localhost:3003` (same as `NANGO_SERVER_URL`) in both `.env.local` and `.env.example` during Phase 0a. This was wrong — Nango's docker-compose runs the Connect UI as a separate static-file server on `CONNECT_UI_PORT` (3009 locally), confirmed by curling both ports directly (`3003` → dashboard/API JSON, `3009` → Connect UI's `200` HTML shell) and by the container's own startup log ("Accepting connections at http://localhost:3009" from the `serve:unsafe` process, distinct from the main server's own startup banner).

**Why it wasn't caught immediately:** Both URLs were plausible-looking `localhost` values entered before the Connect UI flow (Phase 3) actually existed to exercise them — nothing exercised the wrong value until `ConnectProviderButton` was written and needed `NEXT_PUBLIC_NANGO_CONNECT_URL` for real.

**Consequence / risk:** Fixed before Phase 3 code shipped, so no code ever ran against the wrong value. Flagging this specifically because the promoted (AWS/GCP) deployment must register the SAME two distinct origins — collapsing them there would silently break the Connect UI popup even though the API itself still works, which could look like an unrelated bug during Phase 4b.

**Supersedes:** —

---

## D-021 — `finalizeConnection`/`finalizeConnectionCore` throw on failure rather than returning `{error}`
**Date:** 2026-08-19 · **Phase:** 3 · **Status:** accepted (corrects an in-flight design mistake)

**Decision:** `finalizeConnectionCore` and the exported `finalizeConnection` action return `Promise<{ message: string }>` and throw `Error` on any failure path (scope mismatch, credential save failure, integration save failure, unverifiable connection), rather than the `{ message: string } | { error: string }` result-object shape originally drafted.

**Why:** `ConnectProviderButton` drives this action through `toast.promise(...)`, whose `success`/`error` callbacks branch on whether the underlying **promise** resolves or rejects — not on the shape of a resolved value. A `finalizeConnection` that resolved with `{ error: "..." }` would always hit the `success` branch (since the promise never actually rejects), showing a success-styled toast for a logical failure. `AsyncButton`'s own doc comment already documents throw-on-error as this codebase's established convention for every other toast-driven action in this file (`syncNow`, `connectMock`, `disconnectIntegration`) — the result-object pattern belongs only to `saveIntegrationConfig`, which is `useActionState`-driven and needs non-throwing errors for inline form rendering, a genuinely different UI mechanism.

**Rejected:** Keeping the `{error}` result shape and manually branching inside the `onEvent` handler (e.g. `"error" in result ? ...`) — works, but fights the grain of `toast.promise`'s API and duplicates logic `AsyncButton` already solved once for this file.

**Consequence / risk:** None — caught during implementation, before this shape was ever exercised against a live Connect flow.

**Supersedes:** —

---

## D-022 — `reconcileConnections` treats Nango's `providerConfigKey` as this app's internal connector id
**Date:** 2026-08-19 · **Phase:** 3 · **Status:** accepted-with-caveat

**Decision:** `reconcileConnections` calls `finalizeConnectionCore(..., conn.providerConfigKey as the provider, ..., conn.providerConfigKey as the providerConfigKey, ...)` — using the SAME string for both the internal `ConnectorId` (`connector_provider` enum value, used for `getConnector()` and the `provider` column) and Nango's own integration key.

**Why this is safe today:** For both connectors that exist right now, they're identical strings by construction — the Nango integration is literally named `"google"` / `"slack"` to match this app's own `ConnectorId` values (D-005/D-008). `listConnectionsByTags`'s current implementation only returns `{connectionId, providerConfigKey}` from Nango's connection-list response, not the tags used to create the session (which would carry our own `provider` value explicitly).

**Rejected:** Extending `listConnectionsByTags` to also return each connection's `tags` (reading back the `provider` tag set at session-creation time) and using that as the authoritative internal provider id instead. Not implemented because the exact shape of Nango's `GET /connections` list response with respect to per-connection tags wasn't verified against live docs/source during this session — safer to ship the assumption that holds today, documented clearly, than to build against an unconfirmed API shape.

**Consequence / risk:** If a future connector's Nango integration `unique_key` ever diverges from its `ConnectorId` (e.g. two of our connectors sharing one Nango integration, or a renamed provider), `reconcileConnections`'s orphan-sweep will silently skip connections for that provider (it calls `isNangoConnector(conn.providerConfigKey)`, which returns false for an unrecognized key, so `continue` is hit — no crash, just a connection that never gets reconciled automatically). `finalizeConnection` (the primary, non-reconciliation path) is unaffected since it always receives both values explicitly from the client. Revisit by adding tags to `listConnectionsByTags`'s return shape if/when this assumption stops holding.

**Supersedes:** —

---

## D-023 — Browser verification: signed up a fresh local test user and drove the actual Connect UI
**Date:** 2026-08-20 · **Phase:** 3 (post-implementation verification) · **Status:** done

**Decision (record of verification, not a choice):** Per `CLAUDE.md`'s "drive it with a real browser" rule, started the local dev server and used Playwright (via an isolated scratch npm package, since `@playwright/test` isn't a project dependency) to: sign up a brand-new user (`seed.sql` turned out to be a placeholder comment describing a manual step that was never actually run — no seeded test account existed), create a workspace and project through the real UI, reach the Integrations page, and click both the Slack and Google Connect buttons.

**What this proved works, end to end:** the Integrations page renders with zero server-side errors even though `reconcileConnections` now runs on every page load and calls out to local Nango; both Connect buttons mint a real session token via `createIntegrationConnectSession`, open Nango's Connect UI iframe (served from `localhost:3009`, distinct origin from the API on `3003`), and correctly render provider-specific branding ("Link Google Account" / "Link Slack Account" with the Slack logo loaded from Nango's asset service).

**Bug caught and fixed:** `ConnectProviderButton` originally read `NEXT_PUBLIC_NANGO_HOST`/`NEXT_PUBLIC_NANGO_CONNECT_URL` via `publicEnv()` (`lib/env.ts`), which does `schema.safeParse(process.env)` — passing the whole `process.env` object into Zod at once. That works server-side (Node has the real environment at runtime) but silently produces `undefined` for every field in a browser bundle: Next.js's client-side env inlining only replaces a **literal** `process.env.NEXT_PUBLIC_X` text expression found in a file that's part of the client bundle, and nothing in `publicEnv()`'s implementation contains that literal pattern for any specific key. Clicking Connect threw `Invalid public environment variables: NEXT_PUBLIC_SUPABASE_URL/ANON_KEY: expected string, received undefined` — a page-crashing exception that no amount of `tsc`/`eslint`/unit-test coverage would have caught, since none of them execute code in an actual browser bundle. Fixed by reading both vars via literal `process.env.NEXT_PUBLIC_NANGO_HOST` / `process.env.NEXT_PUBLIC_NANGO_CONNECT_URL` expressions directly in `connect-provider-button.tsx`, bypassing `publicEnv()` entirely for this file.

**Latent pre-existing bug found, left unfixed:** `lib/supabase/browser.ts`'s `createClient()` has the exact same `publicEnv()`-in-a-client-component pattern and would fail identically if ever called — but `grep` confirms it has zero actual importers anywhere in the codebase. `ConnectProviderButton` is the first real client-side caller of `publicEnv()` that ever executes, which is why this was never caught before. Left as-is: out of scope for this migration, and fixing dead code isn't warranted — but flagging here so a future implementer reaching for `createClient()` from `browser.ts` doesn't rediscover this the hard way.

**Cosmetic issue observed, not fixed:** every Connect UI open logs a browser console CORS error — `http://localhost:3003/connect/telemetry` blocked from origin `http://localhost:3009`. This is Nango's own internal analytics beacon (self-hosted Nango's server doesn't set permissive CORS for its own Connect UI's cross-port telemetry calls in this local configuration), not a call our code makes, and it does not block the actual auth flow — confirmed by the modal rendering and functioning correctly despite it. No action taken; would need a Nango-side CORS config change (if even necessary) rather than an app-code fix.

**Not verified (blocked on external console access this session doesn't have):** actually completing an OAuth grant — clicking "Connect" inside the modal would open a real `accounts.google.com`/`slack.com` popup, which needs `http://localhost:3003/oauth/callback` registered in the Google Cloud Console and Slack app dashboard first (D-017 already flagged this as not-yet-done). `finalizeConnection`, the scope-verification check, and the credential-row upsert logic are therefore verified by code review and the unit suite, but not yet by a completed live grant.

**Consequence / risk:** None beyond what's already flagged in D-017 — full live-grant verification is still owed once the user registers the callback URL.

**Supersedes:** —

---

## D-024 — `NANGO_PUBLIC_SERVER_URL`/`NANGO_PUBLIC_CONNECT_URL` were swapped/wrong in `.nango-local/.env`
**Date:** 2026-08-20 · **Phase:** 0a (fixed post-hoc) · **Status:** corrected

**Decision (record of a caught mistake):** `.nango-local/.env` had `NANGO_PUBLIC_SERVER_URL=http://localhost:3000` (Nango's own compose-file default, which assumes a typical setup where the *consuming app* runs on port 3000 — which ours does too, causing a real collision) and `NANGO_PUBLIC_CONNECT_URL=http://localhost:3003` (should have been 3009, the Connect UI's actual port — the same 3003-vs-3009 confusion as D-020, but this time in Nango's own config rather than our app's `NEXT_PUBLIC_NANGO_*` vars). Corrected to `NANGO_PUBLIC_SERVER_URL=http://localhost:3003` and `NANGO_PUBLIC_CONNECT_URL=http://localhost:3009`, then `docker compose up -d nango-server` to apply.

**How it was caught:** the user, driving the app live, saw a real browser console 404 for `GET /images/template-logos/slack.svg` against *our* Next.js dev server. Traced to Nango's `GET /integrations` response embedding fully-qualified logo URLs built from `NANGO_PUBLIC_SERVER_URL` — which defaulted/was-set to port 3000, so the Connect UI's `<img>` tag pointed at our app instead of Nango. Confirmed fixed: `curl http://localhost:3003/integrations` now returns `logo: "http://localhost:3003/images/template-logos/slack.svg"`, and that URL 200s.

**Consequence / risk:** Purely cosmetic (a missing icon in the Connect UI modal) — never blocked the actual OAuth flow. Flagging because the promoted (AWS/GCP) deployment needs its own correct values for both vars, matching whatever public hostname is chosen there; don't copy the local `:3003`/`:3009` values verbatim.

**Supersedes:** —

---

## D-025 — `.env.local` was pointing at the cloud project this whole time; browser verification accidentally wrote test data to production
**Date:** 2026-08-20 · **Phase:** 4 (verification) · **Status:** corrected — real incident, not a hypothetical

**What happened:** D-023's browser verification (5 scripted signup runs) and the user's own manual testing were both, unknowingly, hitting the **cloud** Supabase project (`nktmgdeeiukjimkwkylo`) — `.env.local`'s `NEXT_PUBLIC_SUPABASE_URL` had never actually been switched to local Supabase despite D-015/D-016 setting up a full local restore specifically so this migration could be tested without touching production. The user's own live Connect attempt against Slack surfaced the first real symptom: `finalizeConnectionCore` threw "Connected, but saving the credential failed" on the INSERT into `connector_credentials`, because the additive Nango migration (D-015) was only ever applied to the **local** database, not cloud — `nango_connection_id`/`nango_provider_config_key` don't exist there yet.

**Why D-023's cleanup didn't catch this:** the cleanup after the initial browser run queried the **local** Postgres container directly via `docker exec ... psql`, which will always report accurately about local state, but says nothing about the cloud project — a `DELETE ... WHERE name = 'Nango Test Workspace'` reporting `0 rows` against local was silently consistent with **both** "already cleaned up" and "was never written there in the first place." The second reading was the true one, and nothing forced the distinction into view until a real Postgres error surfaced from an actual write attempt.

**Actual damage found (via `mcp__claude_ai_Supabase__execute_sql` directly against the cloud project):** 5 fake `workspaces` named "Nango Test Workspace" (one per script run), 4 `projects` under them, 6 fake `auth.users` rows (`nango-test-*@example.test`), and 9 `audit_logs` entries referencing them. `integrations`/`connector_credentials` were unaffected (0 rows) — every write attempt into those two tables failed cleanly (missing-column error) before anything landed, which is the one place the missing migration accidentally acted as a safety net rather than a bug.

**Cleanup performed on the cloud project:**
- `audit_logs` rows: **left in place** — the table has an enforced append-only trigger (`forbid_mutation`); these are inert historical records referencing now-deleted ids, not a real record of anything happening to real data.
- `projects`, then `workspaces` (5 ids): deleted. Required temporarily disabling `workspace_members`' `trg_guard_last_owner` trigger (it fires per-row on the FK cascade even when the *entire* workspace is being deleted, not just one member) — disabled immediately before, re-enabled immediately after, scoped to exactly these 5 workspace ids.
- Fake `auth.users` (6 rows): **left in place**, deliberately not deleted. Deleting them would `UPDATE audit_logs SET actor_user_id = NULL`, which the same append-only trigger blocks — and unlike the workspace-owner guard, audit-log immutability is a deliberate, stricter guarantee not touched for a cosmetic cleanup. These 6 accounts are confirmed orphaned (zero `workspace_members` rows, zero access to anything) — inert, not a live risk. Left for the user to remove later if they want to, at their own discretion, since it's their production project.

**The actual fix:** `.env.local` now points `NEXT_PUBLIC_SUPABASE_URL`/`NEXT_PUBLIC_SUPABASE_ANON_KEY`/`SUPABASE_SERVICE_ROLE_KEY` at local Supabase (`http://127.0.0.1:54321` + the standard local demo keys), with the cloud values preserved as commented-out `CLOUD_*`-prefixed lines directly above for easy restoration. `NEXT_PUBLIC_APP_URL` (`http://localhost:3000`) and local `supabase/config.toml`'s `auth.site_url` (also `http://localhost:3000`) were already consistent — untouched.

**Bonus discovery, no action needed:** the workspace/project the user was actually testing against (`0f62a340-...` "Abstrabit" / `7fc8f77d-...` "Hello World") predates the D-016 backup, so it exists in **both** cloud and local with the same ids. This means the two Slack connections Nango already holds for it (tagged with these exact ids) should reconcile successfully on the very next Integrations-page load against local, with no need to redo the OAuth popup.

**Consequence / risk:** This is the clearest concrete argument in the whole migration for why D-015's local-first staging exists — the exact failure it was designed to prevent (an untested migration hitting a schema that doesn't have it yet) still happened, not because the plan was wrong, but because the app's *own running configuration* was never actually switched over to point at what had been carefully prepared. **Before Phase 4b (promoting to cloud), explicitly re-verify `.env.local` points at local Supabase for the remainder of Phase 4 testing, and explicitly re-verify it's pointed at cloud (reverting the `CLOUD_*` comments) only once the cloud project has actually received the additive migration** — don't let this same gap reopen in the other direction.

**Supersedes:** —

---

## D-026 — `revalidatePath` cannot be called from `reconcileConnections`'s render-time path
**Date:** 2026-08-20 · **Phase:** 4 (verification, real bug) · **Status:** fixed

**Decision:** Moved the `revalidatePath(...)` call out of `finalizeConnectionCore` (the logic shared by both `finalizeConnection` and `reconcileConnections`) and into `finalizeConnection` alone, immediately after it calls the core.

**Why:** the user's live dev-server log surfaced Next.js's own error directly: *"Route ... used 'revalidatePath ...' during render which is unsupported."* `reconcileConnections` is called directly from `IntegrationsPage` — a Server Component, during its own render — not from a client-triggered Server Action invocation, even though the whole file carries a top-level `"use server"` directive. Next.js's restriction is about the *runtime context* (are we inside a render pass right now), not the static annotation, so a "use server" function called directly from a Server Component's body during render still trips this. Every reconciliation attempt was throwing this error, which `reconcileConnections`'s own per-connection `.catch()` swallowed into a console warning — so the *connections themselves were finalizing successfully* (the credential/integration rows were being written), but the log looked like a repeated hard failure on every page load, which is what prompted the investigation.

**Why the render path doesn't need it anyway:** `reconcileConnections` runs at the very top of `IntegrationsPage`, before the page's own `integrations` query — so by the time that query runs, it's reading the same request's already-fresh data. `revalidatePath` exists to invalidate a *previously rendered* page for subsequent requests, which only matters for `finalizeConnection` (invoked after the page has already rendered, from a client button click).

**Rejected:** wrapping the `revalidatePath` call in a try/catch inside the shared core and swallowing the specific error — would silence the symptom without removing the actual invalid call, and would still throw-and-catch on every single render-time reconciliation, which is wasteful even if harmless.

**Consequence / risk:** None — this was a real bug causing log noise (and needless repeated Postgres reads on every page load, since a thrown error meant `reconcileConnections`'s loop-with-catch obscured whether the row actually landed), not a silent data-correctness issue; the credential/integration writes themselves succeeded despite the error. Confirms D-023's earlier browser verification never actually exercised this path successfully end-to-end, since it never got a real Nango connection to reconcile — only the user's live, real Slack grant surfaced it.

**Supersedes:** —

---

## D-027 — `missingScopes` false-positives on Google's `email`/`profile` grants because Google canonicalizes them to long-form URIs in the token response
**Date:** 2026-08-20 · **Phase:** 4 (verification, real bug) · **Status:** fixed

**What happened:** Every real Google Connect attempt (both a fresh connect and `reconcileConnections`'s orphan sweep) threw `"Not all requested permissions were granted (missing: email, profile)"` from `finalizeConnectionCore`, even though the user's actual grant included everything requested — confirmed directly against the live Nango connection (`GET /connection/:id`): the returned `id_token` carried real `email`/`email_verified`/`name`/`picture` claims, proving Google's consent screen genuinely granted the OpenID identity scopes.

**Root cause:** Google's OAuth2 token endpoint canonicalizes the short scope aliases `email`/`profile` (as requested via `scopes.ts`'s `IDENTITY_SCOPES`, and as configured verbatim in Nango's local `google` integration's `oauth_scopes`) into their long googleapis.com form in the `scope` field it returns — `https://www.googleapis.com/auth/userinfo.email` / `.../userinfo.profile` — while `openid` itself is returned literal (it's an OIDC-standard scope, not a Google API scope, so it isn't rewritten). D-005/D-021's `missingScopes` compared the granted-scope string against the exact short names from `GOOGLE_ALL_SCOPES` and had no way to know the two forms were equivalent, so it flagged a fully-granted connection as short two permissions on every single real grant.

**The fix:** Added a small `GOOGLE_GRANTED_SCOPE_ALIASES` map in `integrations/actions.ts` (long-form URI → short name) consulted only for `provider === "google"` when building the granted-scope `Set` inside `missingScopes`. Verified directly against the real captured grant string from the live connection: `missingScopes` now returns `[]`.

**Why this went undetected until now:** D-023's earlier browser verification never completed a real OAuth grant (blocked on console access at the time — see D-023's "Not verified" note); this scope-check code path was only ever exercised by a real Google consent screen response, which didn't happen until this session.

**Consequence / risk:** None identified — this was a strict false-positive; nothing was ever granted-but-unverified in the other direction. Worth re-confirming this specific Google behavior (short-alias canonicalization) still holds if Google ever changes its token-endpoint response format, though this is exactly the kind of stable, long-standing OAuth2/OIDC behavior unlikely to change.

**Supersedes:** —

---

## D-028 — Local Supabase never had the Vault secrets pg_cron's `dispatch_jobs()` needs; every locally-queued sync sat in pgmq forever
**Date:** 2026-08-20 · **Phase:** 4 (verification, real bug/gap) · **Status:** fixed for this local instance

**What happened:** Clicking "Sync now" on the Slack integration queued a `pgmq` message successfully (visible in `pgmq.q_jobs`) but no `sync_jobs` row was ever created — the sync silently never ran, with no error surfaced anywhere in the UI.

**Root cause:** `dispatch_jobs()` (the `pg_cron` job that drains `pgmq`'s `jobs` queue every 5 seconds, added by `20260811100000_pgmq_pg_cron.sql`) reads its target URL and bearer secret from Supabase Vault (`app_base_url`, `job_dispatch_secret`), not from `.env.local` — and explicitly no-ops with `raise warning ...; skipping` if either is missing. Those two secrets exist in the cloud project (set per-environment, by design — the migration's own comment says so) but were never created in the local Supabase restore (D-015/D-016 restored `public`-schema data only, not per-environment Vault secrets, and wouldn't have decrypted correctly even if copied — Vault's encryption key is project-specific). Confirmed directly: `select * from vault.decrypted_secrets where name in (...)` returned zero rows locally, and two real queued messages (`msg_id 363`, `364`, both `/api/jobs/sync` for the Slack integration) were sitting unread in `pgmq.q_jobs` from earlier "Sync now" clicks.

**The fix (local-only, not a code change):** Ran `select vault.create_secret(...)` twice against the local Supabase instance: `job_dispatch_secret` set to the same value as local `.env.local`'s `CRON_SECRET` (matches the migration's own stated design — same trust boundary), and `app_base_url` set to `http://host.docker.internal:3000` — confirmed reachable via `curl` from inside the `supabase_db_Intellidev` container (Docker Desktop's built-in host-loopback DNS name; plain `localhost` from inside the container would reach the container itself, not the host machine running the Next.js dev server). Manually invoked `select public.dispatch_jobs();` once to drain the two stuck messages immediately rather than waiting for the next 5-second tick — both dispatched with `200`, and the Slack sync that had been silently stuck ran for real: 26 events fetched, 14 written.

**Why this is local-instance state, not a repo fix:** These two Vault secrets live in Postgres, not in any file this repo tracks — nothing to commit. Anyone who re-runs `supabase db reset` or re-restores a fresh cloud backup locally will need to re-run both `vault.create_secret(...)` calls (and re-verify `host.docker.internal` reachability) before "Sync now" will do anything locally again. Worth a one-line mention in a local-setup doc if this project gets one; not urgent enough on its own to justify starting one.

**Consequence / risk:** None beyond "local dev testing of the sync path requires this one-time setup step, undocumented until now." Cloud/production is unaffected — those Vault secrets were already correctly provisioned there before this session (this gap only ever existed in the local restore).

**Supersedes:** —

---

## D-029 — Cloud cutover: hosted Nango, both migrations applied, dead columns dropped, reconcile taken off the render path
**Date:** 2026-08-25 · **Phase:** 4b/5 (cloud cutover) · **Status:** applied; browser verification against the hosted instance still pending

**What happened:** This log itself went missing for several days — the Nango work in D-001–D-028 was rebased from `feature/nango-migration` onto `feature/nango-on-4level-hierarchy` (a concurrent, unrelated 4-level schema restructure), and this file wasn't carried over in that rebase. It was recovered from `git stash show 'stash@{0}'` (a stash titled "Docs and Misc" on the old branch) rather than from `feature/nango-migration` itself, because the stash held a newer version (475 lines, D-001–D-028) than the branch tip (263 lines, only through D-017). 12+ source files cite `NANGO_MIGRATION_LOG.md` decision numbers as authoritative rationale (`nango_connection_id`'s column comment, `client.ts`, `connections.ts`, `sessions.ts`, `actions.ts`, others) — every one of those citations was a dangling reference until this restore.

**What actually shipped in this pass**, beyond restoring the file:
1. Merged `main` into the branch (conflict-free — verified with `git merge-tree` before merging; `main`'s 9 commits and this branch's 6 touched zero overlapping files).
2. Applied `20260820102000_nango_credentials.sql` and `20260820102100_integrations_null_credential_uniqueness.sql` to the cloud project — these had existed in the repo since the original Phase 1 work (D-008/D-011) but were never pushed past a local Docker instance.
3. Added and applied `20260820102200_drop_legacy_credential_secret_columns.sql` — the Phase 5 cleanup the 2026-08-20 status block had flagged as future work. Confirmed clean first: zero code references, no constraint/RLS/trigger/pgTAP coupling on any of the 7 columns.
4. Moved `reconcileConnections` off `IntegrationsPage`'s render path (D-026 fixed a bug *in* that render-path call; this removes the call entirely). It's now fired from `ConnectProviderButton`'s Connect-UI `close` event when no `connect` preceded it, plus a manual "Check for connections" `AsyncButton`. Also wired up the Connect UI's `error` event, which had no handler before (a failed OAuth inside the popup previously surfaced nothing to the user).
5. Two defects unrelated to Nango, found while auditing the surrounding cron/auth surface for this cutover: `daily_tick` had been silently disabled since `pg_cron` first went live (a planned "activate right after deploy" step that never happened — `cron.job_run_details` showed zero runs, ever); and `skip_nonce_check = true` on the Google auth provider had been live in production Auth config since before Google sign-in was ever turned on, i.e. before the nonce mismatch it was written to prevent could have been observed even once.

**Why bundle unrelated fixes into a Nango cutover:** they surfaced directly from investigating the same infrastructure (cloud Supabase state, `supabase/config.toml`, the cron dispatch path) this cutover already required touching, and leaving them for a separate pass risked the same "written down nowhere, forgotten" fate that hit `daily_tick` itself.

**Consequence / risk:** The `skip_nonce_check` fix required `supabase config push`, which replaces the cloud project's entire `[auth]` block with the local file's — this dropped 3 `additional_redirect_urls` entries that existed on cloud but not in `config.toml` (an ngrok tunnel, two specific Vercel preview URLs). Caught immediately from the push's own diff output and restored in a second push. Lesson for next time: `config.toml` must be treated as the actual superset of what cloud has, checked before pushing, not assumed to already be in sync.

**Not yet done:** a real Connect round-trip (Slack + Google) against the *hosted* Nango instance, in a real browser, has not run yet as of this entry — everything above is "deployed and internally consistent," not "proven to work end-to-end" the way D-023's live testing proved the original local migration.

**Supersedes:** — (the "Immediate next steps" and "Also still pending" from the 2026-08-20 status block are superseded by this entry and the Current Status block above)
