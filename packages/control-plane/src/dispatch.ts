import { mkdir, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import {
  DEFAULT_STAGE_TEMPLATE,
  RunSpec,
  StageTemplate,
  renderBranchName,
  slugify,
  type AgentEvent,
  type StageRecord,
  type TaskStatus,
} from '@intellidev/shared'
import { DockerRunner, LocalCredentialProvider, runAdapter } from '@intellidev/adapter'
import type { McpOAuth } from './mcp/oauth.js'
import type { McpRegistry } from './mcp/registry.js'
import type { Store, TaskRow } from './store.js'

/** Everything dispatch needs to turn a task's server ids into usable credentials. */
export interface McpAccess {
  registry: McpRegistry
  oauth: McpOAuth
}

/**
 * A server resolved for one run: the spec entry, plus the bearer token the broker will hand
 * out. Resolved here, in the control plane, because this is the only place that can refresh
 * an OAuth token — the container is headless and holds no refresh token.
 */
interface ResolvedMcpServer {
  id: string
  name: string
  url: string
  token?: string
}

/**
 * Turn a task into a run.
 *
 * Two execution modes, both real:
 *
 *  - `inline` runs the adapter in this process. Fast, easy to debug, no image needed.
 *  - `docker` runs it in the golden image, which is what validates the container path —
 *    the uid, the mounts, the harness install, config projection inside a container.
 *
 * Both produce the same event stream, which is the point: the UI cannot tell them apart.
 */
export type DispatchMode = 'inline' | 'docker'

export interface DispatchConfig {
  mode: DispatchMode
  bundleRoot: string
  image: string
  /** Where mirrors and worktrees live on the host. */
  workRoot: string
  githubToken?: string
  /**
   * Model override, `provider/model` as the harness spells it.
   *
   * Worth having because the default points at opencode's free hosted models, which are a
   * shared service that can and does return server errors — at which point every run fails
   * for a reason that has nothing to do with this code. Pointing at a provider you hold an
   * API key for takes that dependency out of the loop.
   */
  model?: string
  /** Provider credentials forwarded to the harness. Never logged, never projected. */
  harnessEnv?: Record<string, string>
  /** Passed through so a container can reach a bind-mounted origin. */
  extraMounts?: Array<{ source: string; target: string; readOnly?: boolean }>
}

export async function dispatchTask(args: {
  store: Store
  task: TaskRow
  config: DispatchConfig
  mcp: McpAccess
}): Promise<{ runId: string }> {
  const { store, task, config, mcp } = args

  const branch = renderBranchName('feat/{{task.slug}}-{{task.id}}', {
    taskId: task.id.replace(/^task_/, ''),
    slug: slugify(task.title),
  })
  const run = store.createRun(task.id, task.harness, branch)
  store.setTaskStatus(task.id, 'dispatched')

  const servers = await resolveMcpServers(task, mcp)
  const spec = buildRunSpec({ task, run: run.id, branch, config, servers })

  // Deliberately not awaited: dispatch returns 202 and the UI follows the event stream.
  // A dispatch that blocked until the run finished would make the request time out long
  // before a real task completes.
  void execute({ store, runId: run.id, taskId: task.id, spec, config, servers }).catch(
    (error: unknown) => {
      store.updateRun(run.id, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message : String(error),
      })
      moveTask(store, task.id, 'failed')
    },
  )

  return { runId: run.id }
}

async function execute(args: {
  store: Store
  runId: string
  taskId: string
  spec: RunSpec
  config: DispatchConfig
  servers: readonly ResolvedMcpServer[]
}): Promise<void> {
  const { store, runId, taskId, spec, config, servers } = args
  store.updateRun(runId, { status: 'provisioning' })

  const sink = (event: AgentEvent) => {
    store.appendEvent(event)
    // Stage records are rebuilt from the stream rather than taken from a return value,
    // because in docker mode there is no return value to take them from — the container's
    // events are all that crosses the boundary. Doing it here keeps both modes reporting
    // the same stage list instead of docker runs showing an empty one.
    recordStage(store, runId, event)
    if (event.type === 'run.started') {
      store.updateRun(runId, { status: 'running' })
      // The task has to move too, not just the run. `dispatched → in_review` is not a
      // legal transition, so without this step the task would be stuck on `dispatched`
      // for the rest of its life while its run reported success.
      moveTask(store, taskId, 'running')
    }
    if (event.type === 'pr.opened') store.updateRun(runId, { prUrl: event.data.url })
  }

  if (config.mode === 'inline') {
    const runtime = await mkdtemp(join(tmpdir(), `intellidev-${runId}-`))
    const result = await runAdapter({
      spec,
      credentials: new LocalCredentialProvider({
        ...(config.githubToken ? { githubToken: config.githubToken } : {}),
        mcpTokens: Object.fromEntries(
          servers.flatMap((server) => (server.token ? [[server.id, server.token]] : [])),
        ),
      }),
      sink,
      paths: {
        brokerSocket: join(runtime, 'broker.sock'),
        statePath: join(runtime, 'state.json'),
        bundleRoot: config.bundleRoot,
        home: join(runtime, 'home'),
      },
    })
    settle(store, runId, taskId, result.outcome, result.records, result.prUrl)
    return
  }

  await executeInDocker({ store, runId, taskId, spec, config, sink, servers })
}

/**
 * Run the adapter inside the golden image.
 *
 * Events come back by tailing the JSONL file the adapter writes to a bind-mounted
 * directory, rather than over a socket. That is a local shortcut: the deployed path has the
 * adapter dial out over a WebSocket, and swapping to it changes nothing the UI sees, since
 * both produce the same numbered events.
 */
async function executeInDocker(args: {
  store: Store
  runId: string
  taskId: string
  spec: RunSpec
  config: DispatchConfig
  sink: (event: AgentEvent) => void
  servers: readonly ResolvedMcpServer[]
}): Promise<void> {
  const { store, runId, taskId, spec, config, sink, servers } = args

  // Under the work root, not `os.tmpdir()`. On macOS the temp dir is `/var/folders/...`,
  // which Docker Desktop does not share with the VM, so a bind mount of it fails with
  // "bind source path does not exist" even though the path is right there on the host.
  const exchange = join(config.workRoot, 'exchange', runId)
  await mkdir(exchange, { recursive: true })
  const specPath = join(exchange, 'spec.json')
  const eventsPath = join(exchange, 'events.jsonl')

  // Paths inside the container, which are not the host's.
  const containerSpec = { ...spec, brokerSocket: '/run/intellidev/broker.sock' }
  containerSpec.git = {
    ...spec.git,
    mirrorPath: '/cache/git',
    worktreePath: `/work/${runId}`,
  }
  await writeFile(specPath, JSON.stringify(containerSpec, null, 2))
  await writeFile(eventsPath, '')

  const runner = new DockerRunner()
  const tail = tailEvents(eventsPath, sink)

  try {
    const result = await runner.launch({
      runId,
      image: config.image,
      args: [
        'run',
        '--spec',
        '/run/exchange/spec.json',
        '--bundle',
        '/opt/project',
        '--events',
        '/run/exchange/events.jsonl',
      ],
      env: {
        ...(config.githubToken ? { INTELLIDEV_GITHUB_TOKEN: config.githubToken } : {}),
        // A bind-mounted origin is owned by the host uid, not the container's, so git
        // refuses it as "dubious ownership". Scoped to the local bind-mount case rather
        // than baked into the image: a real run clones over HTTPS, where the check is a
        // genuine protection and should keep firing.
        ...(config.extraMounts?.length ? { INTELLIDEV_GIT_SAFE_DIRECTORY: '*' } : {}),
        ...mcpTokenEnv(servers),
        // The drivers spawn a harness with `{ ...process.env, ...req.env }`, so anything set
        // on the container reaches it. That is how a provider key gets in without the adapter
        // needing to know which providers exist.
        ...(config.harnessEnv ?? {}),
      },
      mounts: [
        { source: exchange, target: '/run/exchange' },
        { source: resolve(config.bundleRoot), target: '/opt/project', readOnly: true },
        ...(config.extraMounts ?? []),
      ],
      // The local stand-in for the S3 cache: a named volume per project keeps the git
      // mirror between runs.
      cacheVolume: { name: `intellidev-cache-${spec.projectId}`, target: '/cache' },
      cpus: 2,
      memoryMb: 4096,
      timeoutSec: spec.limits.wallClockSec,
      onOutput: (_stream: string, chunk: string) => process.stderr.write(chunk),
      onArgv: (argv: readonly string[]) => process.stderr.write(`$ ${argv.join(' ')}\n\n`),
    })

    store.updateRun(runId, { handle: result.handle })
    // Give the tail a moment to drain what the container wrote as it exited.
    await new Promise((r) => setTimeout(r, 300))

    const outcome = result.timedOut ? 'failed' : result.exitCode === 0 ? 'succeeded' : 'failed'
    settle(
      store,
      runId,
      taskId,
      outcome,
      store.getRun(runId)?.records ?? [],
      store.getRun(runId)?.prUrl,
      result.timedOut ? `exceeded ${spec.limits.wallClockSec}s wall clock` : undefined,
    )
  } finally {
    tail.stop()
  }
}

/** Poll a JSONL file and forward complete lines. */
function tailEvents(path: string, sink: (event: AgentEvent) => void): { stop: () => void } {
  let offset = 0
  let stopped = false
  let partial = ''

  const poll = async () => {
    if (stopped) return
    try {
      const { readFile } = await import('node:fs/promises')
      const text = await readFile(path, 'utf8')
      if (text.length > offset) {
        partial += text.slice(offset)
        offset = text.length
        const lines = partial.split('\n')
        // Keep the last fragment: the container may be mid-write.
        partial = lines.pop() ?? ''
        for (const line of lines) {
          if (!line.trim()) continue
          try {
            sink(JSON.parse(line) as AgentEvent)
          } catch {
            // A torn line will be complete on the next poll.
          }
        }
      }
    } catch {
      // The file may not exist for an instant at startup.
    }
    if (!stopped) setTimeout(poll, 200)
  }
  void poll()

  return { stop: () => (stopped = true) }
}

/**
 * Fold `stage.entered` / `stage.exited` into the run's stage records.
 *
 * Deliberately keyed on stage *and* attempt: a retried stage is a separate record, so a
 * template that loops on a failed gate shows each attempt rather than overwriting the
 * history with whichever ran last.
 */
function recordStage(store: Store, runId: string, event: AgentEvent): void {
  if (event.type !== 'stage.entered' && event.type !== 'stage.exited') return
  const stage = event.stage
  if (!stage) return

  const run = store.getRun(runId)
  if (!run) return

  const records = [...run.records]
  const index = records.findIndex((r) => r.stage === stage && r.attempt === event.data.attempt)
  const existing = index === -1 ? undefined : records[index]

  const record: StageRecord =
    event.type === 'stage.entered'
      ? {
          stage,
          attempt: event.data.attempt,
          status: 'running',
          resumeToken: null,
          gatePassed: null,
          startedAt: event.ts,
        }
      : {
          stage,
          attempt: event.data.attempt,
          status: event.data.outcome,
          resumeToken: existing?.resumeToken ?? null,
          gatePassed: existing?.gatePassed ?? null,
          ...(existing?.startedAt ? { startedAt: existing.startedAt } : {}),
          endedAt: event.ts,
        }

  if (index === -1) records.push(record)
  else records[index] = record
  store.updateRun(runId, { records })
}

/**
 * The broker reads a per-server token from the environment, so this is the one place that
 * has to agree with `LocalCredentialProvider.mcpToken` on the variable name.
 */
function mcpTokenEnv(servers: readonly ResolvedMcpServer[]): Record<string, string> {
  const env: Record<string, string> = {}
  for (const server of servers) {
    if (server.token) env[`INTELLIDEV_MCP_TOKEN_${server.id.toUpperCase()}`] = server.token
  }
  return env
}

/**
 * Turn the task's server ids into specs with live tokens.
 *
 * Refreshing happens here, once per dispatch. A server the task names but that is no longer
 * connected is skipped rather than fatal: losing one optional tool source should degrade the
 * run, not delete it — and the run log records the absence via `upstream_unavailable`.
 */
async function resolveMcpServers(task: TaskRow, mcp: McpAccess): Promise<ResolvedMcpServer[]> {
  const resolved: ResolvedMcpServer[] = []
  for (const id of task.mcpServerIds ?? []) {
    const server = mcp.registry.get(id)
    if (!server) continue
    const token = await mcp.oauth.accessToken(server)
    resolved.push({
      id: server.id,
      name: server.name,
      url: server.url,
      ...(token ? { token } : {}),
    })
  }
  return resolved
}

/**
 * Rewrite a loopback URL so a container can actually reach it.
 *
 * `127.0.0.1` inside a container is the container, so a fixture server on the host would
 * look simply dead. Rewriting it here beats making everyone remember, and the failure it
 * prevents — an optional server that silently fails to connect — is one where the agent
 * carries on and invents an answer.
 */
function containerReachableUrl(url: string, mode: DispatchMode): string {
  if (mode !== 'docker') return url
  return url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/, '$1host.docker.internal')
}

function settle(
  store: Store,
  runId: string,
  taskId: string,
  outcome: string,
  records: unknown[],
  prUrl?: string,
  failureReason?: string,
): void {
  const succeeded = outcome === 'succeeded'
  store.updateRun(runId, {
    status: succeeded ? 'succeeded' : outcome === 'parked' ? 'parked' : 'failed',
    endedAt: new Date().toISOString(),
    // Only when the caller actually has records: docker mode passes none, and overwriting
    // the stream-derived list with an empty array is how the stage list went blank.
    ...(records.length ? { records: records as never } : {}),
    ...(prUrl ? { prUrl } : {}),
    ...(failureReason ? { failureReason } : {}),
  })
  // A finished run puts the task in review, not done: a human decides whether the PR is
  // acceptable, which is the whole reason the PR is the boundary.
  moveTask(store, taskId, succeeded ? 'in_review' : 'failed')
}

/**
 * Move a task, recording a refusal instead of swallowing it.
 *
 * The first version of this caught and ignored the error, which hid a real state-machine
 * violation: a run reported success while its task sat on `dispatched` forever. A refused
 * transition is either a bug in the caller or a genuine race, and both deserve to be
 * visible rather than silent.
 */
function moveTask(store: Store, taskId: string, status: TaskStatus): void {
  const task = store.getTask(taskId)
  if (!task || task.status === status) return
  try {
    store.setTaskStatus(taskId, status)
  } catch (error) {
    process.stderr.write(
      `[dispatch] refused task transition ${task.status} → ${status} for ${taskId}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

function buildRunSpec(args: {
  task: TaskRow
  run: string
  branch: string
  config: DispatchConfig
  servers: readonly ResolvedMcpServer[]
}): RunSpec {
  const { task, run, branch, config, servers } = args

  // A single-gate template for the local path: the default template's gates assume a pnpm
  // project, and a demo repo rarely is one.
  const template = StageTemplate.parse({
    name: 'local',
    stages: [
      {
        id: 'design',
        kind: 'agent',
        promptFile: 'prompts/design.md',
        tools: { mode: 'read_only' },
      },
      { id: 'branch', kind: 'builtin', action: 'git.create_branch' },
      { id: 'code', kind: 'agent', promptFile: 'prompts/code.md', tools: { mode: 'full' } },
      // No `pr` stage: a `file://` origin has no GitHub to open one against. The commit
      // stage is what makes the run's work outlive the container, so it is not optional.
      { id: 'commit', kind: 'builtin', action: 'git.commit' },
    ],
  })

  return RunSpec.parse({
    runId: run,
    taskId: task.id,
    projectId: 'local',
    manifestVersion: 1,
    manifest: {
      version: 1,
      project: 'local',
      repos: [{ url: task.repoUrl, defaultBranch: task.baseBranch }],
      harnesses: {
        default: task.harness,
        allowed: [task.harness],
        seatPool: 'local',
        models: config.model ? { [task.harness]: { model: config.model } } : {},
      },
      contextFile: './context/repo.md',
      stageTemplate: template,
      git: { partialClone: false },
      env: { vars: {}, secrets: [], dotenvPath: null },
    },
    bundle: { url: 'file:///dev/null', digest: 'local' },
    task: {
      id: task.id,
      title: task.title,
      description: task.description,
      ...(task.details ? { details: task.details } : {}),
      acceptanceCriteria: task.acceptanceCriteria,
    },
    harness: task.harness,
    stageTemplate: template,
    toolset: {
      servers: servers.map((server) => ({
        server: {
          id: server.id,
          name: server.name,
          kind: 'remote_http',
          // Bearer whenever a token was resolved — an OAuth server looks identical to a PAT
          // server from here, which is what keeps the container ignorant of OAuth.
          auth: server.token ? 'bearer' : 'none',
          url: containerReachableUrl(server.url, config.mode),
          args: [],
        },
        attachment: {
          serverId: server.id,
          config: {},
          required: false,
          // Empty means every tool, in every stage.
          enabledTools: [],
          stages: [],
          health: 'ok',
        },
      })),
      skills: [],
    },
    git: {
      repoUrl: task.repoUrl,
      baseBranch: task.baseBranch,
      branch,
      mirrorPath: join(config.workRoot, 'cache'),
      worktreePath: join(config.workRoot, 'work', run),
    },
    seat: { id: 'local', pool: 'local', provider: 'local' },
    limits: {
      wallClockSec: 1800,
      idleKillSec: 600,
      perStageTimeoutSec: 600,
      tokensMax: 2_000_000,
      usdEstMax: 5,
    },
    controlPlaneUrl: 'http://127.0.0.1:4000',
    streamUrl: `ws://127.0.0.1:4000/runs/${run}/stream`,
    brokerSocket: join(config.workRoot, `${run}.broker.sock`),
  })
}

export { DEFAULT_STAGE_TEMPLATE }
