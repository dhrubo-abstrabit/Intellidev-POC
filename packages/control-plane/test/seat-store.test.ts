import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { PostgresStore } from '../src/store/postgres.js'
import { LocalSecretCipher } from '../src/secrets/cipher.js'
import type { HarnessAccount } from '../src/harness/accounts.js'

/**
 * Connections one test store may hold.
 *
 * Supabase's session pooler allows fifteen per project, and these suites open two or three
 * stores each — at the production default of five that is the whole budget, and the symptom is
 * `(EMAXCONNSESSION) max clients reached` appearing as thirty unrelated test failures.
 */
const TEST_POOL = 2

/**
 * Harness seats, stored in the database with their material encrypted.
 *
 * The seat was a JSON file under the work root. That is correct for one process on one laptop
 * and wrong for everything after: a hosted control plane loses every login on each deploy, and a
 * second instance cannot see what the first connected. These tests are mostly about the
 * properties that make the move safe rather than about whether it round-trips.
 */
function connectionString(): string | undefined {
  const explicit = process.env['SUPABASE_CONNECTION_STRING_SESSION']
  if (explicit) return explicit
  try {
    return readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith('SUPABASE_CONNECTION_STRING_SESSION='))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const dsn = connectionString()
/**
 * The project the tests own, which is not the one anyone dispatches into.
 *
 * Its client space is what seats attach to. Wiping seats in the project someone is using would
 * disconnect their harness mid-session.
 */
const testProjectId = process.env['INTELLIDEV_TEST_PROJECT_ID']

const SEAT: HarnessAccount = {
  harness: 'claude-code',
  label: 'Claude Code (test)',
  env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-live-should-never-be-readable' },
  files: [{ path: '.claude/.credentials.json', contents: '{"refresh":"also-secret"}' }],
  connectedAt: '2026-08-28T00:00:00.000Z',
  importedFrom: 'a test',
}

if (!dsn || !testProjectId) {
  const why = !dsn ? 'no SUPABASE_CONNECTION_STRING_SESSION' : 'no INTELLIDEV_TEST_PROJECT_ID'
  describe.skip(`postgres seat store (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
} else {
  describe('postgres seat store', () => {
    async function withStore<T>(
      body: (args: {
        seats: ReturnType<PostgresStore['seats']>
        scope: { clientSpaceId: string }
        store: PostgresStore
      }) => Promise<T>,
    ): Promise<T> {
      const store = new PostgresStore({ connectionString: dsn!, maxConnections: TEST_POOL })
      try {
        const project = await store.findProject(testProjectId!)
        if (!project) throw new Error(`project ${testProjectId} is not in this database`)
        const scope = { clientSpaceId: project.clientSpaceId }
        const seats = store.seats(new LocalSecretCipher('seat-store-test'))
        try {
          return await body({ seats, scope, store })
        } finally {
          // Seats are space-scoped, and this space is shared with the development project, so
          // leaving one behind would show up as a harness nobody connected.
          await seats.remove(scope, 'claude-code')
        }
      } finally {
        await store.close()
      }
    }

    it('round-trips a seat through the database', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        const material = await seats.material(scope, 'claude-code')
        expect(material).toEqual({
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-live-should-never-be-readable' },
          files: [{ path: '.claude/.credentials.json', contents: '{"refresh":"also-secret"}' }],
        })
      })
    })

    it('stores no plaintext credential anywhere in the row', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        const pool = new pg.Pool({
          connectionString: dsn!,
          max: 1,
          ssl: { rejectUnauthorized: false },
        })
        try {
          // Both tables, as text, because the point is that nothing readable survives.
          const dump = await pool.query(
            `select i.settings::text s, i.display_name, i.ref, c.ciphertext, c.wrapped_key
               from runner.integrations i
               left join runner.credentials c on c.integration_id = i.id
              where i.client_space_id = $1 and i.kind = 'harness'`,
            [scope.clientSpaceId],
          )
          const text = JSON.stringify(dump.rows)
          expect(text).not.toContain('sk-live-should-never-be-readable')
          expect(text).not.toContain('also-secret')
        } finally {
          await pool.end()
        }
      })
    })

    it('lists names and paths without ever returning a credential', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        const [listed] = await seats.list(scope)
        // Names only and paths only. A listing does now decrypt — that is how it can say whether
        // a seat is readable rather than merely present — but the plaintext is discarded and
        // never reaches a caller, which is what matters for a response the browser receives.
        expect(listed?.envVars).toEqual(['CLAUDE_CODE_OAUTH_TOKEN'])
        expect(listed?.files).toEqual(['.claude/.credentials.json'])
        expect(listed?.importedFrom).toBe('a test')
        // The token itself is nowhere in what a listing returns.
        expect(JSON.stringify(listed)).not.toContain('sk-live-should-never-be-readable')
      })
    })

    it('is visible to a second instance, which is the whole reason for moving it', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        // A separate store and pool, standing in for another control-plane process.
        const other = new PostgresStore({ connectionString: dsn!, maxConnections: TEST_POOL })
        try {
          const material = await other
            .seats(new LocalSecretCipher('seat-store-test'))
            .material(scope, 'claude-code')
          expect(material).toEqual(await seats.material(scope, 'claude-code'))
        } finally {
          await other.close()
        }
      })
    })

    it('reports a seat as unreadable when it cannot be decrypted', async () => {
      /**
       * FOUND BY LOOKING AT THE UI. The seat panel showed a green "connected" dot for a
       * credential sealed under a key no longer in use — a row existing was taken for a working
       * credential, so the only way to discover it was a run failing at the first model call.
       *
       * A rotated key and a wrong passphrase both produce this state, and neither is an expired
       * token: the fix is to sign in again, and the UI can only say so if `list` tells it.
       */
      await withStore(async ({ seats, scope, store }) => {
        await seats.connect(scope, SEAT)
        expect((await seats.list(scope))[0]?.readable).toBe(true)

        const wrongKey = store.seats(new LocalSecretCipher('a-different-master-key'))
        const listed = await wrongKey.list(scope)
        // Still listed — a person needs to see it in order to replace it — but not connected.
        expect(listed).toHaveLength(1)
        expect(listed[0]?.readable).toBe(false)
        // And the metadata still renders, because it was never encrypted.
        expect(listed[0]?.files).toEqual(['.claude/.credentials.json'])
      })
    })

    it('refuses to open a seat sealed under a different key', async () => {
      await withStore(async ({ seats, scope, store }) => {
        await seats.connect(scope, SEAT)
        // What a rotated or wrong KMS key looks like from here.
        const wrongKey = store.seats(new LocalSecretCipher('a-different-master-key'))
        await expect(wrongKey.material(scope, 'claude-code')).rejects.toThrow(/could not open/)
      })
    })

    it('replaces a seat rather than accumulating them', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        await seats.connect(scope, { ...SEAT, env: { CLAUDE_CODE_OAUTH_TOKEN: 'second' } })
        expect(await seats.list(scope)).toHaveLength(1)
        expect(await seats.material(scope, 'claude-code')).toMatchObject({
          env: { CLAUDE_CODE_OAUTH_TOKEN: 'second' },
        })
      })
    })

    it('takes the credential with it when the seat is removed', async () => {
      await withStore(async ({ seats, scope }) => {
        await seats.connect(scope, SEAT)
        expect(await seats.remove(scope, 'claude-code')).toBe(true)
        expect(await seats.has(scope, 'claude-code')).toBe(false)
        // Material must not outlive the integration that explains it.
        expect(await seats.material(scope, 'claude-code')).toBeUndefined()
      })
    })
  })
}
