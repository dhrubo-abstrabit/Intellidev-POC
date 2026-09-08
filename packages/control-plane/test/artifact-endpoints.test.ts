import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store/memory.js'
import { RunTokenRegistry } from '../src/runs/tokens.js'
import { FileSeatStore } from '../src/harness/accounts.js'
import { FileMcpStore } from '../src/mcp/registry.js'
import { allowTestRepo, TEST_SCOPE, TEST_TASK } from './fixtures.js'

/**
 * What a run may write, and what it may not.
 *
 * These endpoints are reached by a container holding one credential — its run token — so the
 * interesting cases are the refusals: another run's token, a body that would not fit, a kind the
 * preview cannot render, and a name that would be unpleasant to display.
 *
 * The limits live here rather than in the adapter so there is one source of truth, and the agent
 * learns from the tool result rather than from a row rejected later by a CHECK constraint it
 * cannot see. That is what these assert.
 */
async function scaffold() {
  const work = await mkdtemp(join(tmpdir(), 'idv-artifact-'))
  const store = new InMemoryStore()
  const tokens = new RunTokenRegistry()
  const app = await buildServer({
    store,
    scope: TEST_SCOPE,
    tokens,
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

  await allowTestRepo(store)
  const task = await store.createTask(TEST_TASK, TEST_SCOPE)
  const run = await store.createRun(task.id, 'claude-code', 'feat/x')
  const token = (await tokens.mint(run.id)).token

  const write = (payload: unknown, bearer = token) =>
    app.inject({
      method: 'PUT',
      url: `/internal/runs/${run.id}/artifacts`,
      headers: { authorization: `Bearer ${bearer}` },
      payload: payload as never,
    })

  return { app, store, tokens, task, run, token, write }
}

const diagram = {
  name: 'architecture.mmd',
  kind: 'mermaid',
  body: 'graph TD\n  A --> B',
  title: 'How the pieces fit',
}

describe('a run writing an artifact', () => {
  it('saves it against the run’s own task', async () => {
    const { app, store, task, run, write } = await scaffold()
    const res = await write({ ...diagram, stage: 'design' })
    await app.close()

    expect(res.statusCode).toBe(201)
    // The body is not echoed: the caller just sent it, and returning a megabyte is pure cost.
    expect(res.json().artifact).not.toHaveProperty('body')

    const saved = await store.findTaskArtifact(task.id, 'architecture.mmd')
    expect(saved).toMatchObject({
      taskId: task.id,
      // Taken from the run, not from the request — a container cannot claim another task.
      runId: run.id,
      stage: 'design',
      kind: 'mermaid',
      title: 'How the pieces fit',
    })
  })

  it('refuses another run’s token', async () => {
    /**
     * The boundary that matters. A container's token is scoped to its run, and the task's
     * tenancy is read from that run — so a token from elsewhere must not be able to write into
     * this project at all.
     */
    const { app, tokens, store, write } = await scaffold()
    const other = await store.createTask(TEST_TASK, TEST_SCOPE)
    const otherRun = await store.createRun(other.id, 'claude-code', 'feat/y')
    const otherToken = (await tokens.mint(otherRun.id)).token

    const res = await write(diagram, otherToken)
    await app.close()

    expect(res.statusCode).toBe(403)
    expect(await store.listTaskArtifacts(other.id)).toHaveLength(0)
  })

  it('refuses no token at all', async () => {
    const { app, run } = await scaffold()
    const res = await app.inject({
      method: 'PUT',
      url: `/internal/runs/${run.id}/artifacts`,
      payload: diagram as never,
    })
    await app.close()

    expect(res.statusCode).toBeGreaterThanOrEqual(400)
    expect(res.statusCode).toBeLessThan(500)
  })

  it('refuses a body over the limit, and says by how much', async () => {
    /**
     * 413 rather than 400: the request was well formed and simply too big, and the number is
     * the useful part of the answer — an agent told only "too large" retries the same body.
     *
     * The cap is what keeps "the body lives in Postgres" true, and stops an artifact becoming
     * somewhere to put a build output.
     */
    const { app, store, task, write } = await scaffold()
    const res = await write({ ...diagram, kind: 'markdown', body: 'x'.repeat(1_048_577) })
    await app.close()

    expect(res.statusCode).toBe(413)
    expect(res.json().error).toMatch(/1048576/)
    expect(res.json().error).toMatch(/1048577/)
    expect(await store.listTaskArtifacts(task.id)).toHaveLength(0)
  })

  it('accepts a body exactly at the limit', async () => {
    // Off-by-one in the direction that matters: a cap that rejects the allowed size is a cap
    // nobody can use up to.
    const { app, write } = await scaffold()
    const res = await write({ ...diagram, kind: 'markdown', body: 'x'.repeat(1_048_576) })
    await app.close()

    expect(res.statusCode).toBe(201)
  })

  it('counts the limit in bytes, not characters', async () => {
    /**
     * The column is checked against `octet_length`, so a body just under the limit in
     * characters but over it in bytes would pass here and be rejected by Postgres — a 500 for
     * something this endpoint is meant to explain.
     */
    const { app, write } = await scaffold()
    // Three bytes each, so this is ~1.5 MiB of UTF-8 in half a million characters.
    const res = await write({ ...diagram, kind: 'markdown', body: '→'.repeat(500_000) })
    await app.close()

    expect(res.statusCode).toBe(413)
  })

  it('refuses a kind the preview cannot render', async () => {
    // A kind nothing can render is a blank pane. Better the agent hears it now than a person
    // discovers it a day later.
    const { app, write } = await scaffold()
    const res = await write({ ...diagram, kind: 'svg' })
    await app.close()

    expect(res.statusCode).toBe(400)
    expect(res.json().error).toMatch(/html, markdown, mermaid/)
  })

  it('refuses a name that would be unpleasant to display', async () => {
    // Not a path — an artifact is a row, not a file — but a name is rendered in a list and
    // used in a URL, and `../../etc/passwd` in either is a conversation nobody needs.
    const { app, write } = await scaffold()
    for (const name of ['../escape', 'has spaces', '', '.hidden', 'x'.repeat(121)]) {
      expect((await write({ ...diagram, name })).statusCode, name).toBe(400)
    }
    await app.close()
  })

  it('refuses an empty body', async () => {
    const { app, write } = await scaffold()
    expect((await write({ ...diagram, body: '   ' })).statusCode).toBe(400)
    await app.close()
  })

  it('replaces an artifact of the same name', async () => {
    // A stage that re-renders its diagram means to replace it.
    const { app, store, task, write } = await scaffold()
    await write({ ...diagram, body: 'graph TD\n  A --> B' })
    await write({ ...diagram, body: 'graph TD\n  A --> C' })
    await app.close()

    const listed = await store.listTaskArtifacts(task.id)
    expect(listed).toHaveLength(1)
    expect((await store.findTaskArtifact(task.id, 'architecture.mmd'))?.body).toContain('A --> C')
  })

  it('caps how many one task may have, but never blocks an overwrite', async () => {
    /**
     * The cap stops a confused stage filling a project with drafts. Checked against existing
     * *names* rather than the total, because overwriting is not a new artifact — a naive count
     * would refuse the stage re-rendering the diagram it wrote a moment ago, which is the one
     * write that must always work.
     */
    const { app, write } = await scaffold()
    for (let i = 0; i < 50; i++) {
      expect(
        (await write({ ...diagram, name: `draft-${i}.md`, kind: 'markdown' })).statusCode,
      ).toBe(201)
    }

    // The 51st new name is refused, with the way out in the message.
    const refused = await write({ ...diagram, name: 'one-too-many.md', kind: 'markdown' })
    expect(refused.statusCode).toBe(409)
    expect(refused.json().error).toMatch(/overwrite one by using its name/)

    // And an existing name still writes.
    expect((await write({ ...diagram, name: 'draft-0.md', kind: 'markdown' })).statusCode).toBe(201)
    await app.close()
  })
})

describe('a run reading its artifacts', () => {
  it('reads one back by name, with its body', async () => {
    // The half that makes this more than a viewer: `code` asking `design` what it drew.
    const { app, run, token, write } = await scaffold()
    await write(diagram)

    const res = await app.inject({
      method: 'GET',
      url: `/internal/runs/${run.id}/artifacts/architecture.mmd`,
      headers: { authorization: `Bearer ${token}` },
    })
    await app.close()

    expect(res.statusCode).toBe(200)
    expect(res.json().artifact.body).toContain('A --> B')
  })

  it('lists without bodies', async () => {
    const { app, run, token, write } = await scaffold()
    await write({ ...diagram, kind: 'markdown', body: 'the whole body' })

    const res = await app.inject({
      method: 'GET',
      url: `/internal/runs/${run.id}/artifacts`,
      headers: { authorization: `Bearer ${token}` },
    })
    await app.close()

    expect(res.json().artifacts[0]).not.toHaveProperty('body')
    expect(res.json().artifacts[0].name).toBe('architecture.mmd')
  })

  it('answers 404 for a name that was never written', async () => {
    // Asking is not an error, so the client can offer alternatives rather than fail the stage.
    const { app, run, token } = await scaffold()
    const res = await app.inject({
      method: 'GET',
      url: `/internal/runs/${run.id}/artifacts/never-written.md`,
      headers: { authorization: `Bearer ${token}` },
    })
    await app.close()

    expect(res.statusCode).toBe(404)
  })

  it('refuses another run’s token on a read too', async () => {
    // Reads leak as readily as writes: an artifact may hold a schema, a plan, or a decision.
    const { app, store, tokens, run, write } = await scaffold()
    await write(diagram)
    const other = await store.createTask(TEST_TASK, TEST_SCOPE)
    const otherRun = await store.createRun(other.id, 'claude-code', 'feat/y')
    const otherToken = (await tokens.mint(otherRun.id)).token

    const res = await app.inject({
      method: 'GET',
      url: `/internal/runs/${run.id}/artifacts/architecture.mmd`,
      headers: { authorization: `Bearer ${otherToken}` },
    })
    await app.close()

    expect(res.statusCode).toBe(403)
  })
})
