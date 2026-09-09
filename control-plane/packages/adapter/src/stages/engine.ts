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
  /**
   * What the worktree looks like now, as changed paths.
   *
   * Used to check that a stage which may not write did not write. Optional because the engine
   * is also driven in tests and by callers with no repository, and a question that cannot be
   * answered is better left unasked than answered wrongly.
   */
  worktreeStatus?: (cwd: string) => Promise<string[]>
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

    if (!failure && stage.kind !== 'builtin' && stage.tools.mode !== 'full') {
      failure = await this.readOnlyViolation(stage, ctx.cwd)
      if (failure) {
        this.deps.bus.emit({
          type: 'error',
          data: { code: 'stage_wrote_files', message: failure, retryable: false },
        })
      }
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
      return await this.advance(stage, state, ctx)
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
      return await this.advance(stage, state, ctx)
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
      case 'git.commit': {
        // Emitting nothing when there is nothing to commit is deliberate: a run whose agent
        // changed no files should leave no `git.committed` in the log to explain away.
        await this.deps.builtins.commit(ctx)
        return
      }
      case 'github.open_pr': {
        const pr = await this.deps.builtins.openPullRequest(ctx)
        this.deps.bus.emit({
          type: 'pr.opened',
          data: {
            number: pr.number,
            url: pr.url,
            // What the builtin actually pushed and targeted. This used to be the stage id and a
            // hard-coded "main", which meant the log named a branch that never existed.
            base: pr.base ?? 'main',
            head: pr.head ?? ctx.stage,
          },
        })
        return
      }
      default:
        throw new Error(`builtin stage "${stage.id}" has no action`)
    }
  }

  /**
   * Move past a stage that succeeded — or stop, if somebody has to look at it first.
   *
   * The cursor advances either way. That is deliberate: the stage *did* succeed, and a resumed
   * run should continue at the next one rather than repeat work that was already approved. It
   * also means nothing can re-ask for a decision that was already given, because the stage is
   * behind the cursor.
   *
   * Approval is not enforced here, and cannot be. A container is the thing being controlled, so
   * a check inside it would be advice rather than a boundary — the control plane refuses to
   * resume a parked run until a decision is recorded, which is where the authenticated caller
   * and the audit trail already are.
   *
   * `parked` rather than a new status because it is exactly what the word already means here: a
   * non-terminal stop with a decision outstanding. The reconciler, `settle`, and the product
   * status projection all understand it, and adding a synonym would mean teaching them twice.
   */
  private async advance(
    stage: StageDefinition,
    state: RunState,
    /** The stage's own context, so `preserveWork` runs against the same worktree it did. */
    ctx: StageContext,
  ): Promise<RunResult | null> {
    state.cursor++

    if (!stage.requiresApproval || state.approvals?.[stage.id] === 'approved') {
      await this.deps.store.save(state)
      return null
    }

    /**
     * The work is made durable *before* the run parks.
     *
     * Parking destroys the container, so anything left in the worktree is gone — and the
     * natural place for a gate is between `code` and `commit`, where the work is precisely
     * what has not been committed yet. Without this, approving a run produced an empty one:
     * `commit` committed nothing and `pr` reported "no files changed".
     *
     * Failing rather than parking when this does not work. A run that parks having lost the
     * work would ask somebody to approve something that no longer exists, and then resume into
     * nothing — the failure is the same either way, but this one says so before wasting a
     * person's attention on it.
     */
    if (this.deps.builtins.preserveWork) {
      const cursorAtGate = state.cursor
      try {
        // No event of its own: `preserveWork` commits and pushes, and both already announce
        // themselves as `git.committed` and `git.pushed`. A third event saying the same thing
        // would be one more shape for the control plane to validate and keep in step.
        await this.deps.builtins.preserveWork(ctx)
      } catch (error) {
        // The cursor is put back: the stage is over, but the run is not parked, and leaving it
        // advanced would make a retry skip the stage whose output was lost.
        state.cursor = cursorAtGate - 1
        return this.fail(
          state,
          `could not preserve the work of "${stage.id}" before pausing for approval: ` +
            `${error instanceof Error ? error.message : String(error)}`,
        )
      }
    }

    state.status = 'parked'
    await this.deps.store.save(state)
    /**
     * Two events, because they say different things.
     *
     * `approval.requested` is what a UI listens for to put a decision in front of someone.
     * `run.finished` is what the control plane settles on — the container is about to exit, and
     * a run that stops without saying so looks like a crash to the reconciler.
     */
    this.deps.bus.emit({
      type: 'approval.requested',
      data: {
        approvalId: `${state.runId}:${stage.id}`,
        action: `approve the ${stage.id} stage`,
        detail: `${stage.id} finished and needs approval before the run continues`,
      },
    })
    this.deps.bus.emit({
      type: 'run.finished',
      data: { outcome: 'parked', reason: `awaiting approval after "${stage.id}"` },
    })
    return { outcome: 'parked', state }
  }

  /**
   * Whether a stage that may not write, wrote.
   *
   * The harnesses used to enforce this themselves — codex through its sandbox, and the others
   * through tool permissions. Inside a run container codex's sandbox cannot start at all, so it
   * is told not to try, and this is what replaces it: the contract is checked rather than
   * assumed, for every harness rather than the one that happened to enforce it.
   *
   * Worth having regardless. "The design stage quietly wrote code" is the kind of thing that
   * surfaces as a confusing diff three stages later, and a stage that reports success having
   * broken its own contract is worse than one that fails.
   */
  private async readOnlyViolation(stage: StageDefinition, cwd: string): Promise<string | null> {
    // Its own seam rather than the stage CommandRunner: that runner executes whatever a
    // template asks for, and asking it for `git status` assumes it is git-capable and honest.
    // A caller that cannot answer the question does not get asked it.
    if (!this.deps.worktreeStatus) return null
    // A worktree that cannot be read is not evidence of a violation; the git stages fail on
    // their own, with a better message than this one could give.
    const changed = await this.deps.worktreeStatus(cwd).catch(() => [])
    if (changed.length === 0) return null

    const shown = changed.slice(0, 5).join(', ')
    return (
      `stage "${stage.id}" may not write files (tools: ${stage.tools.mode}) but changed ` +
      `${changed.length}: ${shown}${changed.length > 5 ? ', …' : ''}`
    )
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
      toolsMode: stage.tools.mode,
      ...(stage.model ? { model: stage.model } : {}),
      ...(ctx.resume ? { resume: ctx.resume } : {}),
      ...(this.deps.env ? { env: this.deps.env() } : {}),
    }

    const session = await driver.start(req)
    // Steers folded into the prompt above have been delivered; anything queued from
    // here belongs to whatever comes next.
    state.pendingSteers = []

    /**
     * The last thing the harness actually said, kept for the crash message.
     *
     * FOUND BY RUNNING IT. A run failed with `harness claude-code exited 1` and an empty
     * `stderrPreview`, while the real reason — "Failed to authenticate: OAuth session expired
     * and could not be refreshed" — had come through as an `assistant.message` two events
     * earlier. Diagnosing it needed the container's CloudWatch log, for a failure whose cause
     * was sitting in the event stream the whole time.
     *
     * The same shape as the fix in the opencode mapper: when a harness dies, what it said
     * before dying is usually the answer, and it belongs in the failure rather than only in a
     * log somebody has to go and find.
     */
    let lastSpoken: string | undefined
    for await (const event of session.events) {
      if (this.outsideWorktree(event)) continue
      if (event.type === 'assistant.message') {
        const text = event.data.text.trim()
        if (text) lastSpoken = text
      } else if (event.type === 'error') {
        // An error the harness reported itself outranks anything it merely said.
        lastSpoken = event.data.message
      }
      this.deps.bus.emit(event)
    }
    const exit = await session.done()

    // FOUND BY RUNNING IT. This return value used to be discarded, so a harness that died
    // mid-stage still "passed": the stage has no gate, nothing else inspected the exit, and
    // the run reported success while having produced nothing. A crash is a stage failure —
    // and it is deliberately not treated as a *gate* failure, because `maxAttempts` bounds
    // how often a gate may reject work, not how often the process may die.
    if (exit.exitCode !== 0 && exit.exitCode !== null) {
      throw new Error(
        `harness ${ctx.harness} exited ${exit.exitCode} during stage "${stage.id}"` +
          (lastSpoken
            ? `: ${truncateForFailure(lastSpoken)}`
            : ' — see the harness.crashed event for what it reported'),
      )
    }
    if (exit.signal) {
      throw new Error(
        `harness ${ctx.harness} was killed by ${exit.signal} during stage "${stage.id}"` +
          (lastSpoken ? `: ${truncateForFailure(lastSpoken)}` : ''),
      )
    }

    if (session.resumeToken) state.resumeTokens[stage.id] = session.resumeToken

    // A harness with no mid-run steering hands back whatever arrived too late.
    const undelivered = session.pendingSteers()
    if (undelivered.length > 0) state.pendingSteers.push(...undelivered)
  }

  /**
   * Drop a file change that is not part of the change under review.
   *
   * FOUND BY RUNNING IT. Claude Code's plan mode writes its plan to `~/.claude/plans/`, and the
   * mapper reported that as `file.changed` because a mapper only sees the path a tool touched — it
   * has no idea where the worktree is. The result read as a read-only stage editing files, and the
   * PR body would have listed a plan file in HOME among the repo's changes.
   *
   * Dropped rather than relabelled: the diff is the record of what changed, and a harness writing
   * its own bookkeeping is not a change to the project.
   */
  private outsideWorktree(event: EventBodyInput): boolean {
    if (event.type !== 'file.changed') return false
    const path = event.data.path
    if (!path.startsWith('/')) return false
    return !path.startsWith(this.deps.cwd.endsWith('/') ? this.deps.cwd : `${this.deps.cwd}/`)
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

/**
 * Trims a harness message down to something that fits in a failure reason.
 *
 * A failure reason is rendered on a board and stored on the run, so it has to stay a sentence
 * rather than becoming a transcript. First line only, because a model's final message is often
 * a paragraph whose first line carries the actual problem.
 */
function truncateForFailure(text: string): string {
  const firstLine = text.split('\n').find((line) => line.trim()) ?? text
  const trimmed = firstLine.trim()
  return trimmed.length > 200 ? `${trimmed.slice(0, 197)}…` : trimmed
}
