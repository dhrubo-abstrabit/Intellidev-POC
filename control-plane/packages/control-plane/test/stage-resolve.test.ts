import { describe, expect, it } from 'vitest'
import { DEFAULT_STAGE_PROMPTS } from '@intellidev/shared'
import {
  ensureSeededStageTemplates,
  resolveStages,
  upgradeLegacyPromptFiles,
} from '../src/stages/resolve.js'
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

describe('seeding a space that has never configured anything', () => {
  function seedStore() {
    const rows: StageTemplateRow[] = []
    return {
      rows,
      store: {
        async listStageTemplates() {
          return rows
        },
        async saveStageTemplate(
          input: Parameters<typeof rows.push>[0] extends never ? never : any,
        ) {
          const created = {
            id: 'seeded',
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            ...input,
          }
          rows.push(created)
          return created
        },
      },
    }
  }

  const SEED = {
    name: 'built-in',
    stages: [{ id: 'code', kind: 'agent', prompt: 'do it', tools: { mode: 'full' } }],
  } as never

  it('creates a space-level default so the stages exist as an editable row', async () => {
    /**
     * The point of the whole feature. A template compiled into the source means "configure your
     * stages" is an edit to a file nobody deploying this can make — so the first time a space
     * needs stages, it gets a row it owns.
     */
    const { store, rows } = seedStore()
    const created = await ensureSeededStageTemplates({ store, scope: SCOPE, seed: SEED })

    expect(created).toBeDefined()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.isDefault).toBe(true)
    // Space level, so every project in it starts from this and any may override.
    expect(rows[0]?.projectId).toBeUndefined()
    // Named for a person reading a list, not for the code that made it.
    expect(rows[0]?.name).toBe('Default stages')
  })

  it('does nothing when the space already has templates', async () => {
    /**
     * Including when it has *no default* — someone can delete one deliberately, and putting it
     * back on the next dispatch would be a decision nobody made.
     */
    const { store, rows } = seedStore()
    rows.push(row({ name: 'theirs', isDefault: false }))

    expect(await ensureSeededStageTemplates({ store, scope: SCOPE, seed: SEED })).toBeUndefined()
    expect(rows).toHaveLength(1)
  })

  it('leaves resolution to find the seeded row rather than the constant', async () => {
    // After seeding, the stages a task runs come from the database. That is the difference
    // between configurable and merely default.
    const { store, rows } = seedStore()
    await ensureSeededStageTemplates({ store, scope: SCOPE, seed: SEED })

    const resolved = await resolveStages({
      store: {
        ...store,
        async getStageTemplate(id: string) {
          return rows.find((r) => r.id === id)
        },
      },
      scope: SCOPE,
      builtIn: BUILT_IN,
    })
    expect(resolved.source).toBe('space-default')
  })
})

describe('bringing forward templates from before prompts lived in the database', () => {
  /**
   * FOUND ON THE HOSTED PLANE. The stage editor showed an empty "what this stage should do" box
   * with "prompt from the bundle: prompts/code.md" underneath — so the one screen whose entire
   * purpose is saying what a stage does displayed nothing for the stages that already said it.
   *
   * The row was seeded by an image built before the prompts moved into the database. Nothing
   * writes `promptFile` any more, but the rows it wrote are still there.
   */
  function upgradeStore(rows: StageTemplateRow[]) {
    const saved: unknown[] = []
    return {
      saved,
      store: {
        async listStageTemplates() {
          return rows
        },
        async saveStageTemplate(input: never) {
          saved.push(input)
          return { ...(input as object) } as StageTemplateRow
        },
      },
    }
  }

  const legacy = (stages: unknown[]) =>
    row({ name: 'Default stages', isDefault: true, stages: stages as never })

  it('replaces a bundle path with the text it stood for', async () => {
    const { store, saved } = upgradeStore([
      legacy([
        { id: 'design', kind: 'agent', promptFile: 'prompts/design.md' },
        { id: 'branch', kind: 'builtin', action: 'git.create_branch' },
        { id: 'code', kind: 'agent', promptFile: 'prompts/code.md' },
      ]),
    ])

    expect(await upgradeLegacyPromptFiles({ store, scope: SCOPE })).toBe(1)

    const stages = (saved[0] as { stages: Array<Record<string, unknown>> }).stages
    expect(stages[0]?.['prompt']).toBe(DEFAULT_STAGE_PROMPTS['design'])
    // Dropped rather than kept alongside: two sources for one prompt is how the editor comes to
    // show something the run does not use.
    expect(stages[0]?.['promptFile']).toBeUndefined()
    expect(stages[2]?.['prompt']).toBe(DEFAULT_STAGE_PROMPTS['code'])
    // A builtin stage has no prompt to fill in and must come through untouched.
    expect(stages[1]?.['action']).toBe('git.create_branch')
  })

  it('never overwrites a prompt somebody wrote', async () => {
    // Both fields set is the state the editor produces when someone types over a legacy stage
    // and saves. The text they typed is the answer, and the stale path goes.
    const { store, saved } = upgradeStore([
      legacy([{ id: 'code', kind: 'agent', prompt: 'mine', promptFile: 'prompts/code.md' }]),
    ])

    expect(await upgradeLegacyPromptFiles({ store, scope: SCOPE })).toBe(0)
    expect(saved).toHaveLength(0)
  })

  it('leaves a bundle prompt for a stage we have no default for', async () => {
    /**
     * `promptFile` still exists for a bundle that genuinely ships its own prompts for stages we
     * know nothing about. Blanking those would delete the only instructions the stage had.
     */
    const { store, saved } = upgradeStore([
      legacy([{ id: 'lint', kind: 'agent', promptFile: 'prompts/lint.md' }]),
    ])

    expect(await upgradeLegacyPromptFiles({ store, scope: SCOPE })).toBe(0)
    expect(saved).toHaveLength(0)
  })

  it('writes nothing when every template is already inline', async () => {
    // Called on every load of the stages screen, so a no-op has to actually be a no-op — an
    // unconditional save would rewrite every row on every page view.
    const { store, saved } = upgradeStore([legacy([{ id: 'code', kind: 'agent', prompt: 'x' }])])

    expect(await upgradeLegacyPromptFiles({ store, scope: SCOPE })).toBe(0)
    expect(saved).toHaveLength(0)
  })
})
