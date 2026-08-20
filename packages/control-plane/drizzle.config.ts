import { defineConfig } from 'drizzle-kit'

/**
 * Migrations live in this repo, as SQL, generated from `src/store/schema.ts`.
 *
 * Deliberately not applied through the Supabase MCP or dashboard: that would create a
 * second migration history, and two systems each believing they own the schema is how a
 * migration gets applied twice or skipped. The repo is the source of truth; Supabase is
 * where it is applied.
 */
export default defineConfig({
  schema: './src/store/schema.ts',
  out: './drizzle',
  dialect: 'postgresql',
  // Read at generate time only. Applying is a separate, explicit step.
  dbCredentials: { url: process.env['SUPABASE_CONNECTION_STRING_SESSION'] ?? '' },
  strict: true,
  verbose: true,
})
