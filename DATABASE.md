# One database, one migration history

Both halves of this repo talk to the **same** Supabase database and each owns a schema:

| Schema                                                   | Owned by         | Notes                               |
| -------------------------------------------------------- | ---------------- | ----------------------------------- |
| `public.*` — the product tables, their RLS and functions | the Next app     | exposed through the API             |
| `runner.*` — everything the control plane adds           | `control-plane/` | reached only by a direct connection |

Both are migrated the same way, from the same place:

```
npm run db:migrate          # supabase db push — applies everything pending
npm run db:new <name>       # supabase migration new — an empty file to write by hand
```

`supabase/migrations/` holds all of them, in one order. The control plane's are the ones with
`_runner_` in the name — `20260905000000_runner_schema.sql` onward — and that naming is load
bearing in one place: the GitHub workflows filter on `supabase/migrations/*_runner_*.sql`, so a
product migration does not run control-plane CI. There is a test for it.

`public.tasks` is the one table both touch: the control plane adds three defaults and one policy
to it, by agreement, in `20260905000100_runner_tasks_dispatchable.sql`.

## Why the runner's migrations are all dated after the product's

They were applied over several weeks and their real dates interleave with the product's. Dating
them that way would sort `runner` migrations _before_ the product migrations creating the tables
they reference, and a rebuild from scratch would fail on the first foreign key. So they all carry
timestamps after the last product migration, which is the order that actually works.

## It used to be two histories

Until 2026-09-09 the control plane kept its own migrations in `db/migrations/` with its own
bookkeeping table (drizzle's `__drizzle_migrations`), because it was developed as a separate
repository. That meant two commands, and `supabase db reset` — which knows only about
`supabase/migrations/` — would drop every `runner.*` table without a way to bring the rows back.

Merging them is what removed that. The eight migrations moved into `supabase/migrations/`, and
because the live database is long past them they have to be recorded as applied rather than run
again — a one-time step against the remote:

```
supabase migration repair --status applied \
  20260905000000 20260905000100 20260905000200 20260905000300 \
  20260905000400 20260905000500 20260905000600 20260905000700 \
  --db-url "$SUPABASE_CONNECTION_STRING_SESSION"
```

**Run this before the next `npm run db:migrate`.** Until it is done, a push sees eight pending
migrations and tries to create a schema that already exists: it fails on the first statement,
which is loud and harmless, but there is no reason to meet it. Nothing else about the merge
touches the database — the files moved, the bookkeeping did not.

If a fresh clone ever reports those eight as pending against the live database, this is the fix,
not a re-run.

## Verifying

`supabase/verify/` holds what the control plane checks about the database rather than about the
repo:

- `contract.sql` — pins the four `public` functions every `runner` policy delegates to. They can
  be redefined with `CREATE OR REPLACE`, which changes who can see every runner table and raises
  nothing. `npm run runner:db:contract` runs this against the live database.
- `checks.sql`, `seed.sql` — assertions about a rebuilt database, and the rows they need.

`npm run db:verify` runs all of it against a local stack: `supabase db reset` to replay every
migration from scratch, then the seed, the checks and the contract. That is now an honest test of
the whole history — it used to be impossible, because the runner's half was not part of it.

It replaced a harness that replayed a committed _dump_ of the product schema instead. The dump
was a 0-byte file, so the harness had not run in weeks, and one of its assertions had drifted
unnoticed: it still expected 7 runner tables when the artifacts migrations had made it 10. It now
names the tables it expects rather than counting them, since "no new tables" was never the
invariant.
