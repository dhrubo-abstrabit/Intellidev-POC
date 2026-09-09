import { defineConfig } from 'drizzle-kit'

/**
 * Migrations are hand-written SQL in `db/migrations`, applied by `pnpm db:migrate`.
 *
 * `drizzle-kit generate` is deliberately NOT used to author them. This database is shared:
 * another repo owns the 29 `public.*` product tables and already has its own Supabase
 * migration history, so generating from a schema definition would produce a migration that
 * tries to create tables which already exist. What the schema needs — RLS policies,
 * `SECURITY DEFINER` helpers, `GRANT`/`REVOKE` — is not expressible here either.
 *
 * So Drizzle stays the typed query layer and the *migrator*, while the SQL is written by
 * hand. `pnpm db:new <name>` uses `generate --custom` purely to create an empty file and its
 * journal entry.
 *
 * See `db/README.md` for who owns which objects, and why this repo must never run
 * `supabase db push`.
 */
export default defineConfig({
  schema: './src/store/schema.ts',
  out: '../../../db/migrations',
  dialect: 'postgresql',
  // Read at generate time only. Applying is a separate, explicit step.
  dbCredentials: { url: process.env['SUPABASE_CONNECTION_STRING_SESSION'] ?? '' },
  strict: true,
  verbose: true,
})
