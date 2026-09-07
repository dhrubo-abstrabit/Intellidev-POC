import { describe, expect, it } from 'vitest'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { buildServer } from '../src/server.js'
import { InMemoryStore } from '../src/store/memory.js'
import { FileSeatStore } from '../src/harness/accounts.js'
import { FileMcpStore } from '../src/mcp/registry.js'
import { resolveStages } from '../src/stages/resolve.js'
import { allowTestRepo, TEST_SCOPE, TEST_TASK } from './fixtures.js'

/**
 * Choosing a template for one task, from the form to the stages that run.
 *
 * Resolution's own precedence is tested in `stage-resolve`. What is tested here is the *carry*:
 * that an id sent with the request survives into the row dispatch reads. That gap is not
 * hypothetical — `stageTemplateId` was accepted by the schema and honoured by resolution for a
 * while with nothing in between sending it, so the feature was complete at both ends and absent
 * in the middle.
 */
async function serverWith(store: InMemoryStore) {
  const work = await mkdtemp(join(tmpdir(), 'idv-tasktpl-'))
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

const BUILT_IN = {
  name: 'built-in',
  stages: [{ id: 'code', kind: 'agent', prompt: 'the default' }],
} as never

describe('picking a template for a single task', () => {
  it('carries the chosen id from the request through to the stages that run', async () => {
    const store = new InMemoryStore()
    await allowTestRepo(store)
    // Two templates, and the one that is *not* the default is the one chosen — so a task that
    // simply fell through to the default would look identical to a working one.
    await store.saveStageTemplate({
      clientSpaceId: TEST_SCOPE.clientSpaceId,
      projectId: TEST_SCOPE.projectId,
      name: 'Full pipeline',
      stages: [{ id: 'code', kind: 'agent', prompt: 'everything' }] as never,
      isDefault: true,
    })
    const quick = await store.saveStageTemplate({
      clientSpaceId: TEST_SCOPE.clientSpaceId,
      projectId: TEST_SCOPE.projectId,
      name: 'Quick fix',
      stages: [{ id: 'patch', kind: 'agent', prompt: 'just fix it' }] as never,
      isDefault: false,
    })

    const app = await serverWith(store)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...TEST_TASK, stageTemplateId: quick.id },
    })
    await app.close()
    expect(res.statusCode).toBe(201)

    // Read back through the store, which is what dispatch does.
    const task = await store.getTask(res.json().task.id)
    expect(task?.stageTemplateId).toBe(quick.id)

    const resolved = await resolveStages({
      store,
      scope: TEST_SCOPE,
      task: task!,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('task-template')
    expect(resolved.template.stages.map((s) => s.id)).toEqual(['patch'])
  })

  it('runs the project default when the form sends nothing', async () => {
    // The empty selection. It must not become an empty string, a null, or a uuid failure on a
    // form nobody touched — the overwhelmingly common case is that nobody picks anything.
    const store = new InMemoryStore()
    await allowTestRepo(store)
    await store.saveStageTemplate({
      clientSpaceId: TEST_SCOPE.clientSpaceId,
      projectId: TEST_SCOPE.projectId,
      name: 'Full pipeline',
      stages: [{ id: 'code', kind: 'agent', prompt: 'everything' }] as never,
      isDefault: true,
    })

    const app = await serverWith(store)
    const res = await app.inject({ method: 'POST', url: '/api/tasks', payload: TEST_TASK })
    await app.close()
    expect(res.statusCode).toBe(201)

    const task = await store.getTask(res.json().task.id)
    expect(task?.stageTemplateId).toBeUndefined()

    const resolved = await resolveStages({
      store,
      scope: TEST_SCOPE,
      task: task!,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('project-default')
  })

  it('refuses an id that is not a template', async () => {
    /**
     * Caught at the request rather than at dispatch. A task created with a bad id would look
     * fine until it ran, and then run the default — which is the worst of both, because nothing
     * would say the choice had been ignored.
     */
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const app = await serverWith(store)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...TEST_TASK, stageTemplateId: 'not-a-uuid' },
    })
    await app.close()
    expect(res.statusCode).toBe(400)
  })

  it('ignores a template from another client space', async () => {
    /**
     * The service role is not constrained by RLS, so a well-formed id from another space would
     * otherwise run that space's stages on this project's repository. Falling through to the
     * default is the safe answer, and it is the one `belongsTo` gives.
     */
    const store = new InMemoryStore()
    await allowTestRepo(store)
    const foreign = await store.saveStageTemplate({
      clientSpaceId: randomUUID(),
      name: 'Somebody else',
      stages: [{ id: 'exfiltrate', kind: 'agent', prompt: 'no' }] as never,
      isDefault: true,
    })
    await store.saveStageTemplate({
      clientSpaceId: TEST_SCOPE.clientSpaceId,
      projectId: TEST_SCOPE.projectId,
      name: 'Ours',
      stages: [{ id: 'code', kind: 'agent', prompt: 'ours' }] as never,
      isDefault: true,
    })

    const app = await serverWith(store)
    const res = await app.inject({
      method: 'POST',
      url: '/api/tasks',
      payload: { ...TEST_TASK, stageTemplateId: foreign.id },
    })
    await app.close()
    expect(res.statusCode).toBe(201)

    const resolved = await resolveStages({
      store,
      scope: TEST_SCOPE,
      task: (await store.getTask(res.json().task.id))!,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('project-default')
    expect(resolved.template.stages.map((s) => s.id)).toEqual(['code'])
  })
})
