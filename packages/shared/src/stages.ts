import { z } from 'zod'
import { HarnessId, StageId } from './ids.js'

/**
 * Stages are a state machine the adapter owns, not a paragraph in a prompt.
 * A prompt is advice; a gate is enforcement.
 */

/** Deterministic and cheap. Prefer this gate wherever a command can decide. */
export const CommandGate = z.object({
  kind: z.literal('command'),
  run: z.string().min(1),
  timeoutSec: z.number().int().positive().default(900),
})

/**
 * The agent hands structured output to `stage_advance` on the MCP gateway and the
 * adapter validates it, so we never parse prose to decide a transition.
 */
export const PredicateGate = z.object({
  kind: z.literal('predicate'),
  /** JSON Schema the stage output must satisfy. */
  outputSchema: z.record(z.unknown()),
  /** Expression over the validated output, e.g. `findings.blocking == 0`. */
  expr: z.string().min(1),
})

/** Only for irreversible edges — opening a PR, applying a migration. */
export const HumanGate = z.object({
  kind: z.literal('human'),
  action: z.string().min(1),
  /** 0 means park indefinitely until someone decides. */
  timeoutSec: z.number().int().nonnegative().default(0),
})

export const Gate = z.discriminatedUnion('kind', [CommandGate, PredicateGate, HumanGate])
export type Gate = z.infer<typeof Gate>

/**
 * What the harness may touch during a stage. Enforced by the adapter's MCP
 * gateway rather than by each harness's own permission model, so the policy is
 * identical across harnesses instead of degrading to the weakest one.
 */
export const ToolPolicy = z.object({
  mode: z.enum(['none', 'read_only', 'full']),
  allow: z.array(z.string()).default([]),
  deny: z.array(z.string()).default([]),
})
export type ToolPolicy = z.infer<typeof ToolPolicy>

/** Builtin stages run no agent at all — they are ours, and deterministic. */
export const BuiltinAction = z.enum(['git.create_branch', 'git.commit', 'github.open_pr'])
export type BuiltinAction = z.infer<typeof BuiltinAction>

export const StageDefinition = z
  .object({
    id: StageId,
    kind: z.enum(['agent', 'builtin']),
    /** Overrides the project default — this is what enables cross-model review. */
    harness: HarnessId.optional(),
    model: z.string().optional(),
    /** Path inside the project bundle, e.g. `prompts/design.md`. */
    promptFile: z.string().optional(),
    tools: ToolPolicy.default({ mode: 'none', allow: [], deny: [] }),
    gate: Gate.optional(),
    maxAttempts: z.number().int().positive().default(1),
    /** Where a failed gate routes to. Absent means the run fails here. */
    onFail: StageId.optional(),
    action: BuiltinAction.optional(),
    /** Skipped stages stay in the template so the UI can show them greyed. */
    enabled: z.boolean().default(true),
  })
  .superRefine((stage, ctx) => {
    if (stage.kind === 'builtin' && !stage.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `builtin stage "${stage.id}" needs an action`,
        path: ['action'],
      })
    }
    if (stage.kind === 'agent' && stage.action) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `agent stage "${stage.id}" must not set an action`,
        path: ['action'],
      })
    }
    if (stage.kind === 'agent' && !stage.promptFile) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `agent stage "${stage.id}" needs a promptFile`,
        path: ['promptFile'],
      })
    }
  })
export type StageDefinition = z.infer<typeof StageDefinition>

export const StageTemplate = z
  .object({
    name: z.string().min(1),
    stages: z.array(StageDefinition).min(1),
  })
  .superRefine((template, ctx) => {
    const ids = template.stages.map((s) => s.id)
    const seen = new Set<string>()
    for (const [i, id] of ids.entries()) {
      if (seen.has(id)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `duplicate stage "${id}"`,
          path: ['stages', i, 'id'],
        })
      }
      seen.add(id)
    }
    for (const [i, stage] of template.stages.entries()) {
      if (stage.onFail && !seen.has(stage.onFail) && !ids.includes(stage.onFail)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stage "${stage.id}" routes onFail to "${stage.onFail}", which is not in this template`,
          path: ['stages', i, 'onFail'],
        })
      }
      if (stage.gate && stage.maxAttempts > 1 && !stage.onFail) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `stage "${stage.id}" allows ${stage.maxAttempts} attempts but has no onFail target, so retries would have nowhere to go`,
          path: ['stages', i, 'onFail'],
        })
      }
    }
  })
export type StageTemplate = z.infer<typeof StageTemplate>

/**
 * The M0 default: design → branch → code → verify → test → review → pr.
 * `approval` is omitted until M1; add it before `pr` when human gates land.
 */
export const DEFAULT_STAGE_TEMPLATE: z.input<typeof StageTemplate> = {
  name: 'feature-default',
  stages: [
    {
      id: 'design',
      kind: 'agent',
      promptFile: 'prompts/design.md',
      tools: { mode: 'read_only' },
      maxAttempts: 1,
    },
    {
      id: 'branch',
      kind: 'builtin',
      action: 'git.create_branch',
    },
    {
      id: 'code',
      kind: 'agent',
      promptFile: 'prompts/code.md',
      tools: { mode: 'full' },
      maxAttempts: 1,
    },
    {
      id: 'verify',
      kind: 'agent',
      promptFile: 'prompts/fix.md',
      tools: { mode: 'full' },
      gate: { kind: 'command', run: 'pnpm lint && pnpm typecheck' },
      maxAttempts: 3,
      onFail: 'code',
    },
    {
      id: 'test',
      kind: 'agent',
      promptFile: 'prompts/fix.md',
      tools: { mode: 'full' },
      gate: { kind: 'command', run: 'pnpm test' },
      maxAttempts: 3,
      onFail: 'code',
    },
    {
      id: 'review',
      kind: 'agent',
      // Cross-model review: the default harness writes, a different one reviews.
      harness: 'claude-code',
      promptFile: 'prompts/review.md',
      tools: { mode: 'read_only' },
      gate: {
        kind: 'predicate',
        expr: 'blocking == 0',
        outputSchema: {
          type: 'object',
          required: ['blocking', 'findings'],
          properties: {
            blocking: { type: 'integer', minimum: 0 },
            findings: {
              type: 'array',
              items: {
                type: 'object',
                required: ['severity', 'file', 'summary'],
                properties: {
                  severity: { enum: ['blocking', 'suggestion'] },
                  file: { type: 'string' },
                  line: { type: 'integer' },
                  summary: { type: 'string' },
                },
              },
            },
          },
        },
      },
      maxAttempts: 2,
      onFail: 'code',
    },
    {
      // After the gates, before the PR: the gates run against the worktree and need no
      // commit, and committing earlier would put work the review rejected into history.
      id: 'commit',
      kind: 'builtin',
      action: 'git.commit',
    },
    {
      id: 'pr',
      kind: 'builtin',
      action: 'github.open_pr',
    },
  ],
}
