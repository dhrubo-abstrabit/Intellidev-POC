import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, relative, resolve as resolvePath } from 'node:path'
import {
  type AgentEvent,
  type HarnessId,
  type RunOutcome,
  type RunSpec,
  type StageId,
  type SkillRef,
  type StageRecord,
  type ToolPolicy,
} from '@intellidev/shared'
import { materialiseConfig } from '../config/materialise.js'
import type { ProjectionSpec } from '../config/spec.js'
import { CredentialBroker } from '../credentials/broker.js'
import { BrokerClient } from '../credentials/client.js'
import { materialiseSeat } from '../credentials/seat.js'
import { materialiseStageEnv, writeDotenv } from '../credentials/stage-env.js'
import type { CredentialProvider } from '../credentials/types.js'
import { ClaudeCodeDriver } from '../driver/claude-code/driver.js'
import { CodexDriver } from '../driver/codex/driver.js'
import { OpencodeDriver } from '../driver/opencode/driver.js'
import type { HarnessDriver } from '../driver/types.js'
import { EventBus } from '../events/bus.js'
import { buildBuiltinTools } from '../gateway/builtins.js'
import { Gateway } from '../gateway/gateway.js'
import { GatewayHttpServer } from '../gateway/http.js'
import { ToolRegistry } from '../gateway/registry.js'
import { UpstreamPool } from '../gateway/upstream.js'
import { GitBuiltins } from '../git/builtins.js'
import { GitRunner } from '../git/exec.js'
import { GitHubClient } from '../git/github.js'
import { RunRepo } from '../git/repo.js'
import { StageEngine } from '../stages/engine.js'
import { ShellCommandRunner } from '../stages/shell.js'
import { FileStateStore } from '../stages/state.js'
import type { RunStateStore } from '../stages/types.js'
import { discoverSkills } from './skills.js'
import type { EventSink } from './sinks.js'

/**
 * Boot a run and drive it to an outcome.
 *
 * The seam where everything meets: broker, repo, config projection, gateway, drivers,
 * stage engine, git. Every dependency is injected, so the whole path can be exercised
 * against a temp repo and a fake harness.
 *
 * The order is not arbitrary:
 *
 *  1. **broker** — the repo needs credentials before it can fetch
 *  2. **repo and worktree** — config projection writes *into* the worktree
 *  3. **skills and upstream tools** — the gateway needs them before any harness starts
 *  4. **gateway** — its URL goes into harness config, so it must be listening first
 *  5. **config projection** — everything it references now exists
 *  6. **stages** — the only step that runs a model
 */
export interface RunOptions {
  spec: RunSpec
  credentials: CredentialProvider
  sink: EventSink
  /**
   * Called once the bus exists, for a sink that needs to replay and acknowledge.
   *
   * The outbound WebSocket sink needs both: on reconnect it re-sends everything not yet
   * acknowledged, and it tells the bus what the control plane has stored so the buffer can
   * be dropped. It cannot simply be passed as `sink`, because those capabilities only exist
   * once the bus does — and handing the whole bus to a sink would let it number events,
   * which exactly one thing is allowed to do.
   */
  bindSink?: (source: EventReplaySource) => EventSink
  paths?: { brokerSocket?: string; statePath?: string; bundleRoot?: string; home?: string }
  /** Overridden in tests; real runs use the three CLIs. */
  drivers?: Partial<Record<HarnessId, HarnessDriver>>
  store?: RunStateStore
  /** Wire everything up and stop before running a model. */
  dryRun?: boolean
  now?: () => Date
}

/** The bus's replay surface, without the ability to emit. */
export interface EventReplaySource {
  replayFrom(seq: number): AgentEvent[]
  ack(seq: number): void
}

export interface RunResultSummary {
  outcome: RunOutcome
  records: StageRecord[]
  events: AgentEvent[]
  prUrl?: string
  /** Questions the agent asked with nobody to answer them. */
  questions: string[]
  /** Credential requests made, granted or refused. */
  credentialRequests: number
  /**
   * What was asked of the broker, by kind.
   *
   * The bare count stopped being expressive once every run started asking for a seat
   * credential: a test that wants "git needed nothing" has to be able to say so.
   */
  credentialKinds: readonly string[]
  gatewayUrl: string
}

export async function runAdapter(opts: RunOptions): Promise<RunResultSummary> {
  const { spec } = opts
  const bundleRoot = opts.paths?.bundleRoot ?? '/opt/project'
  const brokerSocket = opts.paths?.brokerSocket ?? spec.brokerSocket
  const home = opts.paths?.home ?? resolvePath(spec.git.worktreePath, '..', '.home')
  await mkdir(home, { recursive: true })

  const events: AgentEvent[] = []
  const questions: string[] = []
  const outputs = new Map<StageId, unknown>()
  let records: StageRecord[] = []
  /**
   * Filled after the worktree exists, because repo-native skills live inside it and the
   * control plane has never seen them.
   */
  let skills: SkillRef[] = [...spec.toolset.skills]
  /** Rebuilt per stage, so a stage only ever sees the secrets scoped to it. */
  let stageEnv: Record<string, string> = {}

  // Mutable because the gateway, the broker and the built-in tools all need to know which
  // stage is current, and they are wired before the first stage begins.
  let stage: StageId | null = null
  let attempt = 1

  // Assigned before any event can be emitted, so the late-bound sink is never called with
  // a bus that does not exist yet.
  let boundSink: EventSink | undefined
  const bus = new EventBus(
    spec.runId,
    (event) => {
      events.push(event)
      opts.sink(event)
      boundSink?.(event)
    },
    opts.now,
  )
  boundSink = opts.bindSink?.({
    replayFrom: (seq) => bus.replayFrom(seq),
    ack: (seq) => bus.ack(seq),
  })
  bus.emit({ type: 'run.provisioning', data: { message: `harness ${spec.harness}` } })

  // 1. Broker.
  const broker = new CredentialBroker({
    socketPath: brokerSocket,
    provider: opts.credentials,
    currentStage: () => stage,
  })
  await broker.start()
  const brokerClient = new BrokerClient(brokerSocket)

  const upstream = new UpstreamPool({
    token: async (serverId) => (await brokerClient.mcpToken(serverId)).token,
  })

  const commands = new ShellCommandRunner({ emit: (event) => bus.emit(event) })
  const registry = new ToolRegistry()

  const gateway = new Gateway({
    registry,
    builtins: buildBuiltinTools({
      task: spec.task,
      template: spec.stageTemplate,
      // Closures, so these follow the stage rather than freezing at wiring time.
      stage: () => stage ?? spec.stageTemplate.stages[0]!.id,
      attempt: () => attempt,
      commands,
      cwd: spec.git.worktreePath,
      // A closure: discovery happens after the worktree is checked out.
      get skills() {
        return skills
      },
      bundleRoot,
      onStageOutput: (s, output) => outputs.set(s, output),
      onQuestion: (question) => questions.push(question),
      perCheckTimeoutSec: spec.limits.perStageTimeoutSec,
    }),
    upstream,
    stage: () => stage ?? spec.stageTemplate.stages[0]!.id,
    policy: () => policyFor(spec, stage),
    emit: (event) => bus.emit(event),
  })
  const gatewayHttp = new GatewayHttpServer({ gateway })

  try {
    // 2. Repo and worktree.
    const git = new GitRunner({
      home,
      identity: { name: spec.manifest.git.authorName, email: spec.manifest.git.authorEmail },
      credentialHelper: '!intellidev-cred git',
      env: {
        INTELLIDEV_BROKER_SOCKET: brokerSocket,
        ...(await safeDirectoryConfig(home)),
      },
    })
    const repo = new RunRepo(git, {
      // Keyed by repo URL, not the fixed name `repo.git` it used to be. The cache is
      // per-project, so a single `repo.git` meant two tasks in one project with different
      // repositories reused one mirror — and the second failed with `fetch origin` pointing
      // at the first repository, an error that reads like a broken remote rather than a
      // cache collision.
      mirror: join(spec.git.mirrorPath, `${mirrorKey(spec.git.repoUrl)}.git`),
      worktree: spec.git.worktreePath,
    })

    const restoreStart = Date.now()
    const mirror = await repo.ensureMirror(spec.git.repoUrl, {
      partial: spec.manifest.git.partialClone,
    })
    bus.emit({
      type: 'cache.restored',
      data: { hit: mirror === 'fetched', bytes: 0, durationMs: Date.now() - restoreStart },
    })

    const baseSha = await repo.resolve(spec.git.baseBranch)
    await repo.createWorktree(spec.git.branch, baseSha)
    bus.emit({
      type: 'worktree.ready',
      data: { branch: spec.git.branch, baseSha, path: spec.git.worktreePath },
    })

    // 3. Upstream tools.
    for (const entry of spec.toolset.servers) {
      const connected = await upstream.connect(entry.server)
      if (!connected.ok) {
        // A `required` server should have blocked dispatch, so reaching here means it was
        // optional: degrade that server rather than lose the run.
        bus.emit({
          type: 'error',
          data: {
            code: 'upstream_unavailable',
            message: `${entry.server.id}: ${connected.error ?? 'unknown'}`,
            retryable: true,
          },
        })
        continue
      }
      const registered = registry.registerUpstream(
        entry.server.id,
        connected.tools,
        entry.attachment,
      )
      bus.emit({
        type: 'tool.server_connected',
        data: {
          serverId: entry.server.id,
          name: entry.server.name,
          tools: registered.map((tool) => tool.name),
          authenticated: entry.server.auth !== 'none',
        },
      })
    }

    // 3b. Seat credential: the harness's own subscription login.
    //
    // Fetched from the broker rather than read out of the spec, so the material is pulled at
    // run time and a rotated credential is picked up without rewriting a spec. Failing soft is
    // deliberate: plenty of local runs have no seat at all, and a harness that turns out to be
    // unauthenticated says so far more clearly than a bootstrap error would.
    let seatEnv: Record<string, string> = {}
    try {
      const written: string[] = []
      const seat = await brokerClient.seatCredential(spec.harness)
      seatEnv = await materialiseSeat({
        credential: seat,
        home,
        onFile: (path) => written.push(path),
      })
      if (written.length > 0 || Object.keys(seatEnv).length > 0) {
        bus.emit({
          type: 'seat.authenticated',
          data: { harness: spec.harness, envVars: Object.keys(seatEnv), files: written },
        })
      }
    } catch (error) {
      // Not fatal: a local run often has no seat, and the harness saying "Not logged in" is a
      // clearer signal than a bootstrap failure. Dispatch is where a missing account is caught.
      bus.emit({
        type: 'error',
        data: {
          code: 'seat_unavailable',
          message: `no seat credential for ${spec.harness}: ${
            error instanceof Error ? error.message : String(error)
          }`,
          retryable: false,
        },
      })
    }

    // 4. Gateway, before any config references its URL.
    const gatewayUrl = await gatewayHttp.start()

    // 5. Config projection, after discovering skills the spec could not know about.
    skills = await discoverSkills({
      bundleRoot,
      worktree: spec.git.worktreePath,
      declared: spec.toolset.skills,
    })
    const projection = await materialiseConfig({
      harness: spec.harness,
      cwd: spec.git.worktreePath,
      home,
      gateway: {
        url: gatewayUrl,
        token: gatewayHttp.token,
        tokenEnvVar: GATEWAY_TOKEN_ENV,
      },
      skillsDir: skills.length > 0 ? join(bundleRoot, 'skills') : null,
      skills,
      context: await readContext(bundleRoot, spec),
      // Baseline only. Per-stage scoping is the gateway's, because this file is written
      // once and the stage moves.
      policy: { mode: 'full', allow: [], deny: spec.manifest.policy.tools.deny },
      ...modelFor(spec),
    } satisfies ProjectionSpec)

    // Config the adapter wrote is not the agent's work, so keep it out of the commit. Only
    // paths inside the worktree matter — anything under HOME git never sees.
    await repo.excludeLocally(
      [...projection.written, ...projection.unchanged, ...projection.links.map((link) => link.link)]
        .filter((path) => path.startsWith(`${spec.git.worktreePath}/`))
        .map((path) => `/${relative(spec.git.worktreePath, path)}`),
    )

    bus.emit({
      type: 'run.started',
      data: { harness: spec.harness, manifestVersion: spec.manifestVersion },
    })

    if (opts.dryRun) {
      bus.emit({ type: 'run.finished', data: { outcome: 'succeeded', reason: 'dry run' } })
      return {
        outcome: 'succeeded',
        records,
        events,
        questions,
        credentialRequests: broker.log.length,
        credentialKinds: broker.log.map((entry) => entry.kind),
        gatewayUrl,
      }
    }

    // 6. Stages.
    const github = new GitHubClient({ token: () => gitToken(brokerClient) })
    const builtins = new GitBuiltins({
      repo,
      github,
      bus,
      git: spec.manifest.git,
      task: spec.task,
      harness: spec.harness,
      repoUrl: spec.git.repoUrl,
      baseBranch: spec.git.baseBranch,
      branch: spec.git.branch,
      baseSha,
      snapshot: () => ({ events, records }),
    })

    const engine = new StageEngine({
      runId: spec.runId,
      cwd: spec.git.worktreePath,
      template: spec.stageTemplate,
      defaultHarness: spec.harness,
      drivers: opts.drivers ?? defaultDrivers(),
      commands,
      /**
       * So the engine can check that a read-only stage stayed read-only.
       *
       * The repository already answers this for the commit stage; the same answer is what tells
       * the engine whether a stage broke its own contract. It matters more now that codex is run
       * without its sandbox inside the container, since nothing else was enforcing it.
       */
      worktreeStatus: () => repo.status(),
      builtins,
      outputs: { take: (s) => outputs.get(s) },
      store: opts.store ?? new FileStateStore(statePath(opts, spec)),
      bus,
      prompts: await loadPrompts(bundleRoot, spec),
      perStageTimeoutSec: spec.limits.perStageTimeoutSec,
      onStageEnter: async (next, nextAttempt) => {
        stage = next
        attempt = nextAttempt
        stageEnv = await prepareStageEnv(spec, next, brokerClient, bus)
      },
      // Seat env first, so a project's own vars win a collision: the seat is infrastructure
      // and the project's configuration is intent. HOME and the gateway token come last
      // because neither is negotiable.
      //
      // FOUND BY RUNNING IT. HOME was never set, so the harness inherited the image's
      // `/home/adapter` while the projection wrote `<home>/.claude/settings.json` and
      // `<home>/.codex/config.toml` somewhere else entirely — those files have been written and
      // silently ignored. `HOME` is already in RESERVED_ENV, so the platform was always meant
      // to own it. It also decides where a seat credential file has to go for the harness to
      // find it.
      env: () => ({
        ...seatEnv,
        ...stageEnv,
        HOME: home,
        [GATEWAY_TOKEN_ENV]: gatewayHttp.token,
      }),
      ...(opts.now ? { now: opts.now } : {}),
    })

    const result = await engine.run()
    records = result.state.records
    const pr = events.find((e) => e.type === 'pr.opened')

    return {
      outcome: result.outcome,
      records,
      events,
      questions,
      credentialRequests: broker.log.length,
      credentialKinds: broker.log.map((entry) => entry.kind),
      gatewayUrl,
      ...(pr?.type === 'pr.opened' ? { prUrl: pr.data.url } : {}),
    }
  } finally {
    // Ordered so nothing is left listening if an earlier close throws.
    await gatewayHttp.stop().catch(() => undefined)
    await upstream.close().catch(() => undefined)
    await broker.stop().catch(() => undefined)
  }
}

export const GATEWAY_TOKEN_ENV = 'INTELLIDEV_GATEWAY_TOKEN'

function policyFor(spec: RunSpec, stage: StageId | null): ToolPolicy {
  const found = spec.stageTemplate.stages.find((s) => s.id === stage)
  // Unknown stage means nothing has started; deny by default rather than guessing.
  return found?.tools ?? { mode: 'none', allow: [], deny: [] }
}

function modelFor(spec: RunSpec): { model?: string } {
  const configured = spec.manifest.harnesses.models[spec.harness]?.model
  return configured ? { model: configured } : {}
}

/** Drivers for a real run. The gateway token reaches them via the engine's stage env. */
function defaultDrivers(): Partial<Record<HarnessId, HarnessDriver>> {
  /**
   * Set by the runner image, and only by it.
   *
   * Codex refuses to run shell commands when its own sandbox cannot start, which is the case on
   * Fargate — so inside the run container it is told the container is the sandbox. Not inferred
   * from "am I on Linux" or "is there a /.dockerenv": inline mode runs this same code on a
   * developer's own machine, where the sandbox both works and is the only thing standing between
   * a model and their home directory.
   */
  const externallySandboxed = process.env['INTELLIDEV_CONTAINER'] === '1'
  return {
    'claude-code': new ClaudeCodeDriver(),
    codex: new CodexDriver({ externallySandboxed }),
    opencode: new OpencodeDriver(),
  }
}

function statePath(opts: RunOptions, spec: RunSpec): string {
  return (
    opts.paths?.statePath ?? resolvePath(spec.git.worktreePath, '..', `${spec.runId}.state.json`)
  )
}

/** Pull the password out of the git credential protocol reply. */
async function gitToken(client: BrokerClient): Promise<string> {
  const reply = await client.gitCredential('protocol=https\nhost=github.com\n\n')
  return /^password=(.*)$/m.exec(reply)?.[1]?.trim() ?? ''
}

/**
 * Resolve secrets for a stage and render the dotenv most repos expect.
 *
 * Failures here are reported, not fatal: a missing optional secret should make a test fail
 * with a readable error rather than stop the run before it starts.
 */
async function prepareStageEnv(
  spec: RunSpec,
  stage: StageId,
  client: BrokerClient,
  bus: EventBus,
): Promise<Record<string, string>> {
  try {
    const resolved = await materialiseStageEnv({ envSpec: spec.manifest.env, stage, client })
    if (resolved.unresolved.length > 0) {
      bus.emit({
        type: 'error',
        data: {
          code: 'secrets_unresolved',
          message: `unresolved: ${resolved.unresolved.join(', ')}`,
          retryable: false,
        },
      })
    }
    if (spec.manifest.env.dotenvPath && Object.keys(resolved.env).length > 0) {
      await writeDotenv({
        worktree: spec.git.worktreePath,
        dotenvPath: spec.manifest.env.dotenvPath,
        env: resolved.env,
      })
    }
    return resolved.env
  } catch (error) {
    bus.emit({
      type: 'error',
      data: {
        code: 'stage_env_failed',
        message: error instanceof Error ? error.message : String(error),
        retryable: false,
      },
    })
    return {}
  }
}

/**
 * Opt-in `safe.directory` for a bind-mounted origin.
 *
 * Needed because a bind-mounted repo is owned by the host uid, not the container's, and git
 * refuses it as "dubious ownership". It has to go through a config *file* rather than `-c`:
 * git only honours `safe.directory` from protected configuration, and a `file://` clone does
 * its work in a child `upload-pack` where `-c` values arrive unprotected and are ignored.
 * `GIT_CONFIG_GLOBAL` points at a file we own, under the run's pinned HOME, so a developer's
 * real `~/.gitconfig` is still not in play.
 *
 * Off unless explicitly asked for: against a real remote this check is worth keeping.
 */
async function safeDirectoryConfig(home: string): Promise<Record<string, string>> {
  const value = process.env['INTELLIDEV_GIT_SAFE_DIRECTORY']
  if (!value) return {}

  const path = join(home, '.gitconfig-intellidev')
  await writeFile(path, `[safe]\n\tdirectory = ${value}\n`)
  return { GIT_CONFIG_GLOBAL: path }
}

/**
 * A stable, filesystem-safe directory name for a repository.
 *
 * A hash rather than a slug of the URL: two URLs can differ only in credentials or a
 * trailing `.git`, and a slug would either collide or grow unbounded. The short prefix is
 * long enough that a collision is not a practical concern for one project's repositories,
 * and the readable suffix keeps a cache directory diagnosable by eye.
 */
export function mirrorKey(repoUrl: string): string {
  const digest = createHash('sha256').update(repoUrl).digest('hex').slice(0, 12)
  const readable =
    repoUrl
      .replace(/\.git$/, '')
      .split(/[/:]/)
      .filter(Boolean)
      .pop()
      ?.replace(/[^a-zA-Z0-9._-]/g, '-')
      .slice(0, 32) ?? 'repo'
  return `${readable}-${digest}`
}

async function readContext(bundleRoot: string, spec: RunSpec): Promise<string> {
  const path = join(bundleRoot, spec.manifest.contextFile.replace(/^\.\//, ''))
  return readFile(path, 'utf8').catch(
    () => `# ${spec.manifest.project}\n\nNo context document was provided for this project.`,
  )
}

/**
 * Stage prompts, from the bundle with the task appended.
 *
 * The task is appended rather than left to a tool call: an agent that never calls
 * `task_context` would otherwise be working blind, and the cost of including it is a few
 * hundred tokens.
 */
async function loadPrompts(
  bundleRoot: string,
  spec: RunSpec,
): Promise<Partial<Record<StageId, string>>> {
  const prompts: Partial<Record<StageId, string>> = {}
  for (const stageDef of spec.stageTemplate.stages) {
    if (stageDef.kind !== 'agent' || !stageDef.promptFile) continue
    const body = await readFile(
      join(bundleRoot, stageDef.promptFile.replace(/^\.\//, '')),
      'utf8',
    ).catch(() => `You are working on the "${stageDef.id}" stage of this task.`)

    prompts[stageDef.id] = [
      body.trim(),
      '',
      '---',
      '',
      `## Task: ${spec.task.title}`,
      '',
      spec.task.description.trim(),
      ...(spec.task.details ? ['', spec.task.details.trim()] : []),
      ...(spec.task.acceptanceCriteria.length > 0
        ? ['', '**Acceptance criteria**', ...spec.task.acceptanceCriteria.map((c) => `- ${c}`)]
        : []),
      '',
      'Call `stage_state` to see exactly what this stage’s gate will check.',
    ].join('\n')
  }
  return prompts
}
