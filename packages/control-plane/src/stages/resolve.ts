import { StageTemplate } from '@intellidev/shared'
import type { ProjectScope, StageTemplateRow, Store } from '../store/types.js'

/**
 * Which stages a task runs, and where that decision came from.
 *
 * Five places can decide, and they are tried most specific first:
 *
 *  1. **stages on the task** — an inline array, pinned to that task. Editing a template later
 *     does not change a task that carried its own.
 *  2. **a template the task chose** — follows that template, including later edits.
 *  3. **the project's default** — what a new task in this project picks up.
 *  4. **the space's default** — what every project in the space inherits.
 *  5. **the built-in** — what an unconfigured space runs, which is what everything ran before
 *     any of this existed.
 *
 * The order is the whole design. Each level exists because the one above it is too specific to
 * be a policy and the one below too general to be an exception, and every level is optional — so
 * a space that configures nothing behaves exactly as it did.
 *
 * `source` is returned alongside because "why did this task run those stages" is the question
 * people actually ask, and answering it from four nullable columns after the fact is guesswork.
 */
export type StageSource =
  'task-inline' | 'task-template' | 'project-default' | 'space-default' | 'built-in'

/** The two scopes a template can belong to. */
export type StageScope = Pick<ProjectScope, 'projectId' | 'clientSpaceId'>

export interface ResolvedStages {
  template: StageTemplate
  source: StageSource
  /** Absent for an inline or built-in template, which have no row. */
  templateId?: string
}

export interface ResolveStagesInput {
  /**
   * Narrowed so a caller need not hold a whole `Store`.
   *
   * `listStageTemplates` is retyped to take the narrower scope: the Postgres and in-memory
   * implementations read only the two ids, and requiring a `workspaceId` here would push the
   * same invented value back onto every caller.
   */
  store: {
    getStageTemplate: Store['getStageTemplate']
    listStageTemplates(scope: StageScope): Promise<Awaited<ReturnType<Store['listStageTemplates']>>>
  }
  /**
   * Space and project only.
   *
   * Narrower than `ProjectScope` because that is all resolution reads, and the alternative was a
   * caller inventing an empty `workspaceId` to satisfy a field nothing here looks at — a lie in
   * the type to keep a signature happy.
   */
  scope: StageScope
  /** What the task itself says, if anything. */
  task?: {
    stages?: unknown
    stageTemplateId?: string | undefined
  }
  /**
   * The template to fall back to, built by the caller.
   *
   * Passed in rather than imported because the built-in default is not fixed: it adapts to the
   * repository — a `file://` origin has no GitHub to open a pull request against — and only the
   * caller knows that. Resolution's job is the *order*, not the last resort.
   */
  builtIn: StageTemplate
}

export async function resolveStages(input: ResolveStagesInput): Promise<ResolvedStages> {
  const { store, scope, task, builtIn } = input

  /**
   * Inline stages on the task win, and are validated here.
   *
   * A task pinned to a bad array must fail visibly at dispatch rather than reach a container and
   * die at stage one — the difference between a rejected dispatch and a spent container.
   */
  if (Array.isArray(task?.stages) && task.stages.length > 0) {
    return {
      template: StageTemplate.parse({ name: 'task', stages: task.stages }),
      source: 'task-inline',
    }
  }

  if (task?.stageTemplateId) {
    const chosen = await store.getStageTemplate(task.stageTemplateId)
    /**
     * A missing template falls through rather than failing.
     *
     * The column is `ON DELETE SET NULL`, so this is the narrow window where a template was
     * deleted between a task being created and dispatched. Refusing the run would be a strange
     * punishment for a task that was configured correctly when it was made; the project default
     * is what it would have picked up a moment earlier.
     */
    if (chosen && belongsTo(chosen, scope)) {
      return {
        template: StageTemplate.parse({ name: chosen.name, stages: chosen.stages }),
        source: 'task-template',
        templateId: chosen.id,
      }
    }
  }

  // One query for both scopes; the store returns a project's own first.
  const available = await store.listStageTemplates(scope)

  const projectDefault = available.find((t) => t.projectId === scope.projectId && t.isDefault)
  if (projectDefault) {
    return {
      template: StageTemplate.parse({ name: projectDefault.name, stages: projectDefault.stages }),
      source: 'project-default',
      templateId: projectDefault.id,
    }
  }

  const spaceDefault = available.find((t) => t.projectId === undefined && t.isDefault)
  if (spaceDefault) {
    return {
      template: StageTemplate.parse({ name: spaceDefault.name, stages: spaceDefault.stages }),
      source: 'space-default',
      templateId: spaceDefault.id,
    }
  }

  return { template: builtIn, source: 'built-in' }
}

/**
 * Whether a template may be used by this task at all.
 *
 * Checked even though RLS already scopes reads: dispatch runs as the service role, which RLS does
 * not constrain. A task id pointing at another space's template would otherwise run that space's
 * stages — the one place where "the database will catch it" is not true.
 */
function belongsTo(template: StageTemplateRow, scope: StageScope): boolean {
  if (template.clientSpaceId !== scope.clientSpaceId) return false
  return template.projectId === undefined || template.projectId === scope.projectId
}

/**
 * Give a client space a real template row the first time anyone needs one.
 *
 * Without this the built-in template is a constant in the source, and "configure your stages"
 * means editing a file — which is what the whole feature exists to stop. Seeding turns it into a
 * row: the same stages, in the database, editable in the UI, referenced by id like everything
 * else.
 *
 * Only when the space has none. It is a starting point, not a policy: a space that has since
 * deleted or rewritten its templates must not have this quietly put one back.
 *
 * Idempotent by that check rather than by an upsert, because a space *may* legitimately have no
 * default — someone can delete it — and re-creating it on the next dispatch would be a decision
 * nobody made.
 */
export async function ensureSeededStageTemplates(input: {
  store: {
    // Narrowed for the same reason `resolveStages` is: these read two ids, and demanding a
    // `workspaceId` would push an invented value back onto every caller.
    listStageTemplates(scope: StageScope): Promise<Awaited<ReturnType<Store['listStageTemplates']>>>
    saveStageTemplate: Store['saveStageTemplate']
  }
  scope: StageScope
  /** The stages to seed from, built by the caller for this repository. */
  seed: StageTemplate
}): Promise<StageTemplateRow | undefined> {
  const existing = await input.store.listStageTemplates(input.scope)
  // Any template at all means somebody has been here. Seeding on top would add a second one
  // nobody asked for, next to the ones they made.
  if (existing.length > 0) return undefined

  return await input.store.saveStageTemplate({
    clientSpaceId: input.scope.clientSpaceId,
    // Space level, so every project in the space starts from it and any of them may override.
    name: input.seed.name === 'built-in' ? 'Default stages' : input.seed.name,
    description: 'Created automatically from the built-in stages. Edit or replace it freely.',
    stages: input.seed.stages,
    isDefault: true,
  })
}
