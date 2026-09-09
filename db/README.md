# Database

One Postgres database, **two owners**. Getting this wrong corrupts someone else's migration
history, so the rule comes first:

| Objects                                                  | Owned by                    | Changed how                                    |
| -------------------------------------------------------- | --------------------------- | ---------------------------------------------- |
| `public.*` — the 29 product tables, their RLS, functions | **another repo**            | by them, via the Supabase CLI                  |
| `runner.*` — everything this system adds                 | **the control plane**       | `db/migrations/`, applied by `npm run runner:db:migrate` from the repository root |
| `public.tasks` — three defaults and one policy           | **this repo, by agreement** | `0001_tasks_dispatchable.sql`                  |

## Why not `supabase db push`

The remote database already has a Supabase migration history — 21 entries, `20260827055815`
through `20260901001800` — written by the repo that owns the product schema. The Supabase CLI
assumes a single repo owns a database, so pushing from here fails with
`LegacyDbPullMigrationConflictError` and its suggested fix (`migration repair --status
reverted`) would erase their bookkeeping and make their next push try to re-apply all 21
migrations against objects that already exist.

So this repo keeps **its own migration history**, in `drizzle.__drizzle_migrations`, entirely
separate from `supabase_migrations.schema_migrations`. Two histories are safe here **only
because the object sets are disjoint** — we create `runner.*` and never `public.*`. The single
exception is `0001`, which touches `public.tasks`; it is deliberately isolated in its own file
so it can be reviewed, or handed to the other team to apply from their side instead.

Do not add anything to `public` in this repo without agreeing it with them first.

## `baseline/product-schema.sql`

A **read-only snapshot**, not a migration. It is never applied by anything here — it is
committed so that this repo can be read, reviewed and reasoned about without database access,
and so a schema change on their side shows up as a diff in review.

Refresh it with:

```sh
pnpm db:baseline
```

That runs `supabase db dump` against the remote and rewrites the file. If the diff is large,
something changed underneath us and the `runner.*` policies that call their helper functions
are worth re-reading.

## Migrations

Hand-written SQL, because what this schema needs — RLS policies, `SECURITY DEFINER`
functions, `GRANT`/`REVOKE` — is not expressible in a Drizzle schema definition. Drizzle is
still the query layer and still the _migrator_; `drizzle-kit generate` is not used.

```sh
pnpm db:status     # what is applied, what is pending — for both owners
pnpm db:migrate    # apply pending migrations
pnpm db:new <name> # create the next empty migration + journal entry
pnpm db:verify     # rebuild the whole database in Docker and assert the result
```

Applying is deliberate, never automatic on boot: with more than one control-plane instance a
rolling deploy would have several racing to alter the same tables.

### Migrations must be idempotent

Write every migration so it converges rather than assuming absence: `DROP POLICY IF EXISTS`
before `CREATE POLICY`, `ADD COLUMN IF NOT EXISTS`, `DROP CONSTRAINT IF EXISTS` before adding
one.

This is not a style preference. `pnpm db:baseline` snapshots the **live** schema, so as soon as
a migration touching `public` has been applied, the committed baseline contains its effects —
and `db:verify`, which replays baseline then migrations, then fails with "already exists". The
first version of `0001` did exactly that.

The end state is what matters, and `db/verify/checks.sql` is what asserts it. A migration you
can re-run is also one you can recover with.

Session-mode pooler only (port 5432). The migrator holds a transaction and an advisory lock
for its duration and neither survives transaction-mode pooling — `db:migrate` refuses port
6543 rather than half-applying.

### `db:verify`

Rebuilds everything from nothing in a throwaway `supabase/postgres` container — prelude,
committed baseline, every migration in journal order, seed, then assertions — and exits
non-zero on any failure. Run it before pushing a migration.

It catches the class of mistake that `pnpm test` cannot: a migration that applies cleanly but
is still wrong. Each assertion has been mutation-tested, so none of them is decorative —
dropping the composite foreign key, granting `authenticated` access to `credentials`, deleting
the `tasks_insert` policy, dropping the scope `CHECK`, disabling RLS on a table, or removing
one of the three defaults each make it fail.

It is also the only thing proving that `baseline/product-schema.sql` plus
`verify/prelude.sql` is a _complete_ description of the database. The dump omits everything
outside `public`, so the prelude has to stand up `auth.users`, `auth.uid()`,
`extensions.pgcrypto`, `extensions.citext` and `public.vector` by hand — every one of them
was found by this script failing, not by reading the dump. If the other team adds a dependency we do not
know about, this is what tells us.

Not part of `pnpm check`, because it needs Docker and takes about a minute. `KEEP=1` leaves the
container running so you can inspect it.

## How authorization works

This repo does not reimplement the tenancy model. Every `runner.*` policy calls the product's
own helpers, so access stays consistent with the rest of the database:

| Helper                          | Returns                                                                    |
| ------------------------------- | -------------------------------------------------------------------------- |
| `current_client_space_ids()`    | spaces the user belongs to                                                 |
| `current_project_ids()`         | `visibility='space'` projects in those spaces ∪ explicit `project_members` |
| `manageable_client_space_ids()` | space admin ∪ workspace admin ∪ tenant owner                               |
| `manageable_project_ids()`      | projects in manageable spaces ∪ `project_members` with `role='member'`     |

Reads use `current_*`, writes use `manageable_*` — the convention their own policies follow.

**Two identities reach these tables, and only one is governed by RLS:**

- **A person** presents a Supabase JWT. The control plane verifies it, then runs the query as
  `set local role authenticated` with `request.jwt.claims` set, so RLS applies exactly as it
  does for the product. A forgotten check fails closed.
- **A run container** presents a run token, not a JWT — it is not a user. Those requests run as
  the service role and bypass RLS by design; the credential broker performs the scope checks
  instead (repo must be in `project_repos`, MCP server must be in `task_specs.mcp_server_ids`,
  harness must match the task).

`runner.credentials` and `runner.run_tokens` have RLS enabled and **no policies at all**, so no
JWT can read them under any circumstances. Only the broker's service-role connection can.
