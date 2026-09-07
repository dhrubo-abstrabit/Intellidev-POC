import { describe, expect, it } from 'vitest'
import { resolveStages } from '../src/stages/resolve.js'
import type { ProjectScope, StageTemplateRow } from '../src/store/types.js'

/**
 * Which stages a task runs, and why.
 *
 * The order is the design: each level exists because the one above is too specific to be a policy
 * and the one below too general to be an exception. These tests are mostly about precedence,
 * because getting that wrong is silent — a project override that never applies looks exactly like
 * a project that was never configured.
 */
const SCOPE: ProjectScope = {
  projectId: 'project-1',
  clientSpaceId: 'space-1',
  workspaceId: 'workspace-1',
}

const BUILT_IN = {
  name: 'built-in',
  stages: [{ id: 'code', kind: 'agent', promptFile: 'prompts/code.md' }],
} as never

function row(over: Partial<StageTemplateRow> & { name: string }): StageTemplateRow {
  // Defaults first, then the overrides — the other way round sets `name` twice and the spread
  // wins silently, which typescript rightly refuses.
  return {
    id: over.name,
    clientSpaceId: SCOPE.clientSpaceId,
    stages: [{ id: over.name, kind: 'agent', prompt: 'x' }] as never,
    isDefault: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

function store(rows: StageTemplateRow[]) {
  return {
    async listStageTemplates() {
      // A project's own first, which is what both real stores return.
      return [...rows].sort((a, b) =>
        Boolean(a.projectId) === Boolean(b.projectId) ? 0 : a.projectId ? -1 : 1,
      )
    },
    async getStageTemplate(id: string) {
      return rows.find((r) => r.id === id)
    },
  }
}

describe('resolving which stages a task runs', () => {
  it('falls back to the built-in when nothing is configured', async () => {
    // The behaviour every space had before any of this existed, and must keep having.
    const resolved = await resolveStages({ store: store([]), scope: SCOPE, builtIn: BUILT_IN })
    expect(resolved.source).toBe('built-in')
    expect(resolved.template.name).toBe('built-in')
  })

  it('prefers the space default over the built-in', async () => {
    const resolved = await resolveStages({
      store: store([row({ name: 'space', isDefault: true })]),
      scope: SCOPE,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('space-default')
  })

  it('prefers the project default over the space default', async () => {
    // The point of having both: a space sets a policy, a project departs from it.
    const resolved = await resolveStages({
      store: store([
        row({ name: 'space', isDefault: true }),
        row({ name: 'project', projectId: SCOPE.projectId, isDefault: true }),
      ]),
      scope: SCOPE,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('project-default')
    expect(resolved.templateId).toBe('project')
  })

  it("prefers the task's chosen template over any default", async () => {
    const resolved = await resolveStages({
      store: store([
        row({ name: 'space', isDefault: true }),
        row({ name: 'project', projectId: SCOPE.projectId, isDefault: true }),
        row({ name: 'chosen', id: 'chosen' }),
      ]),
      scope: SCOPE,
      task: { stageTemplateId: 'chosen' },
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('task-template')
    expect(resolved.templateId).toBe('chosen')
  })

  it('prefers inline stages on the task over everything', async () => {
    /**
     * The difference between the two task-level forms: a chosen template follows later edits,
     * inline stages are pinned. A task that carried its own array must not change under it.
     */
    const resolved = await resolveStages({
      store: store([row({ name: 'project', projectId: SCOPE.projectId, isDefault: true })]),
      scope: SCOPE,
      task: {
        stageTemplateId: 'project',
        stages: [{ id: 'only-this', kind: 'agent', prompt: 'inline' }],
      },
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('task-inline')
    expect(resolved.template.stages.map((s) => s.id)).toEqual(['only-this'])
  })

  it('refuses inline stages that would not run', async () => {
    /**
     * Validated at dispatch rather than in the container. A bad array reaching a container costs
     * a whole container to discover, and the failure arrives as a stage-one crash rather than as
     * a rejected dispatch.
     */
    await expect(
      resolveStages({
        store: store([]),
        scope: SCOPE,
        // An agent stage with no instructions at all.
        task: { stages: [{ id: 'nope', kind: 'agent' }] },
        builtIn: BUILT_IN,
      }),
    ).rejects.toThrow()
  })

  it('falls through when the chosen template was deleted', async () => {
    /**
     * The column is ON DELETE SET NULL, so this is the window between a task being created and
     * dispatched. Refusing the run would punish a task that was configured correctly when it was
     * made; the project default is what it would have picked up a moment earlier.
     */
    const resolved = await resolveStages({
      store: store([row({ name: 'project', projectId: SCOPE.projectId, isDefault: true })]),
      scope: SCOPE,
      task: { stageTemplateId: 'gone' },
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('project-default')
  })

  it('ignores a template belonging to another space', async () => {
    /**
     * Dispatch runs as the service role, which RLS does not constrain — so this is the one place
     * where "the database will catch it" is untrue. A task id pointing at another space's
     * template would otherwise run that space's stages.
     */
    const foreign = row({ name: 'foreign', id: 'foreign' })
    const resolved = await resolveStages({
      store: store([{ ...foreign, clientSpaceId: 'another-space' }]),
      scope: SCOPE,
      task: { stageTemplateId: 'foreign' },
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('built-in')
  })

  it("ignores another project's template in the same space", async () => {
    // Same reasoning one level down: a project's template is not the space's to hand out.
    const resolved = await resolveStages({
      store: store([row({ name: 'other', id: 'other', projectId: 'project-2' })]),
      scope: SCOPE,
      task: { stageTemplateId: 'other' },
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('built-in')
  })
})
