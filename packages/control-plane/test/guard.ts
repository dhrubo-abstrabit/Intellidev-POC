/**
 * Refuses to run destructive store tests against a database that is not ours to wipe.
 *
 * This exists because of a near-miss. `PostgresStore.truncateAll()` issues
 * `truncate table tasks cascade` against an unqualified name, which resolves through
 * `search_path` to whatever `tasks` the connected database has. Pointing
 * `SUPABASE_CONNECTION_STRING_SESSION` at the shared Supabase project made that
 * `public.tasks` — the product's own table, with CASCADE — so `pnpm test` would have
 * truncated it. It happened to be empty, so nothing was lost, but the suite was one populated
 * table away from deleting another team's data.
 *
 * A schema-qualified store fixes the specific bug. This guard fixes the class: no matter what
 * a query resolves to later, a destructive test refuses to touch a database that shows signs
 * of belonging to someone else.
 *
 * Detection is by *presence of the product schema*, not by connection string. Anyone can
 * mistype a host; nobody accidentally grows 29 product tables.
 */
import pg from 'pg'

/** Tables that only ever exist in the shared product database. */
const PRODUCT_MARKERS = ['client_spaces', 'tenant_members', 'normalized_events', 'llm_runs']

/**
 * Why a destructive suite must not run here, or undefined if it may.
 *
 * Returns a reason rather than throwing, so the caller can *skip* with an explanation instead
 * of failing. That matters because pointing at the shared project is now the ordinary
 * development configuration: a suite that fails on every run trains people to ignore red,
 * and the first thing anyone would do is delete the guard. A named skip keeps the warning
 * visible without crying wolf.
 *
 * `INTELLIDEV_ALLOW_DESTRUCTIVE_TESTS=1` overrides, for a throwaway database deliberately
 * restored from a product dump. An environment variable rather than a parameter, so it is a
 * visible decision made at the shell and not something a test file can grant itself.
 */
export async function unsafeToWipeReason(connectionString: string): Promise<string | undefined> {
  if (process.env['INTELLIDEV_ALLOW_DESTRUCTIVE_TESTS'] === '1') return undefined

  const pool = new pg.Pool({
    connectionString,
    max: 1,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 20_000,
  })
  try {
    const { rows } = await pool.query<{ table_name: string }>(
      `select table_name from information_schema.tables
        where table_schema = 'public' and table_name = any($1)`,
      [PRODUCT_MARKERS],
    )
    if (rows.length > 0) {
      return (
        `${safeHost(connectionString)} holds the product schema ` +
        `(${rows.map((r) => r.table_name).join(', ')}); these tests truncate tables and an ` +
        `unqualified name can resolve into public. Point ` +
        `SUPABASE_CONNECTION_STRING_SESSION at a scratch database, or set ` +
        `INTELLIDEV_ALLOW_DESTRUCTIVE_TESTS=1 to wipe this one on purpose.`
      )
    }
    return undefined
  } finally {
    await pool.end()
  }
}

/** The host, for a message that must never carry the password. */
function safeHost(connectionString: string): string {
  try {
    return new URL(connectionString).host
  } catch {
    return 'the configured database'
  }
}
