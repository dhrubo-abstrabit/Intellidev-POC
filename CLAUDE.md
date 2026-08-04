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
- Every commit ends with the `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>` trailer.
- Never commit `.env.local` or any file containing a real secret.

## Slack connector specifics

- A bot being "added to a channel" via Slack's app-install UI is **not** the same as the bot user actually joining that channel. `conversations.history` only works for channels where `conversations.list`'s `is_member` field is true, which requires an explicit `/invite @bot-name` for channels the bot wasn't OAuth-scoped to auto-join.
- OAuth scopes must be added in both places: the code's requested-scopes list (`src/connectors/slack/index.ts`) and the Slack app's own dashboard (OAuth & Permissions → Bot Token Scopes). An already-connected workspace needs an explicit disconnect + reconnect for a newly-added scope to actually land on its token — editing the code alone doesn't retroactively upgrade an existing grant.

