@AGENTS.md

# Working on this project

Process notes accumulated while building this out — not style preferences, things that actually caused bugs or wasted time when skipped.

## Before calling any change done

Run in this order; don't stop at "it compiles":

1. `npx tsc --noEmit`
2. `npx eslint .`
3. `npm run build`
4. `npm run test` (unit — fast, no external deps)
5. If the change touches DB/service/connector/LLM logic: `npm run test:integration` (hits the real cloud Supabase project and, for the LLM suite, the real Anthropic API) and `npx supabase test db` (pgTAP, local Docker instance)
6. For anything user-facing, drive it with a real browser against the running dev server (Playwright) — code review alone has repeatedly missed things that only showed up when actually clicked (Server Action closures that can't cross the RSC boundary, toasts that never fire, dialogs that don't reappear after a state change). Screenshot on failure, not just a pass/fail line.

Don't consider a fix verified because "it should work now" — reproduce the original failure, apply the fix, reproduce again and confirm it's gone.

## Local dev environment

- Local dev and production point at the **same cloud Supabase project** (`nktmgdeeiukjimkwkylo`) — there is no separate local database anymore. Anything written locally is real production data.
- Always browse at `http://localhost:3000`, matching `NEXT_PUBLIC_APP_URL` and Supabase Auth's redirect allow-list exactly. A host mismatch (`localhost` vs `127.0.0.1`) breaks the PKCE cookie for OAuth and produces a generic, unhelpful `auth_callback_failed`.
- `.env.local`'s secrets — especially `TOKEN_ENC_KEYS` — must match whatever Vercel's production env has, since both environments decrypt rows from the same database. A mismatch fails with a GCM auth-tag error that looks like tampering but is just a key mismatch.
- Cookies accumulate across heavy local sign-in/sign-out/OAuth testing (Supabase's `@supabase/ssr` chunks the session JWT across numbered cookies and doesn't always clean up orphaned chunks). A `431 Request Header Fields Too Large` error means clear cookies for the site, not a code bug.

## Deploying

- `git push origin main` auto-deploys via Vercel's GitHub integration — no manual `vercel --prod` needed.
- Vercel project is on the **Hobby plan**: cron jobs can only run once/day (a `*/15 * * * *` schedule fails deployment outright), and function `maxDuration` caps at 60s — set `export const maxDuration = 60` on any route that calls Slack or Anthropic.
- New Vercel env vars are **write-only by default** ("sensitive") — once set, they can never be read back via CLI or dashboard, not even by the owner. If a value needs to be reused later (e.g. a generated secret), it has to be remembered from when it was generated, not fetched back from Vercel.
- After deploying, confirm with a real check (`curl` the live URL, or a Playwright run against it) — don't infer success from the CLI's exit code alone.

## Next.js App Router gotchas that actually bit us

- A Server Action passed as a prop to a Client Component must be the action itself or `.bind(null, ...)` of it — never a fresh arrow-function wrapper (`() => action(...)`). The wrapper isn't recognized as a serializable action reference and throws "Functions cannot be passed directly to Client Components" at runtime, not at build time.
- `redirect()` inside a Server Action only reliably triggers a navigation when the action is invoked via a real `<form action={...}>` submit. Calling that same action directly from client code (for a toast/pending-state pattern) is fine for actions that don't redirect, but keep redirecting actions on a form.

## Debugging

- Get the real underlying error before proposing a fix — add temporary logging, read the dev server log file, or query the database directly. Don't guess from symptoms alone (a wrong first diagnosis this session cost a round-trip that a five-minute log check would have skipped).
- To run a one-off script against real server-only code (services, the service-role Supabase client) outside Next's own build: `NODE_OPTIONS="--conditions=react-server" npx tsx script.mts` — this satisfies the `server-only` package's guard the same way Next's bundler does, and lets `@/`-aliased imports resolve via `tsx`'s tsconfig-paths support.
- Never echo secret values back in chat, even when quoting file contents that contain them.

## Git

- Commit in logically segregated chunks (by feature/phase/concern), not one giant diff — makes the history reviewable and bisectable.
- Never commit `.env.local` or any file containing a real secret.
- Never open a PR automatically. Committing and pushing a branch is fine on request, but `gh pr create` requires the user's explicit go-ahead first, every time — not implied by an earlier approval.

## Slack connector specifics

- A bot being "added to a channel" via Slack's app-install UI is **not** the same as the bot user actually joining that channel. `conversations.history` only works for channels where `conversations.list`'s `is_member` field is true, which requires an explicit `/invite @bot-name` for channels the bot wasn't OAuth-scoped to auto-join.
- OAuth scopes must be added in both places: the code's requested-scopes list (`src/connectors/slack/index.ts`) and the Slack app's own dashboard (OAuth & Permissions → Bot Token Scopes). An already-connected workspace needs an explicit disconnect + reconnect for a newly-added scope to actually land on its token — editing the code alone doesn't retroactively upgrade an existing grant.

## Google connector specifics (one `google` connector: Gmail + Drive + Chat)

- **These are one connector, not three.** `connectors/google/index.ts` is the only registered Google connector; `connectors/{gmail,google_drive,google_chat}/` still exist and still own all their own fetch/normalize logic, but they're now *delegated to*, not registered. One OAuth grant, one `connector_credentials` row, one `integrations` row, one `integration_cursors` row (three sub-cursors nested inside it), and one config object `{gmail, drive, chat}` where `null` means that sub-service is off. `fetchSince` splits the single 45s budget across whichever sub-services are enabled and rotates which one goes first (`lastPriorityService`) so a service that keeps exhausting the budget can't starve the others.
- **Security tradeoff, accepted deliberately:** the combined consent screen requests Gmail + Drive + Chat scopes together, so one credential row now grants read access to mail *and* files *and* chat. The blast radius of a leaked/compromised `connector_credentials` row is correspondingly wider than under the old three-grant design, and a user who only wants Gmail synced still has to approve Drive and Chat scopes at connect time (enabling/disabling a service in the config form controls what's *fetched*, not what's *granted*). This was chosen over three parallel grants because Google never retro-upgrades an existing grant — under the old design, ticking on a second service meant a full disconnect + reconnect every time.
- Since `provider` is written verbatim from the integration, **every** Gmail/Drive/Chat event now lands in `raw_events`/`normalized_events` as `provider='google'`. `normalize()` stamps `metadata.service` (`"gmail"|"drive"|"chat"`) — that tag is the *only* thing that still distinguishes them, and the provider badges + Data-page connector chips read it. Don't drop it.
- Pre-merge `gmail`/`google_drive`/`google_chat` rows are left alone (their enum values stay in `connector_provider` forever, their events stay queryable). `getConnector()` throws for those providers by design; the Integrations page detects them and renders a "this connector has moved — reconnect as Google" banner instead of a sync button.
- One OAuth app (`GOOGLE_CONNECTOR_CLIENT_ID/SECRET`, distinct from `GOOGLE_OAUTH_CLIENT_ID/SECRET`, which is Supabase Auth *sign-in* and never read by this app directly) and one callback route (`src/app/api/oauth/[provider]/callback/route.ts`). Console setup: enable the Gmail/Drive/Chat **and People** APIs (People is easy to miss — it's not one of the three "connector" APIs, but Chat's sender-name resolution needs it; see below), create a **Web application** OAuth client, publish the consent screen **Internal** to the Workspace org, and register `{origin}/api/oauth/google/callback` for every origin you run this app at (exact match required). The old per-service redirect URIs (`.../api/oauth/{gmail,google_drive,google_chat}/callback`) are no longer used.
- `access_type=offline` + `prompt=consent` are both load-bearing on the authorize URL (`src/connectors/google/oauth.ts`). Without `access_type=offline`, Google never returns a `refresh_token` and the integration dies ~60 minutes after connect. Without `prompt=consent`, a *reconnect* (same Google account, same app, same scopes) skips the consent screen and also comes back with no `refresh_token` — Google only issues one on the very first grant per (user, client, scope-set).
- **Same lesson as Slack, different mechanism**: a scope added to `connectors/google/scopes.ts` does not retroactively upgrade an already-connected grant. Disconnect + reconnect is required, and `exchangeGoogleCode` deliberately throws `MISSING_SCOPES` (surfaced on the Integrations page) rather than silently storing a credential that's missing something it will need later.
- `include_granted_scopes` is still intentionally never set, even now that the scope list is combined. The merged connector asks for exactly the union it needs, explicitly, in one request — leaving `include_granted_scopes` off keeps that list the *whole* truth about what a token can do, instead of silently accreting whatever else that Google account happened to grant this client earlier.
- Google Chat's `spaces.messages.list` under **user auth** only sees spaces the connected account is already a member of (Slack's "bot must be invited" lesson, same shape) — and per Google's own `User` resource docs, `sender.displayName` comes back empty on the message itself (only `name`/`type` populated). `connectors/google_chat/directory.ts` resolves it separately via one batched People API `people:batchGet` call per sync, using the `directory.readonly` scope — a Chat integration connected before that scope existed needs a disconnect + reconnect before names resolve (see the scope-retroactivity note above). Sender resolution degrades to the raw `users/<id>` string on any failure (missing scope, org restricts the Directory API, non-HUMAN sender, **or the People API just isn't enabled in the Cloud project** — confirmed in practice: this fails with a plain 403 `SERVICE_DISABLED`, distinct from a scope problem, and needs enabling separately from Gmail/Drive/Chat since it isn't one of the three "connector" APIs) — it must never be able to fail a sync. Toggleable per-integration via the "Resolve sender names" config field.
- Google Drive intentionally uses `files.list` with a `modifiedTime` floor, not `changes.list` — see the doc comment in `connectors/google_drive/index.ts` for why (`changes.list` has no folder-scoped filter and its bootstrap doesn't bound well against a once-a-day cron). `corpora=allDrives` must never be used anywhere in this connector — Google documents `orderBy` as unsupported under it, and this connector's whole resume-safety story depends on `orderBy=modifiedTime` actually being honored.

