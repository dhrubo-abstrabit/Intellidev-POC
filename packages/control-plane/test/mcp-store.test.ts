import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import pg from 'pg'
import { PostgresStore } from '../src/store/postgres.js'
import { LocalSecretCipher } from '../src/secrets/cipher.js'
import type { McpServerRecord } from '../src/mcp/types.js'

/**
 * Connected MCP servers, stored per project with their tokens encrypted.
 *
 * The refresh lock is the reason this work exists. Two runs dispatched together both notice the
 * same stale access token and both POST the same refresh token; Atlassian and Asana treat the
 * second POST as replay under RFC 6819 §5.2.2.3 and revoke the whole token family — a permanent
 * disconnect needing manual re-authorisation, not a retryable error. A map keyed by server id
 * prevents that inside one process and does nothing across two.
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
const testProjectId = process.env['INTELLIDEV_TEST_PROJECT_ID']

const SERVER: McpServerRecord = {
  id: 'linear',
  name: 'Linear',
  url: 'https://mcp.linear.app/mcp',
  auth: 'oauth2',
  health: 'ok',
  tools: ['create_issue', 'search_issues'],
  toolCount: 2,
  oauth: {
    authorizationServerUrl: 'https://linear.app',
    clientId: 'client-123',
    scope: 'read write',
    accessToken: 'at-should-never-be-readable',
    refreshToken: 'rt-should-never-be-readable',
    clientSecret: 'cs-should-never-be-readable',
    expiresAt: '2026-12-31T00:00:00.000Z',
  },
}

if (!dsn || !testProjectId) {
  const why = !dsn ? 'no SUPABASE_CONNECTION_STRING_SESSION' : 'no INTELLIDEV_TEST_PROJECT_ID'
  describe.skip(`postgres mcp store (skipped: ${why})`, () => {
    it('is skipped', () => {})
  })
} else {
  describe('postgres mcp store', () => {
    async function withStore<T>(
      body: (args: {
        mcp: ReturnType<PostgresStore['mcp']>
        scope: { clientSpaceId: string; projectId: string }
        store: PostgresStore
      }) => Promise<T>,
    ): Promise<T> {
      const store = new PostgresStore({ connectionString: dsn!, maxConnections: 3 })
      try {
        const project = await store.findProject(testProjectId!)
        if (!project) throw new Error(`project ${testProjectId} is not in this database`)
        const scope = { clientSpaceId: project.clientSpaceId, projectId: project.projectId }
        const mcp = store.mcp(new LocalSecretCipher('mcp-store-test'))
        try {
          return await body({ mcp, scope, store })
        } finally {
          await mcp.remove(scope, SERVER.id)
        }
      } finally {
        await store.close()
      }
    }

    it('round-trips a server with its tokens', async () => {
      await withStore(async ({ mcp, scope }) => {
        await mcp.upsert(scope, SERVER)
        const read = await mcp.get(scope, 'linear')
        expect(read?.oauth?.accessToken).toBe('at-should-never-be-readable')
        expect(read?.oauth?.refreshToken).toBe('rt-should-never-be-readable')
        expect(read?.oauth?.clientSecret).toBe('cs-should-never-be-readable')
        // And the metadata a refresh needs before it decrypts anything.
        expect(read?.oauth?.clientId).toBe('client-123')
        expect(read?.tools).toEqual(['create_issue', 'search_issues'])
      })
    })

    it('stores no token in the clear', async () => {
      await withStore(async ({ mcp, scope }) => {
        await mcp.upsert(scope, SERVER)
        const pool = new pg.Pool({
          connectionString: dsn!,
          max: 1,
          ssl: { rejectUnauthorized: false },
        })
        try {
          const rows = await pool.query(
            `select i.settings::text s, c.ciphertext, c.wrapped_key
               from runner.integrations i
               left join runner.credentials c on c.integration_id = i.id
              where i.project_id = $1 and i.kind = 'mcp'`,
            [scope.projectId],
          )
          const text = JSON.stringify(rows.rows)
          for (const secret of ['at-should-never', 'rt-should-never', 'cs-should-never']) {
            expect(text).not.toContain(secret)
          }
          // But the client id and expiry must be readable: a refresh needs them first.
          expect(text).toContain('client-123')
        } finally {
          await pool.end()
        }
      })
    })

    it('listing returns metadata without tokens, so a page load decrypts nothing', async () => {
      await withStore(async ({ mcp, scope }) => {
        await mcp.upsert(scope, SERVER)
        const [listed] = await mcp.list(scope)
        expect(listed?.name).toBe('Linear')
        expect(listed?.oauth?.accessToken).toBeUndefined()
        expect(listed?.oauth?.refreshToken).toBeUndefined()
      })
    })

    it('preserves tokens when the UI re-submits a server without them', async () => {
      await withStore(async ({ mcp, scope }) => {
        await mcp.upsert(scope, SERVER)
        // What a rename looks like: no credentials in the body.
        await mcp.upsert(scope, {
          id: 'linear',
          name: 'Linear (renamed)',
          url: SERVER.url,
          auth: 'oauth2',
          health: 'ok',
        })
        const read = await mcp.get(scope, 'linear')
        expect(read?.name).toBe('Linear (renamed)')
        // A replace would have silently logged the server out.
        expect(read?.oauth?.refreshToken).toBe('rt-should-never-be-readable')
      })
    })

    it('drops the credential when a server no longer has one', async () => {
      await withStore(async ({ mcp, scope }) => {
        await mcp.upsert(scope, SERVER)
        await mcp.patch(scope, 'linear', { auth: 'none', token: undefined, oauth: undefined })
        const pool = new pg.Pool({
          connectionString: dsn!,
          max: 1,
          ssl: { rejectUnauthorized: false },
        })
        try {
          const rows = await pool.query(
            `select count(*)::int c from runner.credentials c
               join runner.integrations i on i.id = c.integration_id
              where i.project_id = $1 and i.kind = 'mcp'`,
            [scope.projectId],
          )
          // A server switched away from OAuth must not keep a token nobody can see.
          expect(rows.rows[0]?.c).toBe(0)
        } finally {
          await pool.end()
        }
      })
    })

    /**
     * The lock, tested across two stores standing in for two instances.
     *
     * Serialisation is asserted by *overlap*: if the second holder entered while the first was
     * inside, the windows would intersect. Timing is the only observable, so the first holder
     * waits long enough that an unserialised second would demonstrably overlap rather than
     * merely appear to.
     */
    it('serialises a refresh across instances', async () => {
      const a = new PostgresStore({ connectionString: dsn!, maxConnections: 2 })
      const b = new PostgresStore({ connectionString: dsn!, maxConnections: 2 })
      try {
        const project = await a.findProject(testProjectId!)
        if (!project) throw new Error('project missing')
        const scope = { clientSpaceId: project.clientSpaceId, projectId: project.projectId }
        const cipher = new LocalSecretCipher('mcp-store-test')

        const events: string[] = []
        const first = a.mcp(cipher).withServerLock(scope, 'linear', async () => {
          events.push('a:in')
          await new Promise((resolve) => setTimeout(resolve, 800))
          events.push('a:out')
        })
        // Started after a short delay so the first has certainly taken the lock.
        await new Promise((resolve) => setTimeout(resolve, 150))
        const second = b.mcp(cipher).withServerLock(scope, 'linear', async () => {
          events.push('b:in')
          events.push('b:out')
        })

        await Promise.all([first, second])
        expect(events).toEqual(['a:in', 'a:out', 'b:in', 'b:out'])
      } finally {
        await a.close()
        await b.close()
      }
    }, 30_000)

    it('does not serialise different servers, which would stall unrelated refreshes', async () => {
      const store = new PostgresStore({ connectionString: dsn!, maxConnections: 3 })
      try {
        const project = await store.findProject(testProjectId!)
        if (!project) throw new Error('project missing')
        const scope = { clientSpaceId: project.clientSpaceId, projectId: project.projectId }
        const mcp = store.mcp(new LocalSecretCipher('mcp-store-test'))

        const events: string[] = []
        await Promise.all([
          mcp.withServerLock(scope, 'linear', async () => {
            events.push('linear:in')
            await new Promise((resolve) => setTimeout(resolve, 400))
            events.push('linear:out')
          }),
          mcp.withServerLock(scope, 'jira', async () => {
            events.push('jira:in')
            events.push('jira:out')
          }),
        ])
        // Jira finishes inside Linear's window: the lock is per server, not global.
        expect(events.indexOf('jira:out')).toBeLessThan(events.indexOf('linear:out'))
      } finally {
        await store.close()
      }
    }, 30_000)
  })
}
