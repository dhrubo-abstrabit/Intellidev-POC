#!/usr/bin/env node
/**
 * What is applied and what is pending — for both owners of this database.
 *
 * Two migration histories exist here: ours in `drizzle.__drizzle_migrations`, and the product
 * schema's in `supabase_migrations.schema_migrations`, written by another repo. Showing both
 * is the point. If someone runs `supabase db push` from this repo, or a migration lands on
 * their side that changes a helper function our policies call, this is where it becomes
 * visible rather than surfacing as a policy that silently stops matching.
 *
 * Read-only. It creates nothing and applies nothing.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import pg from 'pg'

const MIGRATIONS_DIR = new URL('../../../../db/migrations', import.meta.url).pathname

function connectionString(): string {
  const explicit = process.env['SUPABASE_CONNECTION_STRING_SESSION']
  if (explicit) return explicit
  const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  const line = env
    .split('\n')
    .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
  const value = line
    ?.split('=')
    .slice(1)
    .join('=')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!value) {
    throw new Error('SUPABASE_CONNECTION_STRING_SESSION is not set, in the environment or .env')
  }
  return value
}

/**
 * The hash Drizzle records for a migration.
 *
 * Recomputed here rather than trusted, so an edited-after-applying migration shows up as
 * changed. That is worth catching: the file in the repo would no longer describe the database.
 */
function hashOf(tag: string): string {
  const sql = readFileSync(`${MIGRATIONS_DIR}/${tag}.sql`, 'utf8')
  return createHash('sha256').update(sql).digest('hex')
}

interface JournalEntry {
  readonly idx: number
  readonly tag: string
  readonly when: number
}

const journal = JSON.parse(readFileSync(`${MIGRATIONS_DIR}/meta/_journal.json`, 'utf8')) as {
  entries: JournalEntry[]
}

// A .sql file with no journal entry would never be applied, which is a silent kind of wrong.
const onDisk = readdirSync(MIGRATIONS_DIR)
  .filter((f) => f.endsWith('.sql'))
  .map((f) => f.replace(/\.sql$/, ''))
  .sort()
const orphaned = onDisk.filter((tag) => !journal.entries.some((e) => e.tag === tag))

const pool = new pg.Pool({
  connectionString: connectionString(),
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

try {
  const applied = await pool
    .query<{ hash: string; created_at: string }>(
      'select hash, created_at from drizzle.__drizzle_migrations order by created_at',
    )
    .catch(() => ({ rows: [] as Array<{ hash: string; created_at: string }> }))

  const appliedHashes = new Set(applied.rows.map((r) => r.hash))

  console.log('\n  runner migrations (this repo)\n')
  if (journal.entries.length === 0) console.log('    none')
  for (const entry of journal.entries) {
    const hash = hashOf(entry.tag)
    const state = appliedHashes.has(hash)
      ? 'applied'
      : // Applied under a different hash means the file changed after it ran, so the repo and
        // the database disagree about what this migration says.
        applied.rows.length > entry.idx
        ? 'CHANGED SINCE APPLIED'
        : 'pending'
    console.log(`    ${String(entry.idx).padStart(4, '0')}  ${state.padEnd(22)}${entry.tag}`)
  }

  for (const tag of orphaned) {
    console.log(`    ----  NOT IN JOURNAL        ${tag}  (will never be applied)`)
  }

  /**
   * The product schema's history, for information only.
   *
   * Never written from here. If this list grows, someone changed `public.*` and the helper
   * functions our policies depend on are worth re-reading — `pnpm db:baseline` will show what
   * moved.
   */
  const theirs = await pool
    .query<{ version: string; name: string | null }>(
      'select version, name from supabase_migrations.schema_migrations order by version',
    )
    .catch(() => null)

  if (theirs) {
    console.log(`\n  product schema (another repo, read-only here) — ${theirs.rows.length} applied`)
    const last = theirs.rows.slice(-3)
    for (const row of last) console.log(`    ${row.version}  ${row.name ?? ''}`)
    if (theirs.rows.length > last.length)
      console.log(`    (${theirs.rows.length - last.length} earlier)`)
    console.log('\n  Never run `supabase db push` from this repo — see db/README.md')
  }
  console.log('')
} finally {
  await pool.end()
}
