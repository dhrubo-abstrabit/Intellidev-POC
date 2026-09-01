import { describe, expect, it } from 'vitest'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store/memory.js'
import { FileSeatStore } from '../src/harness/accounts.js'
import { FileMcpStore } from '../src/mcp/registry.js'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TEST_SCOPE } from './fixtures.js'

/**
 * What a load balancer asks before sending traffic.
 *
 * Two properties matter, and both are easy to get wrong in ways that are invisible until a
 * deploy: the check must not be behind authentication, or every target is marked unhealthy; and
 * it must actually check the store, or an instance that cannot reach Postgres stays in the pool
 * serving errors.
 */
async function server(store = new InMemoryStore()) {
  const work = await mkdtemp(join(tmpdir(), 'idv-health-'))
  return await buildServer({
    store,
    scope: TEST_SCOPE,
    dispatch: {
      mode: 'inline',
      bundleRoot: work,
      image: 'x',
      workRoot: work,
      projectId: TEST_SCOPE.projectId,
      publicUrl: 'http://127.0.0.1:4000',
    },
    mcp: await FileMcpStore.open(join(work, 'mcp.json')),
    accounts: await FileSeatStore.open(join(work, 'accounts.json')),
    publicDir: work,
  })
}

describe('the health endpoint', () => {
  it('answers ok when the store is reachable', async () => {
    const app = await server()
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).toBe(200)
      expect(res.json()).toMatchObject({ status: 'ok' })
    } finally {
      await app.close()
    }
  })

  it('answers 503, not 500, when the store cannot be reached', async () => {
    // An instance that cannot reach Postgres can accept a request and fail it — every dispatch,
    // every task list. It should leave the pool rather than serve errors from inside it.
    const broken = new InMemoryStore()
    broken.listProjectRepos = async () => {
      throw new Error('connection terminated unexpectedly')
    }
    const app = await server(broken)
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).toBe(503)
      expect(res.json()).toMatchObject({ status: 'unhealthy' })
    } finally {
      await app.close()
    }
  })

  it('is not behind the authentication gate', async () => {
    // Gated, it would answer 401 to the load balancer and every target would be marked
    // unhealthy — a deploy that never becomes ready, for a reason that looks like the app.
    const app = await server()
    try {
      const res = await app.inject({ method: 'GET', url: '/healthz' })
      expect(res.statusCode).not.toBe(401)
    } finally {
      await app.close()
    }
  })
})
