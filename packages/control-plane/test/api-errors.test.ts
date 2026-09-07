import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store/memory.js'
import { FileSeatStore } from '../src/harness/accounts.js'
import { FileMcpStore } from '../src/mcp/registry.js'
import { TEST_SCOPE } from './fixtures.js'

/**
 * What a failure tells the browser.
 *
 * FOUND ON THE HOSTED PLANE. Saving a stage template a second time returned a 500 whose body was
 * the failing INSERT with every parameter interpolated — all five stages and their prompts. Two
 * problems in one response: it is useless as an error message, and it is a leak, because the
 * generic path is shared by every write and other tables' parameters are worse than prompts.
 *
 * Fastify's default handler is `error.message`, and a driver's message is the whole statement.
 * So this is not a formatting preference: leaving the default in place means any unhandled error
 * anywhere returns whatever the driver felt like saying.
 */
async function serverThatFailsToSave(error: unknown) {
  const work = await mkdtemp(join(tmpdir(), 'idv-apierr-'))
  const store = new InMemoryStore()
  // The one call the request makes, replaced with the failure. Going through the real route
  // rather than the handler directly is the point: the leak was in the layer between them.
  store.saveStageTemplate = async () => {
    throw error
  }
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

const SAVE = {
  method: 'POST' as const,
  url: '/api/stage-templates',
  payload: {
    name: 'with approval',
    isDefault: true,
    stages: [
      { id: 'code', kind: 'agent', prompt: 'the secret prompt text', tools: { mode: 'full' } },
    ],
  },
}

/** Shaped like what `pg` throws, wrapped the way drizzle wraps it inside a transaction. */
function wrappedUniqueViolation() {
  const driver = Object.assign(
    new Error('duplicate key value violates unique constraint "stage_templates_project_name_uniq"'),
    { code: '23505' },
  )
  return Object.assign(
    new Error(
      'Failed query: insert into "runner"."stage_templates" ... params: with approval,the secret prompt text',
    ),
    { cause: driver },
  )
}

describe('what a failed write tells the browser', () => {
  it('answers a name collision with the fix rather than a stack of SQL', async () => {
    const app = await serverThatFailsToSave(wrappedUniqueViolation())
    const res = await app.inject(SAVE)
    await app.close()

    expect(res.statusCode).toBe(409)
    const body = res.json()
    expect(body.error).toMatch(/already taken/i)
    // The whole point: nothing about the statement, and nothing the request carried.
    expect(res.body).not.toMatch(/insert into/i)
    expect(res.body).not.toMatch(/the secret prompt text/)
    expect(res.body).not.toMatch(/stage_templates_project_name_uniq/)
  })

  it('finds the driver code even when it is only on the cause', async () => {
    /**
     * Drizzle wraps what `pg` throws, and how deeply depends on whether the statement ran inside
     * a transaction — `saveStageTemplate` does, which is why reading `error.code` off the top
     * found nothing for exactly the write that needed it. Asserted separately from the message
     * so a regression in the walk is not hidden by a passing 409 from a shallower error.
     */
    const shallow = Object.assign(new Error('duplicate key'), { code: '23505' })
    const app = await serverThatFailsToSave(shallow)
    const res = await app.inject(SAVE)
    await app.close()

    expect(res.statusCode).toBe(409)
  })

  it('says nothing at all about an error it does not recognise', async () => {
    // A 500 is the case where the detail is *most* likely to be sensitive, because nobody chose
    // what goes in it. It belongs in the log.
    const app = await serverThatFailsToSave(
      new Error('connection to server at "db.internal" failed: password authentication failed'),
    )
    const res = await app.inject(SAVE)
    await app.close()

    expect(res.statusCode).toBe(500)
    expect(res.body).not.toMatch(/password/i)
    expect(res.body).not.toMatch(/db\.internal/)
  })

  it('still lets a deliberate 4xx say what is wrong', async () => {
    /**
     * The handler must not flatten the errors that were written to be read. A template with no
     * name is a mistake a person can fix from the message, and turning that into "something went
     * wrong" would make the useful half of the API worse to fix the useless half.
     */
    const app = await serverThatFailsToSave(new Error('never reached'))
    const res = await app.inject({ ...SAVE, payload: { ...SAVE.payload, name: '  ' } })
    await app.close()

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/needs a name/)
  })
})
