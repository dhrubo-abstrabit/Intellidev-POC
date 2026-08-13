import type {
  EventBodyInput,
  HarnessId,
  RunOutcome,
  StageDefinition,
  StageId,
  StageTemplate,
} from '@intellidev/shared'
import type { EventBus } from '../events/bus.js'
import type { HarnessDriver, StageRequest } from '../driver/types.js'
import { evaluateGate } from './gates.js'
import { initialState } from './state.js'
import type {
  BuiltinActions,
  CommandRunner,
  RunState,
  RunStateStore,
  StageContext,
  StageOutputSink,
} from './types.js'

export interface StageEngineDeps {
  runId: string
  cwd: string
  template: StageTemplate
  defaultHarness: HarnessId
  drivers: Partial<Record<HarnessId, HarnessDriver>>
  commands: CommandRunner
  builtins: BuiltinActions
  outputs: StageOutputSink
  store: RunStateStore
  bus: EventBus
  /** Prompt text per stage, already rendered from the bundle. */
  prompts: Partial<Record<StageId, string>>
  perStageTimeoutSec?: number
  /**
   * Backstop against a template that can cycle forever. `maxAttempts` bounds each
   * gate, but a pathological onFail graph could still ping-pong between stages.
   */
  maxTotalStageRuns?: number
  /**
   * Called when a stage is entered, before it runs.
   *
   * Exists so the engine does not have to know about the credential broker or the MCP
   * gateway: both need to know which stage is current, and wiring them in here would make
   * the state machine depend on both. Awaited, because stage-scoped secrets have to be in
   * place before the stage starts.
   */
  onStageEnter?: (stage: StageId, attempt: number) => Promise<void>
  /**
   * Environment for the harness process.
   *
   * Carries two things the harness genuinely needs: the gateway bearer token (Codex reads
   * it from the environment rather than config) and the stage's resolved project secrets,
   * because the agent runs the same tests the gate will run and they read `process.env`.
   */
  env?: () => Record<string, string>
  now?: () => Date
}

export interface RunResult {
  outcome: RunOutcome
  state: RunState
}

/**
 * The stage machine.
 *
 * A prompt is advice; a gate is enforcement. This is the thing that enforces.
 *
 * Two rules that are easy to get wrong and expensive to discover late:
 *
 *  - `maxAttempts` bounds how many times a stage's **gate may fail**, not how many
 *    times the stage may be entered. A stage with no gate (`code`) must be
 *    re-enterable without limit, or looping back to it would immediately fail.
 *  - Every transition is persisted **before** the next stage starts, so a process
 *    killed mid-stage resumes at that stage rather than at the top.
 */
export class StageEngine {
  private readonly perStageTimeoutSec: number
  private readonly maxTotalStageRuns: number
  private readonly now: () => Date

  constructor(private readonly deps: StageEngineDeps) {
    this.perStageTimeoutSec = deps.perStageTimeoutSec ?? 1_800
    this.maxTotalStageRuns = deps.maxTotalStageRuns ?? 50
    this.now = deps.now ?? (() => new Date())
  }

  private get stages(): StageDefinition[] {
    return this.deps.template.stages
  }

  private indexOf(stage: StageId): number {
    return this.stages.findIndex((s) => s.id === stage)
  }

  /** Resume from persisted state if there is any, otherwise start clean. */
  async run(): Promise<RunResult> {
    const loaded = await this.deps.store.load()
    const state = loaded ?? initialState(this.deps.runId, this.deps.template.name)

    if (loaded && loaded.status !== 'running') {
      // Already settled; do not re-run a finished template.
      return { outcome: outcomeFor(loaded.status), state: loaded }
    }

    while (state.cursor < this.stages.length) {
      const stage = this.stages[state.cursor]
      if (!stage) break

      if (!stage.enabled) {
        state.cursor++
        await this.deps.store.save(state)
        continue
      }

      if (state.totalStageRuns >= this.maxTotalStageRuns) {
        return this.fail(state, `exceeded ${this.maxTotalStageRuns} stage runs`)
      }

      const settled = await this.runStage(stage, state)
      if (settled) return settled
    }

    state.status = 'succeeded'
    await this.deps.store.save(state)
    this.deps.bus.emit({ type: 'run.finished', data: { outcome: 'succeeded' } })
    return { outcome: 'succeeded', state }
  }

  private async runStage(stage: StageDefinition, state: RunState): Promise<RunResult | null> {
    const visits = (state.visits[stage.id] ?? 0) + 1
    state.visits[stage.id] = visits
    state.totalStageRuns++

    this.deps.bus.enterStage(stage.id)
    const startedAt = this.now().toISOString()
    this.deps.bus.emit({ type: 'stage.entered', data: { attempt: visits } })
    // Before the stage runs: secrets scoped to it, and gateway filtering pointed at it.
    if (this.deps.onStageEnter) await this.deps.onStageEnter(stage.id, visits)

    const harness = stage.harness ?? this.deps.defaultHarness
    const ctx: StageContext = {
      runId: this.deps.runId,
      stage: stage.id,
      attempt: visits,
      cwd: this.deps.cwd,
      harness,
      ...(state.resumeTokens[stage.id] ? { resume: state.resumeTokens[stage.id] } : {}),
      pendingSteers: [...state.pendingSteers],
    }

    let failure: string | null = null
    try {
      if (stage.kind === 'builtin') {
        await this.runBuiltin(stage, ctx)
      } else {
        await this.runAgent(stage, ctx, state)
      }
    } catch (error) {
      failure = error instanceof Error ? error.message : String(error)
      this.deps.bus.emit({
        type: 'error',
        data: { code: 'stage_threw', message: failure, retryable: false },
      })
    }

    if (failure) {
      this.record(state, stage, visits, 'failed', startedAt, harness, null, failure)
      this.exitStage(stage, visits, 'failed', startedAt)
      return this.fail(state, `stage "${stage.id}" failed: ${failure}`)
    }

    // No gate means the stage is done the moment it returns.
    if (!stage.gate) {
      this.record(state, stage, visits, 'passed', startedAt, harness, null)
      this.exitStage(stage, visits, 'passed', startedAt)
      state.cursor++
      await this.deps.store.save(state)
      return null
    }

    const gate = await evaluateGate({
      gate: stage.gate,
      stage: stage.id,
      cwd: this.deps.cwd,
      timeoutSec: this.perStageTimeoutSec,
      commands: this.deps.commands,
      outputs: this.deps.outputs,
    })
    for (const event of gate.events) this.deps.bus.emit(event)

    if (gate.passed) {
      this.record(state, stage, visits, 'passed', startedAt, harness, true, gate.detail)
      this.exitStage(stage, visits, 'passed', startedAt)
      state.cursor++
      await this.deps.store.save(state)
      return null
    }

    // A human gate is not a failure — it is a pause with a decision outstanding.
    if (stage.gate.kind === 'human') {
      this.record(state, stage, visits, 'parked', startedAt, harness, null, gate.detail)
      this.exitStage(stage, visits, 'skipped', startedAt)
      state.status = 'parked'
      await this.deps.store.save(state)
      this.deps.bus.emit({
        type: 'run.finished',
        data: { outcome: 'parked', reason: gate.detail },
      })
      return { outcome: 'parked', state }
    }

    const failures = (state.gateFailures[stage.id] ?? 0) + 1
    state.gateFailures[stage.id] = failures
    const exhausted = failures >= stage.maxAttempts
    const target = exhausted ? undefined : stage.onFail

    this.deps.bus.emit({
      type: 'gate.blocked',
      data: {
        reason: gate.detail,
        attemptsUsed: failures,
        attemptsAllowed: stage.maxAttempts,
        ...(target ? { nextStage: target } : {}),
      },
    })
    this.record(state, stage, visits, 'failed', startedAt, harness, false, gate.detail)
    this.exitStage(stage, visits, 'failed', startedAt)

    if (!target) {
      return this.fail(
        state,
        `stage "${stage.id}" gate failed ${failures}/${stage.maxAttempts}: ${gate.detail}`,
      )
    }

    const targetIndex = this.indexOf(target)
    if (targetIndex === -1) {
      // The template validator rejects this, so reaching it means state was hand-edited.
      return this.fail(state, `onFail target "${target}" is not in template`)
    }
    state.cursor = targetIndex
    await this.deps.store.save(state)
    return null
  }

  private async runBuiltin(stage: StageDefinition, ctx: StageContext): Promise<void> {
    switch (stage.action) {
      case 'git.create_branch': {
        const { branch, from } = await this.deps.builtins.createBranch(ctx)
        this.deps.bus.emit({ type: 'git.branch_created', data: { branch, from } })
        return
      }
      case 'github.open_pr': {
        const pr = await this.deps.builtins.openPullRequest(ctx)
        this.deps.bus.emit({
          type: 'pr.opened',
          data: { number: pr.number, url: pr.url, base: 'main', head: ctx.stage },
        })
        return
      }
      default:
        throw new Error(`builtin stage "${stage.id}" has no action`)
    }
  }

  private async runAgent(
    stage: StageDefinition,
    ctx: StageContext,
    state: RunState,
  ): Promise<void> {
    const driver = this.deps.drivers[ctx.harness]
    if (!driver) throw new Error(`no driver registered for harness "${ctx.harness}"`)

    const prompt = this.deps.prompts[stage.id]
    if (!prompt) throw new Error(`no prompt rendered for stage "${stage.id}"`)

    const req: StageRequest = {
      stage: stage.id,
      prompt: this.withPendingSteers(prompt, ctx.pendingSteers),
      cwd: ctx.cwd,
      timeoutSec: this.perStageTimeoutSec,
      ...(stage.model ? { model: stage.model } : {}),
      ...(ctx.resume ? { resume: ctx.resume } : {}),
      ...(this.deps.env ? { env: this.deps.env() } : {}),
    }

    const session = await driver.start(req)
    // Steers folded into the prompt above have been delivered; anything queued from
    // here belongs to whatever comes next.
    state.pendingSteers = []

    for await (const event of session.events) this.deps.bus.emit(event)
    await session.done()

    if (session.resumeToken) state.resumeTokens[stage.id] = session.resumeToken

    // A harness with no mid-run steering hands back whatever arrived too late.
    const undelivered = session.pendingSteers()
    if (undelivered.length > 0) state.pendingSteers.push(...undelivered)
  }

  /**
   * Codex cannot take a steer mid-turn, so one that arrived during the previous
   * attempt is prepended to this attempt's prompt. Dropping it would lose something
   * a human typed.
   */
  private withPendingSteers(prompt: string, steers: string[]): string {
    if (steers.length === 0) return prompt
    const notes = steers.map((text) => `- ${text}`).join('\n')
    return `Additional instructions received since the last attempt:\n${notes}\n\n${prompt}`
  }

  private record(
    state: RunState,
    stage: StageDefinition,
    attempt: number,
    status: 'passed' | 'failed' | 'parked' | 'skipped',
    startedAt: string,
    harness: HarnessId,
    gatePassed: boolean | null,
    detail?: string,
  ): void {
    state.records.push({
      stage: stage.id,
      attempt,
      status,
      harness,
      resumeToken: state.resumeTokens[stage.id] ?? null,
      gatePassed,
      ...(detail ? { gateDetail: detail } : {}),
      startedAt,
      endedAt: this.now().toISOString(),
    })
  }

  private exitStage(
    stage: StageDefinition,
    attempt: number,
    outcome: 'passed' | 'failed' | 'skipped',
    startedAt: string,
  ): void {
    this.deps.bus.emit({
      type: 'stage.exited',
      data: {
        attempt,
        outcome,
        durationMs: Math.max(0, this.now().getTime() - new Date(startedAt).getTime()),
      },
    })
  }

  private async fail(state: RunState, reason: string): Promise<RunResult> {
    state.status = 'failed'
    state.failureReason = reason
    await this.deps.store.save(state)
    this.deps.bus.emit({ type: 'run.finished', data: { outcome: 'failed', reason } })
    return { outcome: 'failed', state }
  }
}

function outcomeFor(status: RunState['status']): RunOutcome {
  switch (status) {
    case 'succeeded':
      return 'succeeded'
    case 'parked':
      return 'parked'
    case 'cancelled':
      return 'cancelled'
    default:
      return 'failed'
  }
}

/** Convenience for tests and the bootstrap path. */
export function collectEvents(): { sink: (event: { type: string }) => void; types: string[] } {
  const types: string[] = []
  return { sink: (event) => types.push(event.type), types }
}

export type { EventBodyInput }
