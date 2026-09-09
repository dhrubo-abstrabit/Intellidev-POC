# One database, two migration histories

Both halves of this repo talk to the **same** Supabase database, and each owns a different
schema. Nothing at the root hints at that, which is the only reason this file exists.

| Schema | Owned by | Changed with | Migrations live in |
| --- | --- | --- | --- |
| `public.*` — the product tables, their RLS and functions | this app | `npm run db:migrate` (`supabase db push`) | `supabase/migrations/` |
| `runner.*` — everything the control plane adds | `control-plane/` | `pnpm db:migrate` (drizzle) | `control-plane/db/migrations/` |

`public.tasks` is the one table both touch: the control plane adds three defaults and one policy
to it, by agreement, in `control-plane/db/migrations/0001_tasks_dispatchable.sql`.

## The rule

**Run each migration command from its own directory, and never point one at the other's
migrations.** The two histories are independent — Supabase's own bookkeeping table and drizzle's
`__drizzle_migrations` — and the Supabase CLI assumes a single repo owns a database. Repairing or
resetting one history to make the other's command happy is what erases the other's record of what
has been applied.

`control-plane/db/README.md` has the long version, including why `supabase db push` cannot be run
from the control plane side and what it does if you try.

## Where the schema is right now

The live database is at control-plane migration **0007**, which is ahead of anything the
`main` history of that repo described until this import. If you clone this repo fresh and run
`pnpm db:migrate` from `control-plane/`, it will find nothing to do — which is correct. If it
instead tries to apply all eight, the journal at
`control-plane/db/migrations/meta/_journal.json` has been lost or truncated; restore it rather
than letting the migrations re-run.
