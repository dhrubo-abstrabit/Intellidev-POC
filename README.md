# Intellidev

A "project brain" SaaS: connect your team's tools (Slack today; Google Chat/Drive and ClickUp are stubbed for later), sync activity continuously, and let an LLM turn that activity into a daily list of action items, risks, blockers, and updates — scoped per project, with a real-time dashboard on top.

## Stack

- **Next.js 16** (App Router, Turbopack) + **React 19** + TypeScript
- **Supabase** — Postgres + Auth (email/password + Google OAuth) + Row Level Security
- **Tailwind + shadcn/ui** (on [Base UI](https://base-ui.com), not Radix)
- **Upstash QStash** — job queue for sync + LLM runs; **Vercel Cron** for the scheduled tick
- **Claude Haiku 4.5** (`@anthropic-ai/sdk`) — structured-output action-item generation with prompt caching
- **Vitest** — unit tests (`*.test.ts`) and DB/API integration tests (`*.integration.test.ts`, run separately)

## Getting started

You'll need: a Supabase project, an Upstash QStash account, a Slack app, and an Anthropic API key. Copy `.env.example` to `.env.local` and fill it in — see the comments in that file for where each value comes from. Google OAuth is optional; leave it unset and `auth.external.google.enabled = false` in `supabase/config.toml` if you don't want it.

```bash
npm install

# Link the CLI to your Supabase project, then push the schema:
npx supabase link --project-ref <your-project-ref>
npx supabase db push
npx supabase config push        # pushes supabase/config.toml's [auth] settings (redirect URLs, providers)
npm run db:types                # regenerate src/lib/db/database.types.ts if the schema changes

npm run dev                     # http://localhost:3000
```

Browse at `http://localhost:3000` specifically (not `127.0.0.1`) — it has to match `NEXT_PUBLIC_APP_URL` and Supabase's Auth redirect allow-list exactly, or OAuth logins will fail. See `CLAUDE.md` for why.

## Scripts

| Command | What it does |
|---|---|
| `npm run dev` | Local dev server |
| `npm run build` | Production build |
| `npm run test` | Unit tests — fast, no external services |
| `npm run test:integration` | Integration tests — hits the real Supabase project and (for the LLM suite) the real Anthropic API |
| `npm run db:migrate` | `supabase db push` — apply local migrations to the linked project |
| `npm run db:types` | Regenerate `database.types.ts` from the linked project's schema |
| `npm run db:types:check` | Diff generated types against what's checked in, without overwriting |
| `npx supabase test db` | pgTAP schema/RLS tests against the local Docker instance |

## How it fits together

```
connectors/          Connector<TCursor> interface + Slack/mock implementations — the only
                      thing the sync engine calls, so adding a provider is additive.
services/sync/        fetch → raw_events → normalize → normalized_events → cursor advance
services/action-items/ normalized_events → Claude Haiku 4.5 → action_items (merged by title hash)
app/api/jobs/*         QStash-invoked routes (signature-verified) that run the two services above
app/api/cron/tick      Vercel Cron entry point — publishes one QStash job per integration due for sync
app/(app)/w/.../p/     Per-project dashboard: Overview, Action Items, Activity, Integrations
supabase/migrations/   Ordered schema + RLS + grants — see the header comments for why grants are
                      tracked separately from RLS policies (they're two independent locks)
```

## Deploying

Push to `main` — Vercel's GitHub integration auto-deploys. Env vars live in Vercel's dashboard (Production environment), not in this repo. If you change `supabase/config.toml`'s `[auth]` block, run `npx supabase config push` separately — that's a Supabase-side change, not something a Vercel deploy picks up.

## Working with this repo

`CLAUDE.md` has the accumulated process notes — verification checklist, environment quirks, and the specific mistakes that cost time when skipped. Worth reading before making changes.
