import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillRef, StageId, StageTemplate, TaskBrief } from '@intellidev/shared'
import type { CommandRunner } from '../stages/types.js'
import type { RegisteredTool } from './registry.js'

/**
 * The gateway's own tools.
 *
 * These exist so a capability lives in one place instead of being ported per harness.
 * Anything reachable only through a harness's *configuration* is a per-harness cost
 * forever; anything reachable through MCP is written once.
 */

export interface BuiltinContext {
  task: TaskBrief
  template: StageTemplate
  /** Current stage, for `stage_state` and for scoping. */
  stage: () => StageId
  attempt: () => number
  commands: CommandRunner
  cwd: string
  /** Resolved skills, repo-native ones already winning over project and org. */
  skills: readonly SkillRef[]
  /** Where the bundle was unpacked, for resolving skill paths. */
  bundleRoot: string
  /** Called when the agent hands over structured output for a predicate gate. */
  onStageOutput: (stage: StageId, output: unknown) => void
  /** Recorded so an unattended run's open questions are visible afterwards. */
  onQuestion: (question: string) => void
  perCheckTimeoutSec?: number
  /**
   * Where artifacts go, when there is a control plane to keep them.
   *
   * Optional: the engine is also driven in tests and locally with no plane behind it, and a
   * tool that cannot work is better absent than present and failing — an agent that sees
   * `write_artifact` will use it.
   */
  artifacts?: ArtifactStore
}

/** The three calls the artifact tools need, so tests can stand in for the client. */
export interface ArtifactStore {
  put(input: {
    name: string
    kind: 'html' | 'markdown' | 'mermaid'
    body: string
    title?: string
    stage?: string
  }): Promise<{ name: string; kind: string; bytes: number; version?: number }>
  list(): Promise<
    Array<{
      name: string
      kind: string
      title?: string
      stage?: string
      bytes: number
      /** Which version is current and how many exist, so an earlier one can be asked for. */
      version?: number
      versionCount?: number
    }>
  >
  read(
    name: string,
    version?: number,
  ): Promise<{ name: string; kind: string; body: string } | undefined>
}

export interface BuiltinTool extends Omit<RegisteredTool, 'origin'> {
  handler: (input: Record<string, unknown>) => Promise<string>
}

/**
 * Named checks are derived from the stage template's command gates rather than
 * configured separately.
 *
 * That is deliberate: the agent then runs *exactly* the command its gate will run. A
 * separate list would drift, and an agent that passes its own check but fails the gate is
 * the most confusing possible outcome.
 */
export function availableChecks(template: StageTemplate): Array<{ name: string; command: string }> {
  const checks: Array<{ name: string; command: string }> = []
  for (const stage of template.stages) {
    if (stage.gate?.kind === 'command') checks.push({ name: stage.id, command: stage.gate.run })
  }
  return checks
}

export function buildBuiltinTools(ctx: BuiltinContext): BuiltinTool[] {
  const checks = availableChecks(ctx.template)

  return [
    {
      name: 'task_context',
      description:
        'The task being worked on: title, description, details and acceptance criteria. ' +
        'Read this before planning.',
      inputSchema: { type: 'object', properties: {} },
      stages: [],
      handler: async () =>
        JSON.stringify(
          {
            id: ctx.task.id,
            title: ctx.task.title,
            description: ctx.task.description,
            details: ctx.task.details ?? null,
            acceptanceCriteria: ctx.task.acceptanceCriteria,
          },
          null,
          2,
        ),
    },

    {
      name: 'stage_state',
      description:
        'Which stage is running, which attempt it is, and what its gate will check. ' +
        'Use this to understand what must be true before the stage can pass.',
      inputSchema: { type: 'object', properties: {} },
      stages: [],
      handler: async () => {
        const stage = ctx.stage()
        const definition = ctx.template.stages.find((s) => s.id === stage)
        return JSON.stringify(
          {
            stage,
            attempt: ctx.attempt(),
            gate: definition?.gate
              ? definition.gate.kind === 'command'
                ? { kind: 'command', command: definition.gate.run }
                : definition.gate.kind === 'predicate'
                  ? {
                      kind: 'predicate',
                      expression: definition.gate.expr,
                      schema: definition.gate.outputSchema,
                    }
                  : { kind: 'human', action: definition.gate.action }
              : null,
            maxAttempts: definition?.maxAttempts ?? 1,
            stages: ctx.template.stages.map((s) => s.id),
          },
          null,
          2,
        )
      },
    },

    {
      name: 'stage_advance',
      description:
        'Hand structured output to the current stage’s gate. Required for stages whose ' +
        'gate is a predicate — the gate evaluates this object, not your prose.',
      inputSchema: {
        type: 'object',
        required: ['output'],
        properties: {
          output: { type: 'object', description: 'Must satisfy the schema from stage_state.' },
        },
      },
      stages: [],
      handler: async (input) => {
        const output = input['output']
        if (output === undefined || output === null) {
          return 'error: stage_advance requires an "output" object'
        }
        ctx.onStageOutput(ctx.stage(), output)
        // The gate validates later; saying so here stops the agent assuming it passed.
        return 'Recorded. The gate will validate this against its schema when the stage ends.'
      },
    },

    {
      name: 'run_check',
      description:
        checks.length > 0
          ? `Run one of this project's checks: ${checks.map((c) => c.name).join(', ')}. ` +
            'These are the exact commands the gates run.'
          : 'No checks are configured for this project.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', enum: checks.map((c) => c.name) },
        },
      },
      stages: [],
      handler: async (input) => {
        const name = String(input['name'] ?? '')
        const check = checks.find((c) => c.name === name)
        if (!check) {
          return `error: no such check "${name}". Available: ${checks.map((c) => c.name).join(', ') || 'none'}`
        }
        const result = await ctx.commands.run(check.command, {
          cwd: ctx.cwd,
          timeoutSec: ctx.perCheckTimeoutSec ?? 900,
        })
        const output = `${result.stdout}\n${result.stderr}`.trim()
        return `$ ${check.command}\nexit ${result.exitCode}\n\n${output.slice(0, 8_000)}`
      },
    },

    {
      name: 'skill_list',
      description:
        'List the skills available for this project, with a one-line summary each. ' +
        'Load one with skill_load before following it.',
      inputSchema: { type: 'object', properties: {} },
      stages: [],
      handler: async () =>
        JSON.stringify(
          ctx.skills.map((skill) => ({
            name: skill.name,
            description: skill.description ?? null,
            origin: skill.origin,
          })),
          null,
          2,
        ),
    },

    {
      name: 'skill_load',
      description: 'Read the full text of one skill by name.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: { name: { type: 'string' } },
      },
      stages: [],
      handler: async (input) => {
        const name = String(input['name'] ?? '')
        const skill = ctx.skills.find((s) => s.name === name)
        if (!skill) {
          return `error: no skill named "${name}". Available: ${
            ctx.skills.map((s) => s.name).join(', ') || 'none'
          }`
        }
        try {
          // Skill paths come from the resolved set, never from the caller, so this
          // cannot be used to read arbitrary files.
          return await readFile(resolveSkillPath(ctx.bundleRoot, skill), 'utf8')
        } catch (error) {
          return `error: could not read skill "${name}": ${(error as Error).message}`
        }
      },
    },

    {
      name: 'ask_user',
      description:
        'Record a question for the humans watching this run. Unattended runs get no ' +
        'answer, so state your assumption and continue rather than waiting.',
      inputSchema: {
        type: 'object',
        required: ['question'],
        properties: { question: { type: 'string' } },
      },
      stages: [],
      handler: async (input) => {
        const question = String(input['question'] ?? '').trim()
        if (!question) return 'error: ask_user requires a question'
        ctx.onQuestion(question)
        // Honest rather than convenient: pretending an answer is coming would make the
        // agent wait, and a waiting agent burns the run's wall-clock budget for nothing.
        return (
          'Question recorded and shown to anyone watching this run. No human is attached, ' +
          'so proceed with your best judgement and state the assumption you made in your ' +
          'summary so a reviewer can check it.'
        )
      },
    },

    /**
     * Artifacts, only when there is somewhere to keep them.
     *
     * Spread rather than listed, because a tool an agent can see is a tool it will use: with no
     * control plane behind it — a local run, a test — `write_artifact` would accept a diagram
     * and lose it, which is worse than not offering it.
     */
    ...(ctx.artifacts ? artifactTools(ctx, ctx.artifacts) : []),
  ]
}

/**
 * Writing something down that is not code.
 *
 * The gap: a run produces an event log and a pull request, so a diagram the design stage worked
 * out survives only as prose — and the stage after it cannot read prose. These give it a name.
 */
function artifactTools(ctx: BuiltinContext, artifacts: ArtifactStore): BuiltinTool[] {
  return [
    {
      name: 'write_artifact',
      description:
        'Save a diagram, note or comparison under a name, for the later stages and for the ' +
        'people reviewing this task. Use mermaid for diagrams, markdown for notes, and html ' +
        'only when the layout itself matters. Writing the same name again saves a new ' +
        '*version* of it rather than a second artifact — so revise by reusing the name, and use ' +
        'a new name only for a genuinely different thing. Nothing is lost either way: earlier ' +
        'versions stay readable and a reviewer can switch between them.',
      inputSchema: {
        type: 'object',
        required: ['name', 'kind', 'body'],
        properties: {
          name: {
            type: 'string',
            description:
              'How later stages refer to it, like a filename — "architecture.mmd", ' +
              '"theme-comparison.md". Letters, digits, dot, dash and underscore.',
          },
          kind: { type: 'string', enum: ['mermaid', 'markdown', 'html'] },
          body: {
            type: 'string',
            description:
              'For mermaid, the diagram source on its own — no markdown fence around it.',
          },
          title: { type: 'string', description: 'A human-readable heading. Optional.' },
        },
      },
      stages: [],
      handler: async (input) => {
        const name = String(input['name'] ?? '').trim()
        const kind = String(input['kind'] ?? '')
        const body = typeof input['body'] === 'string' ? input['body'] : ''
        if (!name) return 'error: write_artifact requires a name'
        if (kind !== 'html' && kind !== 'markdown' && kind !== 'mermaid') {
          return 'error: kind must be one of mermaid, markdown, html'
        }
        if (!body.trim()) return 'error: write_artifact requires a non-empty body'

        try {
          const saved = await artifacts.put({
            name,
            kind,
            body,
            ...(typeof input['title'] === 'string' && input['title']
              ? { title: input['title'] }
              : {}),
            // Taken from the engine, not from the agent: which stage wrote something is a fact
            // about the run, and asking would invite a wrong answer.
            stage: ctx.stage(),
          })
          return (
            `Saved ${saved.name}${saved.version ? ` as version ${saved.version}` : ''} ` +
            `(${saved.kind}, ${saved.bytes} bytes). Later stages can read it with read_artifact.`
          )
        } catch (error) {
          /**
           * The control plane's own message, verbatim.
           *
           * It explains its limits in terms the agent can act on — "at most 1048576 bytes;
           * this one is 2200000" — and a generic failure here would leave it retrying the
           * same oversized body.
           */
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    {
      name: 'list_artifacts',
      description:
        'The artifacts already saved for this task, with their names and kinds. Read one ' +
        'with read_artifact before assuming what it contains.',
      inputSchema: { type: 'object', properties: {} },
      stages: [],
      handler: async () => {
        try {
          const listed = await artifacts.list()
          if (listed.length === 0) {
            return 'No artifacts yet for this task.'
          }
          // Without bodies: an agent deciding what to read does not need a megabyte of
          // markdown to make that decision.
          return JSON.stringify(listed, null, 2)
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },

    {
      name: 'read_artifact',
      description:
        'Read an artifact saved earlier in this task — for example the diagram the design ' +
        'stage produced. This is how a later stage builds on an earlier one. Reads the ' +
        'current version unless you ask for an earlier one by number.',
      inputSchema: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          version: {
            type: 'integer',
            description:
              'An earlier version, from list_artifacts. Omit for the current one, which is ' +
              'almost always what you want.',
          },
        },
      },
      stages: [],
      handler: async (input) => {
        const name = String(input['name'] ?? '').trim()
        if (!name) return 'error: read_artifact requires a name'
        /**
         * Tolerant of a model passing "1" or 1.5.
         *
         * A read that failed on the shape of an optional argument would be a worse outcome than
         * simply giving the current version, which is what was almost certainly wanted.
         */
        const asked = Number(input['version'])
        const version = Number.isInteger(asked) && asked >= 1 ? asked : undefined
        try {
          const found = await artifacts.read(name, version)
          if (!found) {
            // Naming what is there, so the next call is right rather than another guess.
            const available = await artifacts.list().catch(() => [])
            return available.length > 0
              ? `error: no artifact named "${name}". Available: ${available.map((a) => a.name).join(', ')}`
              : `error: no artifact named "${name}", and this task has none yet.`
          }
          return found.body
        } catch (error) {
          return `error: ${error instanceof Error ? error.message : String(error)}`
        }
      },
    },
  ]
}

/** Skill files live under the bundle unless the skill came from the repo itself. */
export function resolveSkillPath(bundleRoot: string, skill: SkillRef): string {
  const path = skill.path
  if (path.startsWith('/')) return path
  return join(skill.origin === 'repo' ? '' : bundleRoot, path) || path
}
