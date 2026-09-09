import Ajv, { type ValidateFunction } from 'ajv'
import { preview, type EventBodyInput, type Gate, type StageId } from '@intellidev/shared'
import { PredicateError, evaluatePredicate } from './predicate.js'
import type { CommandRunner, StageOutputSink } from './types.js'

export interface GateResult {
  passed: boolean
  detail: string
  exitCode?: number
  events: EventBodyInput[]
}

const ajv = new Ajv({ allErrors: true, strict: false })
const schemaCache = new Map<string, ValidateFunction>()

function compile(schema: Record<string, unknown>): ValidateFunction {
  const key = JSON.stringify(schema)
  const cached = schemaCache.get(key)
  if (cached) return cached
  const validate = ajv.compile(schema)
  schemaCache.set(key, validate)
  return validate
}

/**
 * Evaluate a stage's gate.
 *
 * Three kinds, and the ordering of checks matters: a predicate gate validates the
 * agent's structured output against its JSON Schema *before* evaluating the
 * expression, so a malformed output fails the gate for a reportable reason rather
 * than evaluating to `false` for a mysterious one.
 *
 * A human gate never decides here. It parks the run and waits for a UI decision,
 * which is the only correct behaviour for an irreversible edge.
 */
export async function evaluateGate(args: {
  gate: Gate
  stage: StageId
  cwd: string
  timeoutSec: number
  commands: CommandRunner
  outputs: StageOutputSink
}): Promise<GateResult> {
  const { gate, stage, cwd, commands, outputs } = args

  if (gate.kind === 'command') {
    const timeoutSec = Math.min(gate.timeoutSec, args.timeoutSec)
    const result = await commands.run(gate.run, { cwd, timeoutSec })
    const passed = result.exitCode === 0
    // Failure output is what the next attempt has to work from, so the tail of
    // stderr matters more than the head of stdout.
    const detail = passed
      ? preview(result.stdout).text
      : preview(`exit ${result.exitCode}\n${result.stderr || result.stdout}`).text
    return {
      passed,
      detail,
      exitCode: result.exitCode,
      events: [
        {
          type: 'gate.evaluated',
          data: { kind: 'command', passed, label: gate.run, detail, exitCode: result.exitCode },
        },
      ],
    }
  }

  if (gate.kind === 'predicate') {
    const output = outputs.take(stage)
    if (output === undefined) {
      const detail = `stage "${stage}" produced no structured output; expected a stage_advance call`
      return {
        passed: false,
        detail,
        events: [
          {
            type: 'gate.evaluated',
            data: { kind: 'predicate', passed: false, label: gate.expr, detail },
          },
        ],
      }
    }

    const validate = compile(gate.outputSchema as Record<string, unknown>)
    if (!validate(output)) {
      const detail = preview(
        `output failed schema: ${ajv.errorsText(validate.errors, { separator: '; ' })}`,
      ).text
      return {
        passed: false,
        detail,
        events: [
          {
            type: 'gate.evaluated',
            data: { kind: 'predicate', passed: false, label: gate.expr, detail },
          },
        ],
      }
    }

    try {
      const passed = evaluatePredicate(gate.expr, output)
      const detail = `${gate.expr} → ${passed}`
      return {
        passed,
        detail,
        events: [
          { type: 'gate.evaluated', data: { kind: 'predicate', passed, label: gate.expr, detail } },
        ],
      }
    } catch (error) {
      // A broken expression is a configuration bug, not a failing stage. Say so
      // rather than letting it read as the agent's fault.
      const message = error instanceof PredicateError ? error.message : String(error)
      const detail = `invalid gate expression: ${message}`
      return {
        passed: false,
        detail,
        events: [
          { type: 'gate.evaluated', data: { kind: 'predicate', passed: false, detail } },
          {
            type: 'error',
            data: { code: 'bad_gate_expression', message: detail, retryable: false },
          },
        ],
      }
    }
  }

  // Human gate: park, do not decide.
  const detail = `awaiting approval: ${gate.action}`
  return {
    passed: false,
    detail,
    events: [
      {
        type: 'gate.evaluated',
        data: { kind: 'human', passed: false, label: gate.action, detail },
      },
      {
        type: 'approval.requested',
        data: { approvalId: `${stage}:${gate.action}`, action: gate.action, detail },
      },
    ],
  }
}
