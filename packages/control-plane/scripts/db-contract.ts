#!/usr/bin/env node
/**
 * Checks the authorization contract against a live database.
 *
 * `db:verify` runs the same assertions against a local replay, which catches a migration that
 * breaks them. This catches the other direction: someone changing a helper function in the
 * database we actually depend on. Nothing in the repo changes when that happens, so no test
 * or diff would notice — this is the only thing that does.
 *
 * Read-only, and safe to run on a schedule.
 */
import { readFileSync } from 'node:fs'
import pg from 'pg'

function connectionString(): string {
  const explicit = process.env['SUPABASE_CONNECTION_STRING_SESSION']
  if (explicit) return explicit
  const env = readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
  const value = env
    .split('\n')
    .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
    ?.split('=')
    .slice(1)
    .join('=')
    .trim()
    .replace(/^["']|["']$/g, '')
  if (!value) throw new Error('SUPABASE_CONNECTION_STRING_SESSION is not set')
  return value
}

// The file is written for psql, so its meta-commands have to go before pg sees it.
const sql = readFileSync(new URL('../../../db/contract.sql', import.meta.url), 'utf8')
  .split('\n')
  .filter((line) => !line.trimStart().startsWith('\\'))
  .join('\n')

const pool = new pg.Pool({
  connectionString: connectionString(),
  max: 1,
  ssl: { rejectUnauthorized: false },
  connectionTimeoutMillis: 20_000,
})

try {
  const client = await pool.connect()
  // The check reports through RAISE NOTICE, which only surfaces if we listen for it.
  client.on('notice', (n) => console.log(`  ${n.message}`))
  try {
    await client.query(sql)
    console.log(`  against ${new URL(connectionString()).hostname}`)
  } finally {
    client.release()
  }
} catch (error) {
  // The exception message carries which functions drifted and what to do about it, so it is
  // printed as-is rather than wrapped in a stack trace.
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
  await pool.end()
  process.exit(1)
}

await pool.end()
