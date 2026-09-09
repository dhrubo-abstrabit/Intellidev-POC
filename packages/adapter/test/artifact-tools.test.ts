import { describe, expect, it } from 'vitest'
import { buildBuiltinTools, type ArtifactStore } from '../src/gateway/builtins.js'
import { StageTemplate } from '@intellidev/shared'

/**
 * Writing something down that is not code.
 *
 * The gap these fill: a run produces an event log and a pull request, so a diagram the design
 * stage worked out survives only as prose — and the stage after it cannot read prose.
 *
 * What is worth testing is not that a fetch happened but the decisions around it: the tools are
 * absent when there is nowhere to keep what they write, the stage is taken from the engine
 * rather than the agent, and a refusal reaches the agent in words it can act on.
 */
const template = StageTemplate.parse({
  name: 't',
  stages: [
    { id: 'design', kind: 'agent', prompt: 'plan' },
    { id: 'code', kind: 'agent', prompt: 'do' },
  ],
})

function context(over: { artifacts?: ArtifactStore; stage?: string } = {}) {
  return {
    task: {
      id: 'task_1',
      title: 't',
      description: 'd',
      acceptanceCriteria: ['a'],
    },
    template,
    stage: () => (over.stage ?? 'design') as never,
    attempt: () => 1,
    commands: {
      async run() {
        return { exitCode: 0, stdout: '', stderr: '' }
      },
    } as never,
    cwd: '/work',
    skills: [],
    bundleRoot: '/bundle',
    onStageOutput: () => {},
    onQuestion: () => {},
    ...(over.artifacts ? { artifacts: over.artifacts } : {}),
  } as never
}

/** A store that records what it was asked to do. */
function fakeStore(over: Partial<ArtifactStore> = {}) {
  const written: Array<Record<string, unknown>> = []
  const store: ArtifactStore = {
    async put(input) {
      // A name already written becomes a version of it, as the real store does.
      const version = written.filter((w) => w['name'] === input.name).length + 1
      written.push({ ...input, version })
      return { name: input.name, kind: input.kind, bytes: input.body.length, version }
    },
    async list() {
      const names = [...new Set(written.map((w) => String(w['name'])))]
      return names.map((name) => {
        const all = written.filter((w) => w['name'] === name)
        const current = all[all.length - 1]!
        return {
          name,
          kind: String(current['kind']),
          bytes: 1,
          version: Number(current['version']),
          versionCount: all.length,
        }
      })
    },
    async read(name, version) {
      const all = written.filter((w) => w['name'] === name)
      const found = version === undefined ? all[all.length - 1] : all[version - 1]
      return found
        ? { name: String(found['name']), kind: String(found['kind']), body: String(found['body']) }
        : undefined
    },
    ...over,
  }
  return { written, store }
}

const tool = (tools: ReturnType<typeof buildBuiltinTools>, name: string) => {
  const found = tools.find((t) => t.name === name)
  if (!found) throw new Error(`no tool named ${name}`)
  return found
}

describe('the artifact tools', () => {
  it('are absent when there is nowhere to keep what they write', () => {
    /**
     * A tool an agent can see is a tool it will use. With no control plane behind it — a local
     * run, a test — `write_artifact` would accept a diagram and lose it, which is worse than
     * not offering it: the agent would move on believing the work was saved.
     */
    const names = buildBuiltinTools(context()).map((t) => t.name)

    expect(names).not.toContain('write_artifact')
    expect(names).not.toContain('read_artifact')
    expect(names).not.toContain('list_artifacts')
    // The rest are unaffected.
    expect(names).toContain('task_context')
  })

  it('appear once there is', () => {
    const { store } = fakeStore()
    const names = buildBuiltinTools(context({ artifacts: store })).map((t) => t.name)

    expect(names).toContain('write_artifact')
    expect(names).toContain('read_artifact')
    expect(names).toContain('list_artifacts')
  })

  it('records the stage from the engine rather than from the agent', async () => {
    // Which stage wrote something is a fact about the run. Asking the agent would invite a
    // wrong answer, and the answer is what a reviewer uses to tell a plan from an
    // afterthought.
    const { written, store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store, stage: 'code' }))

    await tool(tools, 'write_artifact').handler({
      name: 'architecture.mmd',
      kind: 'mermaid',
      body: 'graph TD\n  A --> B',
      // Ignored, deliberately: there is no `stage` in the input schema at all.
      stage: 'design',
    })

    expect(written[0]).toMatchObject({ stage: 'code', name: 'architecture.mmd' })
  })

  it('passes a refusal through in the words the control plane used', async () => {
    /**
     * Limits live in the control plane, and it explains them in terms the agent can act on:
     * "at most 1048576 bytes; this one is 2200000". A generic "could not save" would leave the
     * agent retrying the same oversized body until the stage ran out of attempts.
     */
    const { store } = fakeStore({
      async put() {
        throw new Error('an artifact may be at most 1048576 bytes; this one is 2200000')
      },
    })
    const tools = buildBuiltinTools(context({ artifacts: store }))

    const result = await tool(tools, 'write_artifact').handler({
      name: 'huge.md',
      kind: 'markdown',
      body: 'x',
    })

    expect(result).toContain('1048576')
    expect(result).toContain('2200000')
  })

  it('refuses a kind the preview cannot render', async () => {
    // Checked here as well as server-side so the agent hears about it in the same turn, rather
    // than from a row rejected by a CHECK constraint it cannot see.
    const { written, store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))

    const result = await tool(tools, 'write_artifact').handler({
      name: 'diagram.svg',
      kind: 'svg',
      body: '<svg/>',
    })

    expect(result).toMatch(/kind must be one of/)
    expect(written).toHaveLength(0)
  })

  it('refuses an empty body rather than saving a blank artifact', async () => {
    const { written, store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))

    expect(
      await tool(tools, 'write_artifact').handler({
        name: 'notes.md',
        kind: 'markdown',
        body: '   \n  ',
      }),
    ).toMatch(/non-empty/)
    expect(written).toHaveLength(0)
  })

  it('lets a later stage read what an earlier one wrote', async () => {
    // The whole point. `code` asking `design` what it drew is the thing prose in an event log
    // cannot provide.
    const { store } = fakeStore()
    const design = buildBuiltinTools(context({ artifacts: store, stage: 'design' }))
    await tool(design, 'write_artifact').handler({
      name: 'architecture.mmd',
      kind: 'mermaid',
      body: 'graph TD\n  A --> B',
    })

    const code = buildBuiltinTools(context({ artifacts: store, stage: 'code' }))
    const body = await tool(code, 'read_artifact').handler({ name: 'architecture.mmd' })

    expect(body).toBe('graph TD\n  A --> B')
  })

  it('names what is available when a read misses', async () => {
    // So the next call is right rather than another guess. An agent told only "not found"
    // tries three more spellings.
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({
      name: 'theme-comparison.md',
      kind: 'markdown',
      body: 'notes',
    })

    const result = await tool(tools, 'read_artifact').handler({ name: 'comparison.md' })

    expect(result).toContain('no artifact named "comparison.md"')
    expect(result).toContain('theme-comparison.md')
  })

  it('says plainly when a task has none yet', async () => {
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))

    expect(await tool(tools, 'list_artifacts').handler({})).toMatch(/No artifacts yet/)
    expect(await tool(tools, 'read_artifact').handler({ name: 'x.md' })).toMatch(/none yet/)
  })

  it('lists without bodies', async () => {
    // An agent deciding what to read does not need a megabyte of markdown to decide.
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({
      name: 'notes.md',
      kind: 'markdown',
      body: 'the whole body which should not appear in a listing',
    })

    const listed = await tool(tools, 'list_artifacts').handler({})

    expect(listed).toContain('notes.md')
    expect(listed).not.toContain('should not appear')
  })
})

describe('iterating on an artifact', () => {
  /**
   * The tool descriptions are the only thing steering an agent here, so what they *say* matters
   * as much as what the store does: told that a repeated name replaces the artifact, an agent
   * avoids reusing one and invents `architecture-v2.mmd` instead — which is the outcome
   * versioning exists to prevent.
   */
  it('tells the agent that reusing a name makes a version', () => {
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    const description = tool(tools, 'write_artifact').description ?? ''

    expect(description).toMatch(/new \*version\*/)
    // And that nothing is lost, so it has no reason to hedge with a second name.
    expect(description).toMatch(/earlier versions stay readable/)
  })

  it('reports the version it saved', async () => {
    // So the agent's own summary can say which revision it produced.
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({
      name: 'architecture.mmd',
      kind: 'mermaid',
      body: 'first',
    })

    const second = await tool(tools, 'write_artifact').handler({
      name: 'architecture.mmd',
      kind: 'mermaid',
      body: 'second',
    })

    expect(second).toMatch(/version 2/)
  })

  it('reads the current version by default and an earlier one on request', async () => {
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({ name: 'notes.md', kind: 'markdown', body: 'one' })
    await tool(tools, 'write_artifact').handler({ name: 'notes.md', kind: 'markdown', body: 'two' })

    expect(await tool(tools, 'read_artifact').handler({ name: 'notes.md' })).toBe('two')
    expect(await tool(tools, 'read_artifact').handler({ name: 'notes.md', version: 1 })).toBe('one')
  })

  it('ignores a version that is not an integer rather than failing the read', async () => {
    // A model passing "1" or 1.5 should still get the artifact, not an error about types.
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({ name: 'notes.md', kind: 'markdown', body: 'one' })

    expect(await tool(tools, 'read_artifact').handler({ name: 'notes.md', version: '1' })).toBe(
      'one',
    )
  })

  it('shows how many versions exist when listing', async () => {
    // So an agent can tell a revised artifact from a fresh one before deciding to read it.
    const { store } = fakeStore()
    const tools = buildBuiltinTools(context({ artifacts: store }))
    await tool(tools, 'write_artifact').handler({ name: 'notes.md', kind: 'markdown', body: 'one' })
    await tool(tools, 'write_artifact').handler({ name: 'notes.md', kind: 'markdown', body: 'two' })

    const listed = await tool(tools, 'list_artifacts').handler({})

    expect(listed).toContain('"versionCount": 2')
  })
})
