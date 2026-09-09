# One database, two migration histories

Both halves of this repo talk to the **same** Supabase database, and each owns a different
schema. Nothing about the layout says so, which is the only reason this file exists.

| Schema | Owned by | Migrations | Apply with |
| --- | --- | --- | --- |
| `public.*` — the product tables, their RLS and functions | the Next app | `supabase/migrations/` | `npm run db:migrate` (`supabase db push`) |
| `runner.*` — everything the control plane adds | `control-plane/` | `db/migrations/` | `npm run runner:db:migrate` |

Both migration folders are at the repository root on purpose. They were a level apart when the
control plane was imported, and the two commands differed only by which directory you happened
to be standing in.

`public.tasks` is the one table both touch: the control plane adds three defaults and one policy
to it, by agreement, in `db/migrations/0001_tasks_dispatchable.sql`.

## The one thing that will lose data

**`supabase db reset` rebuilds the database from `supabase/migrations` only.** It knows nothing
about `db/migrations`, so a reset drops every `runner.*` table with it — runs, events, stage
templates, artifacts and their version history.

`npm run db:reset` targets the **local** dev database, which is safe and is what it is for.
Adding `--linked` points the same destruction at the shared remote. Don't.

If a reset does happen, recovery is `npm run runner:db:migrate` to rebuild the schema — the
tables come back empty. The rows do not come back.

## The other rule

The two histories are independent: Supabase's own bookkeeping table, and drizzle's
`__drizzle_migrations`. The Supabase CLI assumes one repo owns a database, so pushing from the
wrong side reports a conflict and its suggested repair erases the other side's record of what has
already been applied. `db/README.md` has the long version, including what `supabase db push`
does if you run it against the runner history.

## Where the schema is now

The live database is at control-plane migration **0007**. A fresh clone running
`npm run runner:db:migrate` should find nothing to do — that is correct. If it instead tries to
apply all eight, the journal at `db/migrations/meta/_journal.json` has been lost or truncated:
restore it rather than letting the migrations re-run.
