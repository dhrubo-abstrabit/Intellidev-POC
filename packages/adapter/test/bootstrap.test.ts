import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RunSpec, type EventBodyInput, type HarnessId, type StageId } from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { runAdapter } from '../src/bootstrap/run.js'
import { LocalCredentialProvider, LocalSpecProvider } from '../src/bootstrap/providers.js'
import { consoleSink, fileSink, multiSink } from '../src/bootstrap/sinks.js'
import { parseArgs, runAdapterCli } from '../src/cli/adapter.js'
import { AsyncQueue } from '../src/driver/queue.js'
import type { HarnessDriver, Session, StageRequest } from '../src/driver/types.js'
import { GitRunner } from '../src/git/exec.js'
import { ShellCommandRunner } from '../src/stages/shell.js'

/**
 * Drives the whole adapter end to end against a real git repo and a fake harness.
 *
 * The harness is faked because a real model is slow, costs money and is nondeterministic —
 * but *everything else* is real: real git, a real credential broker over a real unix
 * socket, real config projection, a real MCP gateway on a real loopback port. This is the
 * test that proves the parts fit together.
 */

const identity = { name: 'intellidev[bot]', email: 'bot@example.test' }

/** Writes a file into the worktree the way a coding agent would. */
class FakeHarness implements HarnessDriver {
  readonly requests: StageRequest[] = []
  readonly capabilities = {
    midRunSteering: false,
    streamingDeltas: false,
    nativeStructuredOutput: false,
    reportsWindowState: false,
    reportsCost: false,
    nativeSkills: true,
    perToolPermissions: true,
  }

  constructor(
    readonly id: HarnessId,
    private readonly onStage: (
      stage: StageId,
      cwd: string,
      emit: (event: EventBodyInput) => void,
    ) => Promise<void> = async () => {},
  ) {}

  async materialise(): Promise<void> {}

  async start(req: StageRequest): Promise<Session> {
    this.requests.push(req)
    const queue = new AsyncQueue<EventBodyInput>()
    await this.onStage(req.stage, req.cwd, (event) => queue.push(event))
    queue.push({ type: 'assistant.message', data: { text: `did ${req.stage}` } })
    queue.push({ type: 'turn.boundary', data: { turn: 0 } })
    queue.close()
    return {
      events: queue,
      send: async () => {},
      pendingSteers: () => [],
      interrupt: async () => {},
      usage: () => ({ tokensIn: 10, tokensOut: 5, tokensCacheRead: 0, tokensCacheWrite: 0 }),
      info: () => null,
      resumeToken: `session_${req.stage}`,
      done: async () => ({ exitCode: 0, signal: null }),
    }
  }
}

describe('runAdapter end to end', () => {
  let root: string
  let origin: string
  let bundle: string
  let git: GitRunner

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-e2e-'))
    origin = join(root, 'origin.git')
    bundle = join(root, 'bundle')
    git = new GitRunner({ home: root, identity, timeoutSec: 60 })

    // A real origin with one commit.
    await git.run(['init', '--bare', '--initial-branch=main', origin], root)
    const seed = join(root, 'seed')
    await git.run(['clone', origin, seed], root)
    await writeFile(join(seed, 'README.md'), '# seed\n')
    await git.run(['add', '.'], seed)
    await git.run(['commit', '-m', 'seed'], seed)
    await git.run(['push', 'origin', 'main'], seed)

    // A real bundle: prompts, context, one skill.
    await mkdir(join(bundle, 'prompts'), { recursive: true })
    await mkdir(join(bundle, 'context'), { recursive: true })
    await mkdir(join(bundle, 'skills', 'commit-style'), { recursive: true })
    for (const name of ['design', 'code', 'fix', 'review']) {
      await writeFile(join(bundle, 'prompts', `${name}.md`), `Prompt for ${name}.`)
    }
    await writeFile(join(bundle, 'context', 'repo.md'), '# example\n\nUse pnpm.')
    await writeFile(join(bundle, 'skills', 'commit-style', 'SKILL.md'), '# Commit style\n')
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  function spec(over: Record<string, unknown> = {}) {
    const stages = [
      {
        id: 'design',
        kind: 'agent',
        promptFile: 'prompts/design.md',
        tools: { mode: 'read_only' },
      },
      { id: 'branch', kind: 'builtin', action: 'git.create_branch' },
      { id: 'code', kind: 'agent', promptFile: 'prompts/code.md', tools: { mode: 'full' } },
      {
        id: 'test',
        kind: 'agent',
        promptFile: 'prompts/fix.md',
        tools: { mode: 'full' },
        gate: { kind: 'command', run: 'test -f hello.ts' },
        maxAttempts: 2,
        onFail: 'code',
      },
    ]
    const template = { name: 'e2e', stages }
    return RunSpec.parse({
      runId: 'run_e2e',
      taskId: 'task_e2e',
      projectId: 'proj_e2e',
      manifestVersion: 1,
      manifest: {
        version: 1,
        project: 'example',
        repos: [{ url: origin }],
        harnesses: { default: 'opencode', allowed: ['opencode'], seatPool: 'local' },
        contextFile: './context/repo.md',
        stageTemplate: template,
        git: { authorName: identity.name, authorEmail: identity.email, partialClone: false },
        env: { vars: { NODE_ENV: 'test' }, secrets: [], dotenvPath: null },
      },
      bundle: { url: 'file:///dev/null', digest: 'x' },
      task: {
        id: 'task_e2e',
        title: 'Add hello',
        description: 'Add a hello function.',
        acceptanceCriteria: ['it exists'],
      },
      harness: 'opencode',
      stageTemplate: template,
      toolset: { servers: [], skills: [] },
      git: {
        repoUrl: origin,
        baseBranch: 'main',
        branch: 'feat/e2e',
        mirrorPath: join(root, 'cache'),
        worktreePath: join(root, 'work', 'run_e2e'),
      },
      seat: { id: 'local', pool: 'local', provider: 'local' },
      limits: {
        wallClockSec: 600,
        idleKillSec: 120,
        perStageTimeoutSec: 60,
        tokensMax: 1000,
        usdEstMax: 1,
      },
      controlPlaneUrl: 'http://127.0.0.1:4000',
      streamUrl: 'ws://127.0.0.1:4000/x',
      brokerSocket: join(root, 'broker.sock'),
      ...over,
    })
  }

  const paths = () => ({
    brokerSocket: join(root, 'broker.sock'),
    statePath: join(root, 'state.json'),
    bundleRoot: bundle,
    home: join(root, 'home'),
  })

  it('wires everything up in a dry run without touching a model', async () => {
    const harness = new FakeHarness('opencode')
    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: harness },
      dryRun: true,
    })

    expect(result.outcome).toBe('succeeded')
    // No model ran, but the worktree, gateway and config all exist.
    expect(harness.requests).toHaveLength(0)
    expect(result.gatewayUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
    expect(result.events.map((e) => e.type)).toEqual([
      'run.provisioning',
      'cache.restored',
      'worktree.ready',
      'run.started',
      'run.finished',
    ])
  })

  it('materialises harness config that points at the live gateway', async () => {
    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: new FakeHarness('opencode') },
      dryRun: true,
    })
    const config = JSON.parse(
      await readFile(join(root, 'work', 'run_e2e', 'opencode.json'), 'utf8'),
    )
    // The URL in the config is the port the gateway actually bound.
    expect(config.mcp.intellidev.url).toBe(result.gatewayUrl)
    expect(config.mcp.intellidev.type).toBe('remote')
    expect(await readFile(join(root, 'work', 'run_e2e', 'AGENTS.md'), 'utf8')).toContain('Use pnpm')
  })

  it('checks out a real worktree from the real origin', async () => {
    await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: new FakeHarness('opencode') },
      dryRun: true,
    })
    expect(await readFile(join(root, 'work', 'run_e2e', 'README.md'), 'utf8')).toContain('# seed')
  })

  it('runs the stages, and the gate sees what the agent wrote', async () => {
    // The fake agent creates the file the command gate checks for, so a passing gate
    // proves the worktree the agent wrote to is the one the gate ran in.
    const harness = new FakeHarness('opencode', async (stage, cwd) => {
      if (stage === 'code')
        await writeFile(join(cwd, 'hello.ts'), 'export const hello = () => {}\n')
    })

    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: harness },
    })

    expect(result.records.map((r) => `${r.stage}:${r.status}`)).toEqual([
      'design:passed',
      'branch:passed',
      'code:passed',
      'test:passed',
    ])
    const gate = result.events.find((e) => e.type === 'gate.evaluated')
    expect(gate?.type === 'gate.evaluated' && gate.data.passed).toBe(true)
  })

  it('routes a failing gate back to code, then passes on the retry', async () => {
    let attempts = 0
    const harness = new FakeHarness('opencode', async (stage, cwd) => {
      if (stage !== 'code') return
      attempts++
      // Nothing written on the first attempt, so the gate fails and routes back.
      if (attempts === 2) await writeFile(join(cwd, 'hello.ts'), 'export const hello = () => {}\n')
    })

    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: harness },
    })

    expect(result.outcome).toBe('succeeded')
    expect(attempts).toBe(2)
    const blocked = result.events.find((e) => e.type === 'gate.blocked')
    expect(blocked?.type === 'gate.blocked' && blocked.data.nextStage).toBe('code')
  })

  it('gives each stage the gateway token and the project env', async () => {
    const harness = new FakeHarness('opencode')
    await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: harness },
    })
    const design = harness.requests.find((r) => r.stage === 'design')
    // Codex reads the gateway token from the environment, so every harness gets it there.
    expect(design?.env?.['INTELLIDEV_GATEWAY_TOKEN']).toBeTruthy()
    expect(design?.env?.['NODE_ENV']).toBe('test')
  })

  /**
   * REGRESSION. HOME was never passed to the harness, so it inherited the image's
   * `/home/adapter` while the projection wrote `<home>/.claude/settings.json` and
   * `<home>/.codex/config.toml` under a different directory entirely — written, then silently
   * ignored. It also decides where a seat credential has to land to be found.
   */
  it('points the harness at the HOME the projection wrote to', async () => {
    const harness = new FakeHarness('opencode')
    const runPaths = paths()
    await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: runPaths,
      drivers: { opencode: harness },
    })
    for (const request of harness.requests) {
      expect(request.env?.['HOME'], `stage ${request.stage}`).toBe(runPaths.home)
    }
  })

  it('puts the task in every stage prompt, so an agent is never working blind', async () => {
    const harness = new FakeHarness('opencode')
    await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: harness },
    })
    for (const request of harness.requests) {
      expect(request.prompt, request.stage).toContain('Add hello')
      expect(request.prompt, request.stage).toContain('it exists')
      expect(request.prompt, request.stage).toContain('stage_state')
    }
  })

  it('asks for no git credentials when the remote is a local path', async () => {
    // Worth stating rather than assuming: git only consults a credential helper for
    // authenticated remotes, so a file:// origin legitimately needs none. The credential
    // path itself is covered against a real socket in credentials.test.ts.
    //
    // A seat request IS expected: the harness needs its own login whatever the git remote is.
    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: new FakeHarness('opencode') },
    })
    expect(result.credentialKinds).not.toContain('git')
    expect(result.credentialKinds).toContain('seat')
  })

  it('leaves nothing listening after the run', async () => {
    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: new FakeHarness('opencode') },
      dryRun: true,
    })
    // A leaked gateway or broker would hold the container open past the run.
    const port = Number(/:(\d+)\//.exec(result.gatewayUrl)?.[1])
    await expect(fetch(`http://127.0.0.1:${port}/mcp`)).rejects.toThrow()
  })

  it('names the environment variable when a token is genuinely needed', async () => {
    // Asked directly, because a file:// origin never triggers it. The message has to name
    // the variable or the first local run against a real repo is a guessing game.
    const provider = new LocalCredentialProvider({})
    await expect(provider.gitCredential('github.com')).rejects.toThrow(/INTELLIDEV_GITHUB_TOKEN/)
  })

  it('discovers skills from the bundle and the worktree', async () => {
    // The control plane populates declared skills but has never seen the worktree, so
    // repo-native skills have to be found in here.
    await mkdir(join(root, 'work', 'run_e2e'), { recursive: true })
    const result = await runAdapter({
      spec: spec(),
      credentials: new LocalCredentialProvider({ githubToken: 'ghp_local' }),
      sink: () => {},
      paths: paths(),
      drivers: { opencode: new FakeHarness('opencode') },
      dryRun: true,
    })
    expect(result.outcome).toBe('succeeded')
    const config = JSON.parse(
      await readFile(join(root, 'work', 'run_e2e', 'opencode.json'), 'utf8'),
    )
    // The bundle ships one skill; discovery found it without the spec declaring it.
    expect(config.skills.paths[0]).toContain('skills')
  })
})

// --- supporting pieces -----------------------------------------------------

describe('ShellCommandRunner', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-shell-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('captures stdout and the exit code', async () => {
    const runner = new ShellCommandRunner()
    const result = await runner.run('echo hi && exit 3', { cwd: root, timeoutSec: 10 })
    expect(result.exitCode).toBe(3)
    expect(result.stdout.trim()).toBe('hi')
  })

  it('emits output as events, so it passes the bus redactor', async () => {
    const events: EventBodyInput[] = []
    const runner = new ShellCommandRunner({ emit: (event) => events.push(event) })
    await runner.run('echo secret-ish', { cwd: root, timeoutSec: 10 })
    // Printing straight to stdout would corrupt the MCP transport and skip redaction.
    expect(events.some((e) => e.type === 'command.output')).toBe(true)
  })

  it('passes project env through to the command', async () => {
    const runner = new ShellCommandRunner({ env: { MY_VAR: 'present' } })
    const result = await runner.run('echo $MY_VAR', { cwd: root, timeoutSec: 10 })
    expect(result.stdout.trim()).toBe('present')
  })

  it('kills a command that outlives its timeout', async () => {
    const runner = new ShellCommandRunner()
    const result = await runner.run('sleep 30', { cwd: root, timeoutSec: 1 })
    // A hung test process would otherwise hold the run open to its wall-clock limit.
    expect(result.exitCode).not.toBe(0)
  }, 15_000)

  it('reports a missing shell command rather than throwing', async () => {
    const runner = new ShellCommandRunner()
    const result = await runner.run('definitely-not-a-command', { cwd: root, timeoutSec: 10 })
    expect(result.exitCode).not.toBe(0)
  })
})

describe('LocalSpecProvider', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-spec-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('rejects a spec with a typo instead of failing six stages later', async () => {
    const path = join(root, 'spec.json')
    await writeFile(path, JSON.stringify({ runId: 'r', harness: 'not-a-harness' }))
    await expect(new LocalSpecProvider(path).load()).rejects.toThrow()
  })
})

describe('sinks', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-sink-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('appends one JSON line per event', async () => {
    const path = join(root, 'events.jsonl')
    const sink = fileSink(path)
    sink({
      seq: 0,
      runId: 'r',
      ts: '2026-08-13T00:00:00.000Z',
      stage: null,
      type: 'run.provisioning',
      data: {},
    })
    sink({
      seq: 1,
      runId: 'r',
      ts: '2026-08-13T00:00:01.000Z',
      stage: 'code',
      type: 'thinking.started',
      data: {},
    })
    await new Promise((resolve) => setTimeout(resolve, 50))
    const lines = (await readFile(path, 'utf8')).trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(JSON.parse(lines[1]!).seq).toBe(1)
  })

  it('fans out to several sinks', () => {
    const seen: number[] = []
    const sink = multiSink(
      (e) => seen.push(e.seq),
      (e) => seen.push(e.seq * 100),
    )
    sink({
      seq: 2,
      runId: 'r',
      ts: '2026-08-13T00:00:00.000Z',
      stage: null,
      type: 'thinking.started',
      data: {},
    })
    expect(seen).toEqual([2, 200])
  })

  it('does not write events to stdout, which belongs to the MCP transport', () => {
    // consoleSink writes to stderr on purpose; asserting the choice so it is not "fixed".
    expect(consoleSink.toString()).toContain('stderr')
  })
})

describe('adapter CLI', () => {
  it('parses flags', () => {
    const args = parseArgs(['run', '--spec', 's.json', '--bundle', 'b', '--dry-run', '-v'])
    expect(args).toMatchObject({
      command: 'run',
      spec: 's.json',
      bundle: 'b',
      dryRun: true,
      verbose: true,
    })
  })

  it('requires a spec', async () => {
    const err: string[] = []
    const code = await runAdapterCli(['run'], {
      stdout: () => {},
      stderr: (t) => err.push(t),
      env: {},
    })
    expect(code).toBe(2)
    expect(err.join('')).toContain('--spec')
  })

  it('prints usage for an unknown command', async () => {
    const out: string[] = []
    const code = await runAdapterCli(['nope'], {
      stdout: (t) => out.push(t),
      stderr: () => {},
      env: {},
    })
    expect(code).toBe(2)
    expect(out.join('')).toContain('intellidev-adapter run')
  })
})
