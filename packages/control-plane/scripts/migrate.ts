#!/usr/bin/env node
/**
 * Applies the SQL migrations in `drizzle/` to the configured database.
 *
 * Explicit rather than automatic on boot: a control plane that migrated at startup would,
 * with more than one instance, have several racing to alter the same tables during a
 * rolling deploy. Migrating is a deliberate step someone runs and reads the output of.
 *
 * Runs against the **session-mode** pooler. Drizzle's migrator holds a transaction and an
 * advisory lock for the duration, neither of which survives transaction-mode pooling.
 */
import { readFileSync } from 'node:fs'
import { drizzle } from 'drizzle-orm/node-postgres'
import { migrate } from 'drizzle-orm/node-postgres/migrator'
import pg from 'pg'

function connectionString(): string {
  const explicit = process.env['SUPABASE_CONNECTION_STRING_SESSION']
  if (explicit) return explicit
  // Read from .env rather than requiring a loader: this is a one-off operator script, and
  // the alternative is a dependency whose only job is reading one line.
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
    throw new Error(
      'SUPABASE_CONNECTION_STRING_SESSION is not set, in the environment or in .env. ' +
        'Use the session-mode pooler (port 5432); transaction mode cannot hold the ' +
        "migrator's advisory lock.",
    )
  }
  return value
}

const url = connectionString()
const port = new URL(url).port
if (port === '6543') {
  // Failing loudly beats a migration that half-applies because its lock was handed away.
  throw new Error(
    'refusing to migrate over the transaction pooler (port 6543): the migrator needs a ' +
      'session. Use SUPABASE_CONNECTION_STRING_SESSION (port 5432).',
  )
}

const pool = new pg.Pool({
  connectionString: url,
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

try {
  const started = Date.now()
  await migrate(drizzle(pool), {
    migrationsFolder: new URL('../drizzle', import.meta.url).pathname,
  })
  console.log(`migrate: applied in ${Date.now() - started} ms against ${new URL(url).hostname}`)
} finally {
  await pool.end()
}
