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
  ]
}

/** Skill files live under the bundle unless the skill came from the repo itself. */
export function resolveSkillPath(bundleRoot: string, skill: SkillRef): string {
  const path = skill.path
  if (path.startsWith('/')) return path
  return join(skill.origin === 'repo' ? '' : bundleRoot, path) || path
}
