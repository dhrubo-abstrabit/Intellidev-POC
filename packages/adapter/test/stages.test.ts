import {
  AgentEvent,
  DEFAULT_STAGE_TEMPLATE,
  StageTemplate,
  type EventBodyInput,
  type HarnessId,
  type StageId,
} from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events/bus.js'
import type { HarnessDriver, Session, StageRequest } from '../src/driver/types.js'
import { AsyncQueue } from '../src/driver/queue.js'
import { StageEngine } from '../src/stages/engine.js'
import { MemoryStateStore } from '../src/stages/state.js'
import type { BuiltinActions, CommandRunner, StageOutputSink } from '../src/stages/types.js'

// --- fakes -----------------------------------------------------------------

/** Records the prompts it was given, so steer carry-over can be asserted. */
class FakeDriver implements HarnessDriver {
  readonly requests: StageRequest[] = []
  constructor(
    readonly id: HarnessId,
    readonly capabilities = {
      midRunSteering: true,
      streamingDeltas: true,
      nativeStructuredOutput: false,
      reportsWindowState: true,
      reportsCost: true,
    },
    private readonly emit: EventBodyInput[] = [
      { type: 'assistant.message', data: { text: 'done' } },
    ],
    private readonly leftoverSteers: string[] = [],
  ) {}

  async materialise(): Promise<void> {}

  async start(req: StageRequest): Promise<Session> {
    this.requests.push(req)
    const queue = new AsyncQueue<EventBodyInput>()
    for (const event of this.emit) queue.push(event)
    queue.close()
    const leftover = this.leftoverSteers
    return {
      events: queue,
      send: async () => {},
      pendingSteers: () => [...leftover],
      interrupt: async () => {},
      usage: () => ({ tokensIn: 0, tokensOut: 0, tokensCacheRead: 0, tokensCacheWrite: 0 }),
      info: () => null,
      resumeToken: `session_${req.stage}`,
      done: async () => ({ exitCode: 0, signal: null }),
    }
  }
}

class ScriptedCommands implements CommandRunner {
  readonly ran: string[] = []
  constructor(private readonly exitCodes: number[]) {}
  async run(command: string) {
    this.ran.push(command)
    const exitCode = this.exitCodes.shift() ?? 0
    return { exitCode, stdout: exitCode === 0 ? 'ok' : '', stderr: exitCode === 0 ? '' : 'boom' }
  }
}

const noBuiltins: BuiltinActions = {
  createBranch: async () => ({ branch: 'feat/x', from: 'main' }),
  openPullRequest: async () => ({ number: 1, url: 'https://example.test/pr/1' }),
}

function outputs(map: Partial<Record<StageId, unknown>> = {}): StageOutputSink {
  const remaining = new Map(Object.entries(map) as Array<[StageId, unknown]>)
  return {
    take: (stage) => {
      const value = remaining.get(stage)
      remaining.delete(stage)
      return value
    },
  }
}

function harness(opts: {
  template: Parameters<typeof StageTemplate.parse>[0]
  commands?: CommandRunner
  drivers?: Partial<Record<HarnessId, HarnessDriver>>
  outputs?: StageOutputSink
  store?: MemoryStateStore
  prompts?: Partial<Record<StageId, string>>
  maxTotalStageRuns?: number
}) {
  const template = StageTemplate.parse(opts.template)
  const events: EventBodyInput[] = []
  const store = opts.store ?? new MemoryStateStore()
  let tick = 0
  const now = () => new Date(1_760_000_000_000 + tick++ * 1000)
  const bus = new EventBus(
    'run_1',
    (event) => {
      AgentEvent.parse(event)
      events.push({ type: event.type, data: event.data } as EventBodyInput)
    },
    now,
  )
  const prompts =
    opts.prompts ?? Object.fromEntries(template.stages.map((s) => [s.id, `prompt for ${s.id}`]))
  const engine = new StageEngine({
    runId: 'run_1',
    cwd: '/work/run_1',
    template,
    defaultHarness: 'claude-code',
    drivers: opts.drivers ?? { 'claude-code': new FakeDriver('claude-code') },
    commands: opts.commands ?? new ScriptedCommands([]),
    builtins: noBuiltins,
    outputs: opts.outputs ?? outputs(),
    store,
    bus,
    prompts,
    now,
    ...(opts.maxTotalStageRuns ? { maxTotalStageRuns: opts.maxTotalStageRuns } : {}),
  })
  return { engine, events, store, template }
}

// --- tests -----------------------------------------------------------------

describe('happy path', () => {
  it('walks every stage and finishes succeeded', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [
          { id: 'branch', kind: 'builtin', action: 'git.create_branch' },
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          { id: 'pr', kind: 'builtin', action: 'github.open_pr' },
        ],
      },
    })
    const { outcome, state } = await engine.run()
    expect(outcome).toBe('succeeded')
    expect(state.records.map((r) => `${r.stage}:${r.status}`)).toEqual([
      'branch:passed',
      'code:passed',
      'pr:passed',
    ])
    expect(events.filter((e) => e.type === 'stage.entered')).toHaveLength(3)
    expect(events.at(-1)?.type).toBe('run.finished')
    expect(events.some((e) => e.type === 'git.branch_created')).toBe(true)
    expect(events.some((e) => e.type === 'pr.opened')).toBe(true)
  })

  it('skips a disabled stage without running it', async () => {
    const driver = new FakeDriver('claude-code')
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [
          { id: 'design', kind: 'agent', promptFile: 'p.md', enabled: false },
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
        ],
      },
      drivers: { 'claude-code': driver },
    })
    await engine.run()
    expect(driver.requests.map((r) => r.stage)).toEqual(['code'])
    expect(events.filter((e) => e.type === 'stage.entered')).toHaveLength(1)
  })
})

describe('command gates and bounded retries', () => {
  /**
   * T4 acceptance. `maxAttempts` bounds gate FAILURES, so with 3 the test stage runs
   * three times, routing back to `code` after the first two, then fails the run.
   */
  it('loops back to code until attempts are exhausted, then fails', async () => {
    const commands = new ScriptedCommands([1, 1, 1])
    const driver = new FakeDriver('claude-code')
    const { engine, events, state } = await (async () => {
      const h = harness({
        template: {
          name: 't',
          stages: [
            { id: 'code', kind: 'agent', promptFile: 'p.md' },
            {
              id: 'test',
              kind: 'agent',
              promptFile: 'p.md',
              gate: { kind: 'command', run: 'pnpm test' },
              maxAttempts: 3,
              onFail: 'code',
            },
          ],
        },
        commands,
        drivers: { 'claude-code': driver },
      })
      const result = await h.engine.run()
      return { engine: h.engine, events: h.events, state: result.state, outcome: result.outcome }
    })()

    expect(state.status).toBe('failed')
    expect(commands.ran).toHaveLength(3)
    expect(state.gateFailures.test).toBe(3)
    // code entered 3 times: once initially, then once per route-back.
    expect(state.visits.code).toBe(3)
    expect(state.visits.test).toBe(3)

    const blocked = events.filter((e) => e.type === 'gate.blocked')
    expect(blocked).toHaveLength(3)
    // The first two route back; the last has nowhere to go.
    expect(
      blocked.slice(0, 2).every((e) => e.type === 'gate.blocked' && e.data.nextStage === 'code'),
    ).toBe(true)
    expect(
      blocked.at(-1)?.type === 'gate.blocked' && blocked.at(-1)?.data.nextStage,
    ).toBeUndefined()

    const finished = events.at(-1)
    expect(finished?.type).toBe('run.finished')
    if (finished?.type === 'run.finished') expect(finished.data.outcome).toBe('failed')
    void engine
  })

  it('recovers when a later attempt passes', async () => {
    const commands = new ScriptedCommands([1, 0])
    const { engine, state } = await (async () => {
      const h = harness({
        template: {
          name: 't',
          stages: [
            { id: 'code', kind: 'agent', promptFile: 'p.md' },
            {
              id: 'test',
              kind: 'agent',
              promptFile: 'p.md',
              gate: { kind: 'command', run: 'pnpm test' },
              maxAttempts: 3,
              onFail: 'code',
            },
          ],
        },
        commands,
      })
      const r = await h.engine.run()
      return { engine: h.engine, state: r.state, outcome: r.outcome }
    })()
    expect(state.status).toBe('succeeded')
    expect(state.gateFailures.test).toBe(1)
    void engine
  })

  it('reports the failing command output, since the next attempt works from it', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'pnpm test' },
          },
        ],
      },
      commands: new ScriptedCommands([2]),
    })
    await engine.run()
    const gate = events.find((e) => e.type === 'gate.evaluated')
    if (gate?.type === 'gate.evaluated') {
      expect(gate.data.passed).toBe(false)
      expect(gate.data.exitCode).toBe(2)
      expect(gate.data.detail).toContain('boom')
    }
  })

  it('does not limit re-entry of a stage that has no gate', async () => {
    // `code` has maxAttempts 1 by default; looping back to it must still work, or
    // every retry loop would die on the first bounce.
    const commands = new ScriptedCommands([1, 1, 0])
    const { engine, state } = await (async () => {
      const h = harness({
        template: {
          name: 't',
          stages: [
            { id: 'code', kind: 'agent', promptFile: 'p.md', maxAttempts: 1 },
            {
              id: 'test',
              kind: 'agent',
              promptFile: 'p.md',
              gate: { kind: 'command', run: 'pnpm test' },
              maxAttempts: 5,
              onFail: 'code',
            },
          ],
        },
        commands,
      })
      const r = await h.engine.run()
      return { engine: h.engine, state: r.state }
    })()
    expect(state.status).toBe('succeeded')
    expect(state.visits.code).toBe(3)
    void engine
  })

  it('stops a pathological template with the global run cap', async () => {
    const commands = new ScriptedCommands(Array(100).fill(1))
    const { engine } = harness({
      template: {
        name: 't',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'x' },
            maxAttempts: 999,
            onFail: 'code',
          },
        ],
      },
      commands,
      maxTotalStageRuns: 6,
    })
    const { outcome, state } = await engine.run()
    expect(outcome).toBe('failed')
    expect(state.failureReason).toContain('exceeded 6 stage runs')
  })
})

describe('predicate gates', () => {
  const reviewStage = {
    id: 'review' as const,
    kind: 'agent' as const,
    promptFile: 'p.md',
    gate: {
      kind: 'predicate' as const,
      expr: 'blocking == 0',
      outputSchema: {
        type: 'object',
        required: ['blocking'],
        properties: { blocking: { type: 'integer', minimum: 0 } },
      },
    },
    maxAttempts: 2,
    onFail: 'code' as const,
  }

  it('passes when the expression holds', async () => {
    const { engine } = harness({
      template: {
        name: 't',
        stages: [{ id: 'code', kind: 'agent', promptFile: 'p.md' }, reviewStage],
      },
      outputs: outputs({ review: { blocking: 0 } }),
    })
    expect((await engine.run()).outcome).toBe('succeeded')
  })

  it('routes back when it does not', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [{ id: 'code', kind: 'agent', promptFile: 'p.md' }, reviewStage],
      },
      outputs: outputs({ review: { blocking: 2 } }),
    })
    await engine.run()
    const blocked = events.find((e) => e.type === 'gate.blocked')
    expect(blocked?.type === 'gate.blocked' && blocked.data.nextStage).toBe('code')
  })

  it('fails for a reportable reason when output is missing entirely', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [{ id: 'code' as const, kind: 'agent' as const, promptFile: 'p.md' }, reviewStage],
      },
      outputs: outputs({}),
    })
    await engine.run()
    const gate = events.find((e) => e.type === 'gate.evaluated')
    expect(gate?.type === 'gate.evaluated' && gate.data.detail).toContain('no structured output')
  })

  it('rejects output that violates the schema before evaluating the expression', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [{ id: 'code' as const, kind: 'agent' as const, promptFile: 'p.md' }, reviewStage],
      },
      outputs: outputs({ review: { blocking: 'lots' } }),
    })
    await engine.run()
    const gate = events.find((e) => e.type === 'gate.evaluated')
    expect(gate?.type === 'gate.evaluated' && gate.data.detail).toContain('failed schema')
  })

  it('calls a broken expression a config bug, not a failing stage', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          { ...reviewStage, gate: { ...reviewStage.gate, expr: 'blocking > "x"' } },
        ],
      },
      outputs: outputs({ review: { blocking: 1 } }),
    })
    await engine.run()
    const error = events.find((e) => e.type === 'error')
    expect(error?.type === 'error' && error.data.code).toBe('bad_gate_expression')
  })
})

describe('human gates', () => {
  it('parks the run instead of deciding', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [
          {
            id: 'approval',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'human', action: 'open_pr' },
          },
          { id: 'pr', kind: 'builtin', action: 'github.open_pr' },
        ],
      },
    })
    const { outcome, state } = await engine.run()
    expect(outcome).toBe('parked')
    expect(state.status).toBe('parked')
    expect(events.some((e) => e.type === 'approval.requested')).toBe(true)
    // The PR stage must NOT have run.
    expect(events.some((e) => e.type === 'pr.opened')).toBe(false)
  })
})

describe('resume', () => {
  /**
   * T4 acceptance: a killed process resumes at its stage, not at the top.
   *
   * Simulated by persisting the state a kill would have left behind — cursor on
   * `code`, status still `running` — rather than by relying on a gate failure,
   * so the test asserts resume and nothing else.
   */
  it('resumes at the interrupted stage rather than restarting', async () => {
    const template = {
      name: 't',
      stages: [
        { id: 'design' as const, kind: 'agent' as const, promptFile: 'p.md' },
        { id: 'code' as const, kind: 'agent' as const, promptFile: 'p.md' },
        {
          id: 'test' as const,
          kind: 'agent' as const,
          promptFile: 'p.md',
          gate: { kind: 'command' as const, run: 'pnpm test' },
          maxAttempts: 2,
          onFail: 'code' as const,
        },
      ],
    }

    const store = new MemoryStateStore()
    await store.save({
      runId: 'run_1',
      templateName: 't',
      cursor: 1,
      gateFailures: {},
      visits: { design: 1 },
      records: [],
      status: 'running',
      resumeTokens: { code: 'session_code_prior' },
      pendingSteers: [],
      totalStageRuns: 1,
    })

    const driver = new FakeDriver('claude-code')
    const resumed = harness({
      template,
      commands: new ScriptedCommands([0]),
      drivers: { 'claude-code': driver },
      store,
    })
    const result = await resumed.engine.run()

    expect(result.outcome).toBe('succeeded')
    // design must not run again, and code picks its prior thread back up.
    expect(driver.requests.map((r) => r.stage)).toEqual(['code', 'test'])
    expect(driver.requests[0]?.resume).toBe('session_code_prior')
  })

  it('does not re-run a template that already settled', async () => {
    const store = new MemoryStateStore()
    const h = harness({
      template: { name: 't', stages: [{ id: 'code', kind: 'agent', promptFile: 'p.md' }] },
      store,
    })
    await h.engine.run()
    const driver = new FakeDriver('claude-code')
    const again = harness({
      template: h.template,
      drivers: { 'claude-code': driver },
      store,
    })
    const result = await again.engine.run()
    expect(result.outcome).toBe('succeeded')
    expect(driver.requests).toHaveLength(0)
  })

  it('passes the previous session token back so a stage continues its thread', async () => {
    const store = new MemoryStateStore()
    const commands = new ScriptedCommands([1, 0])
    const driver = new FakeDriver('claude-code')
    const h = harness({
      template: {
        name: 't',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'x' },
            maxAttempts: 2,
            onFail: 'code',
          },
        ],
      },
      commands,
      drivers: { 'claude-code': driver },
      store,
    })
    await h.engine.run()
    // Second visit to code should carry the resume token from the first.
    const codeRequests = driver.requests.filter((r) => r.stage === 'code')
    expect(codeRequests).toHaveLength(2)
    expect(codeRequests[1]?.resume).toBe('session_code')
  })

  it('persists before starting the next stage, so nothing is lost mid-flight', async () => {
    const store = new MemoryStateStore()
    const h = harness({
      template: {
        name: 't',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          { id: 'pr', kind: 'builtin', action: 'github.open_pr' },
        ],
      },
      store,
    })
    await h.engine.run()
    const cursors = store.history.map((s) => s.cursor)
    expect(cursors).toEqual([1, 2, 2])
  })
})

describe('steer carry-over for harnesses without mid-run steering', () => {
  it('folds undelivered steers into the next attempt prompt', async () => {
    const codex = new FakeDriver(
      'codex',
      {
        midRunSteering: false,
        streamingDeltas: false,
        nativeStructuredOutput: true,
        reportsWindowState: false,
        reportsCost: false,
      },
      [{ type: 'assistant.message', data: { text: 'done' } }],
      ['also check the auth module'],
    )
    const h = harness({
      template: {
        name: 't',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'x' },
            maxAttempts: 2,
            onFail: 'code',
          },
        ],
      },
      commands: new ScriptedCommands([1, 0]),
      drivers: { codex, 'claude-code': codex },
    })
    await h.engine.run()
    const second = h.engine ? codex.requests.filter((r) => r.stage === 'code')[1] : undefined
    expect(second?.prompt).toContain('also check the auth module')
    expect(second?.prompt).toContain('Additional instructions received')
  })
})

describe('failure handling', () => {
  it('fails the run when no driver is registered for a stage harness', async () => {
    const { engine, events } = harness({
      template: {
        name: 't',
        stages: [{ id: 'review', kind: 'agent', promptFile: 'p.md', harness: 'codex' }],
      },
      drivers: { 'claude-code': new FakeDriver('claude-code') },
    })
    const { outcome } = await engine.run()
    expect(outcome).toBe('failed')
    const error = events.find((e) => e.type === 'error')
    expect(error?.type === 'error' && error.data.message).toContain('no driver registered')
  })

  it('fails the run when a stage has no rendered prompt', async () => {
    const { engine, events } = harness({
      template: { name: 't', stages: [{ id: 'code', kind: 'agent', promptFile: 'p.md' }] },
      prompts: {},
    })
    expect((await engine.run()).outcome).toBe('failed')
    const error = events.find((e) => e.type === 'error')
    expect(error?.type === 'error' && error.data.message).toContain('no prompt rendered')
  })
})

describe('the shipped default template', () => {
  it('runs end to end when every gate passes', async () => {
    const codex = new FakeDriver('codex')
    const claude = new FakeDriver('claude-code')
    const h = harness({
      template: DEFAULT_STAGE_TEMPLATE,
      commands: new ScriptedCommands([0, 0]),
      drivers: { 'claude-code': claude, codex },
      outputs: outputs({ review: { blocking: 0, findings: [] } }),
    })
    const { outcome, state } = await h.engine.run()
    expect(outcome).toBe('succeeded')
    expect(state.records.map((r) => r.stage)).toEqual([
      'design',
      'branch',
      'code',
      'verify',
      'test',
      'review',
      'pr',
    ])
    // Review really did run on the other harness.
    expect(codex.requests.map((r) => r.stage)).toEqual(['review'])
  })
})
