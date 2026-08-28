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
  type HarnessId,
  type StageRecord,
  type TaskStatus,
} from '@intellidev/shared'
import { isRunTerminal } from '@intellidev/shared'
import { DockerRunner, LocalCredentialProvider, runAdapter } from '@intellidev/adapter'
import type { Runner } from '@intellidev/adapter'
import type { AwsRuntimeConfig } from './aws/config.js'
import { FargateRunner } from './runner/fargate.js'
import { ArtifactStore } from './aws/artifacts.js'
import type { RunTokenRegistry } from './runs/tokens.js'
import { preflightRepo } from './runs/preflight.js'
import type { SeatStore } from './harness/seat-store.js'
import type { McpOAuth } from './mcp/oauth.js'
import type { McpStore } from './mcp/store.js'
import type { Store, TaskRow } from './store.js'

/** Everything dispatch needs to turn a task's server ids into usable credentials. */
export interface McpAccess {
  registry: McpStore
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
export type DispatchMode = 'inline' | 'docker' | 'fargate'

export interface DispatchConfig {
  mode: DispatchMode
  bundleRoot: string
  image: string
  /**
   * Which project a run belongs to.
   *
   * Every scoped resource name derives from this: the cache prefix, secret names, the seat
   * pool, log groups. It used to be the literal `'local'` inline in the run spec, which
   * meant two projects would have silently shared one cache. It is configuration now, so
   * `dev` and a real deployment differ by a value rather than by an edit.
   *
   * B1 replaces this with a row from the `projects` table; until then it is one value
   * resolved at boot.
   */
  projectId: string
  /**
   * Where a run reaches the control plane from *outside* this process.
   *
   * Was hardcoded to `http://127.0.0.1:4000` in the run spec, which is a resource address
   * in application code — and wrong for every deployment. `containerReachableUrl` still
   * rewrites it for Docker, because a container's localhost is not the host's.
   */
  publicUrl: string
  /** Mints and revokes the one credential a run holds. */
  tokens?: RunTokenRegistry
  /**
   * Resolved AWS configuration, required by `fargate` mode and unused otherwise.
   *
   * Passed in rather than read here so dispatch has no knowledge of SSM, regions or
   * parameter paths — it receives names, it never forms them.
   */
  aws?: AwsRuntimeConfig
  /** Where mirrors and worktrees live on the host. */
  workRoot: string
  githubToken?: string
  /**
   * Model overrides keyed by harness, each spelled the way that harness spells them.
   *
   * Worth having because the default pointed at opencode's free hosted models, a shared
   * service that can and does return server errors — at which point every run fails for a
   * reason unrelated to this code. Pointing at a provider you hold credentials for takes that
   * dependency out of the loop.
   */
  models?: Partial<Record<HarnessId, string>>
  /** Provider credentials forwarded to the harness. Never logged, never projected. */
  harnessEnv?: Record<string, string>
  /** Passed through so a container can reach a bind-mounted origin. */
  extraMounts?: Array<{ source: string; target: string; readOnly?: boolean }>
}

/**
 * The longest a unix socket path may be.
 *
 * `sun_path` is 104 bytes on macOS and 108 on Linux. The smaller one is the constraint worth
 * respecting, because it is the one developers hit.
 */
export const UNIX_SOCKET_PATH_LIMIT = 104

/**
 * The temp-directory prefix for one run's inline runtime.
 *
 * Short on purpose. The credential broker listens on a unix socket inside this directory, and
 * on macOS `tmpdir()` is already ~50 characters (`/var/folders/_t/<random>/T/`). A full run id
 * plus `mkdtemp`'s six random characters plus `/broker.sock` overran the limit the moment run
 * ids became uuids, and the failure is `listen EINVAL: invalid argument` — which names neither
 * the limit nor the cause.
 *
 * Eight hex characters distinguish concurrent runs well enough for a temp directory, and
 * `mkdtemp` adds entropy of its own, so uniqueness does not rest on this.
 */
export function runtimeDirPrefix(runId: string): string {
  return `idv-${runId.slice(0, 8)}-`
}

/** A dispatch refused before anything was created. Becomes a 400, not a failed run. */
export class DispatchRefused extends Error {}

export async function dispatchTask(args: {
  store: Store
  task: TaskRow
  config: DispatchConfig
  mcp: McpAccess
  accounts: SeatStore
}): Promise<{ runId: string }> {
  const { store, task, config, mcp, accounts } = args

  /**
   * Refuse before spending anything.
   *
   * An empty repository or a wrong base branch used to cost a whole dispatch to discover —
   * an ECS task, a 387 MB image pull, thirty seconds — and the answer arrived as a git error
   * in a container log rather than on the board. `git ls-remote` answers it in under a
   * second, so it is checked here, where refusing is free.
   */
  const preflight = await preflightRepo({
    repoUrl: task.repoUrl,
    baseBranch: task.baseBranch,
    ...(config.githubToken ? { githubToken: config.githubToken } : {}),
  })
  if (!preflight.ok) {
    // Thrown rather than recorded as a failed run: nothing was dispatched, so there is no
    // run to explain — and the caller turns this into a 400 the UI shows on the form.
    throw new DispatchRefused(preflight.problem ?? 'the repository cannot be used')
  }

  const branch = renderBranchName('feat/{{task.slug}}-{{task.id}}', {
    // The first eight characters, not the whole id. Task ids are uuids now, and a full one made
    // branches like `feat/add-a-thing-41c1aad7-a6a0-434b-bbda-53917c60569a` — unreadable in a
    // PR list, and close to limits on the tooling that has to carry it. Eight hex characters
    // distinguish a project's open branches without needing to be globally unique.
    taskId: task.id.replace(/^task_/, '').slice(0, 8),
    slug: slugify(task.title),
  })
  const run = await store.createRun(task.id, task.harness, branch)
  await store.setTaskStatus(task.id, 'dispatched')

  const servers = await resolveMcpServers(task, mcp)
  // Material travels in the environment, not the spec: the spec is written to a bind-mounted
  // directory and this is a credential.
  // Seats are space-scoped, and the task carries the space it belongs to.
  const seat = await accounts.material({ clientSpaceId: task.clientSpaceId }, task.harness)
  const spec = buildRunSpec({ task, run: run.id, branch, config, servers })

  // Deliberately not awaited: dispatch returns 202 and the UI follows the event stream.
  // A dispatch that blocked until the run finished would make the request time out long
  // before a real task completes.
  void execute({ store, runId: run.id, taskId: task.id, spec, config, servers, seat }).catch(
    (error: unknown) => {
      void store.updateRun(run.id, {
        status: 'failed',
        endedAt: new Date().toISOString(),
        failureReason: error instanceof Error ? error.message : String(error),
      })
      void moveTask(store, task.id, 'failed')
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
  seat: Record<string, unknown> | undefined
}): Promise<void> {
  const { store, runId, taskId, spec, config, servers, seat } = args
  await store.updateRun(runId, { status: 'provisioning' })

  /**
   * The sink is synchronous by contract — an event is a fact that already happened, and the
   * bus must not be blocked on a database ~85 ms away. So the writes are launched here and
   * ordered by chaining rather than awaited: two `updateRun` calls racing would let the
   * later-resolving one overwrite the other's records.
   */
  let writes: Promise<unknown> = Promise.resolve()
  const sink = (event: AgentEvent) => {
    writes = writes
      .then(() => persist(event))
      .catch((error: unknown) => {
        process.stderr.write(
          `[dispatch] failed to persist ${event.type} seq ${event.seq}: ${String(error)}\n`,
        )
      })
  }

  const persist = async (event: AgentEvent): Promise<void> => {
    await store.appendEvent(event)
    await projectRunEvent(store, runId, taskId, event)
  }

  if (config.mode === 'inline') {
    const runtime = await mkdtemp(join(tmpdir(), runtimeDirPrefix(runId)))
    const result = await runAdapter({
      spec,
      credentials: new LocalCredentialProvider({
        ...(config.githubToken ? { githubToken: config.githubToken } : {}),
        mcpTokens: Object.fromEntries(
          servers.flatMap((server) => (server.token ? [[server.id, server.token]] : [])),
        ),
        ...(seat ? { seatMaterial: { [spec.harness]: seat } } : {}),
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

  await executeInDocker({ store, runId, taskId, spec, config, sink, servers, seat })
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
  seat: Record<string, unknown> | undefined
}): Promise<void> {
  const { store, runId, taskId, spec, config, sink, servers, seat } = args

  // Under the work root, not `os.tmpdir()`. On macOS the temp dir is `/var/folders/...`,
  // which Docker Desktop does not share with the VM, so a bind mount of it fails with
  // "bind source path does not exist" even though the path is right there on the host.
  const exchange = join(config.workRoot, 'exchange', runId)
  await mkdir(exchange, { recursive: true })
  const specPath = join(exchange, 'spec.json')
  const eventsPath = join(exchange, 'events.jsonl')

  // Paths inside the container, which are not the host's.
  const containerSpec: RunSpec = {
    ...spec,
    brokerSocket: '/run/intellidev/broker.sock',
    git: { ...spec.git, mirrorPath: '/cache/git', worktreePath: `/work/${runId}` },
  }
  await writeFile(specPath, JSON.stringify(containerSpec, null, 2))
  await writeFile(eventsPath, '')

  /**
   * On Fargate the spec and the bundle travel as S3 objects, not bind mounts.
   *
   * The bundle ref is rewritten to a presigned URL here rather than in the runner, because
   * the digest that pins it belongs to the *spec* — the run must verify the bundle against
   * what dispatch decided, not against whatever the URL happens to serve.
   */
  const remote = config.mode === 'fargate' ? await stageArtifacts(config, containerSpec) : null

  const runner: Runner = selectRunner(config)

  /**
   * The run's outbound event socket.
   *
   * Only when a token registry exists, so a caller that has not opted in keeps the previous
   * behaviour exactly. The URL is rewritten for Docker, whose localhost is the container's
   * own — the same reason MCP server URLs are rewritten a few lines below.
   */
  const eventChannel = config.tokens
    ? {
        token: (await config.tokens.mint(runId)).token,
        url: `${containerReachableUrl(config.publicUrl, config.mode).replace(/^http/, 'ws')}/internal/runs/${runId}/events`,
      }
    : undefined
  const tail = tailEvents(eventsPath, sink)

  try {
    const started = await runner.start({
      runId,
      image: config.image,
      args: remote
        ? // No --bundle: the adapter materialises it from the spec and verifies the digest
          // before extracting. No --events either; there is no shared filesystem to tail,
          // and C4 replaces the file with the adapter dialling out over a WebSocket.
          ['run', '--spec', remote.specUrl]
        : [
            'run',
            '--spec',
            '/run/exchange/spec.json',
            '--bundle',
            '/opt/project',
            '--events',
            '/run/exchange/events.jsonl',
          ],
      /**
       * What a run is allowed to hold.
       *
       * **Only its own run token**, once a token registry exists. Everything else — the
       * GitHub credential, every MCP token, the harness seat material — is fetched from the
       * broker over HTTPS with that bearer. Before B3 they all travelled here, where the
       * model-authored code in the container could read them and, on Fargate, where anyone
       * with `ecs:DescribeTasks` could read them from the console.
       *
       * The fallbacks below only apply when there is no registry, which is the local
       * develop-the-adapter path.
       */
      env: {
        ...(eventChannel
          ? {
              INTELLIDEV_EVENTS_URL: eventChannel.url,
              INTELLIDEV_RUN_TOKEN: eventChannel.token,
            }
          : {}),
        ...(eventChannel
          ? {}
          : config.githubToken
            ? { INTELLIDEV_GITHUB_TOKEN: config.githubToken }
            : {}),
        // A bind-mounted origin is owned by the host uid, not the container's, so git
        // refuses it as "dubious ownership". Scoped to the local bind-mount case rather
        // than baked into the image: a real run clones over HTTPS, where the check is a
        // genuine protection and should keep firing.
        ...(config.extraMounts?.length ? { INTELLIDEV_GIT_SAFE_DIRECTORY: '*' } : {}),
        // MCP tokens, provider keys and seat material are all broker-served now. They are
        // still passed on the local path, where there is no broker to ask.
        ...(eventChannel
          ? {}
          : {
              ...mcpTokenEnv(servers),
              // The drivers spawn a harness with `{ ...process.env, ...req.env }`, so
              // anything set here reaches it — which is how a provider key got in without
              // the adapter knowing which providers exist.
              ...(config.harnessEnv ?? {}),
              ...(seat
                ? { INTELLIDEV_SEAT_MATERIAL: JSON.stringify({ [spec.harness]: seat }) }
                : {}),
            }),
      },
      // Fargate has none of this: the spec and bundle arrive over HTTPS, and C3 replaces
      // the cache volume with an S3 prefix. Passing them would make FargateRunner throw.
      ...(remote
        ? {}
        : {
            mounts: [
              { source: exchange, target: '/run/exchange' },
              { source: resolve(config.bundleRoot), target: '/opt/project', readOnly: true },
              ...(config.extraMounts ?? []),
            ],
            // The local stand-in for the S3 cache: a named volume per project keeps the git
            // mirror between runs.
            cacheVolume: { name: `intellidev-cache-${spec.projectId}`, target: '/cache' },
          }),
      cpus: 2,
      memoryMb: 4096,
      timeoutSec: spec.limits.wallClockSec,
      onOutput: (_stream: string, chunk: string) => process.stderr.write(chunk),
      onArgv: (argv: readonly string[]) => process.stderr.write(`$ ${argv.join(' ')}\n\n`),
    })

    // Recorded before awaiting the outcome, which is the whole reason `start` and the
    // outcome are separate. On Fargate this handle is the task ARN — the only thing that
    // can cancel the run or let the C5 reconciler settle it — and waiting until the run
    // ended to store it would mean not having it during the window it is needed.
    await store.updateRun(runId, { handle: started.handle })

    const result = await started.outcome
    // Give the tail a moment to drain what the container wrote as it exited.
    await new Promise((r) => setTimeout(r, 300))

    const outcome = result.timedOut ? 'failed' : result.exitCode === 0 ? 'succeeded' : 'failed'
    await settle(
      store,
      runId,
      taskId,
      outcome,
      (await store.getRun(runId))?.records ?? [],
      (await store.getRun(runId))?.prUrl,
      // The runtime's own explanation wins when it has one: an ECS stopped reason says
      // "OutOfMemoryError" where an exit code says only that it failed.
      result.timedOut
        ? `exceeded ${spec.limits.wallClockSec}s wall clock`
        : (result.reason ?? undefined),
      config.tokens,
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
/**
 * Derives a run's visible state from one event.
 *
 * FOUND BY RUNNING IT. This used to live inside dispatch's own sink, which the inline and docker
 * paths feed by tailing an events file. On Fargate there is no file — the container dials out
 * over a WebSocket and the server appends straight to the store — so none of it ran. A Fargate
 * run therefore finished `succeeded` with **zero stage records and a null `pr_url`**, while its
 * PR sat open on GitHub. The run worked; everything a person would want to look at afterwards
 * was missing.
 *
 * Shared rather than duplicated, because the two paths differing in what they record is the
 * exact bug this is fixing.
 */
export async function projectRunEvent(
  store: Store,
  runId: string,
  taskId: string,
  event: AgentEvent,
): Promise<void> {
  // Stage records are rebuilt from the stream rather than taken from a return value, because
  // in container modes there is no return value to take them from — the events are all that
  // crosses the boundary.
  await recordStage(store, runId, event)
  if (event.type === 'run.started') {
    await store.updateRun(runId, { status: 'running' })
    // The task has to move too, not just the run. `dispatched → in_review` is not a legal
    // transition, so without this the task would be stuck on `dispatched` for the rest of its
    // life while its run reported success.
    await moveTask(store, taskId, 'running')
  }
  if (event.type === 'pr.opened') await store.updateRun(runId, { prUrl: event.data.url })
}

async function recordStage(store: Store, runId: string, event: AgentEvent): Promise<void> {
  if (event.type !== 'stage.entered' && event.type !== 'stage.exited') return
  const stage = event.stage
  if (!stage) return

  const run = await store.getRun(runId)
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
  await store.updateRun(runId, { records })
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
    const server = await mcp.registry.get(id)
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
/**
 * Writes the spec to S3 and presigns what the run needs to read.
 *
 * Returns the spec URL, and mutates nothing the caller did not hand over: the bundle ref
 * inside the spec is replaced *before* the spec is uploaded, so the object a run fetches
 * already names the presigned bundle URL and the digest it must match.
 */
async function stageArtifacts(
  config: DispatchConfig,
  containerSpec: RunSpec,
): Promise<{ specUrl: string; bundleDigest: string }> {
  const aws = config.aws
  if (!aws) throw new Error('fargate mode requires resolved AWS config')

  const published = aws.bundles[containerSpec.projectId]
  if (!published) {
    // Naming the command is the difference between a two-minute fix and a hunt through S3.
    throw new Error(
      `no bundle published for project "${containerSpec.projectId}" in ${aws.env}. ` +
        `Run: pnpm bundle:push --project ${containerSpec.projectId}`,
    )
  }

  const store = new ArtifactStore({ bucket: aws.artifactBucket, region: aws.region })
  const bundleUrl = await store.presignGet(published.key)

  const withRemoteBundle: RunSpec = {
    ...containerSpec,
    bundle: { url: bundleUrl, digest: published.digest },
  }
  const { url: specUrl } = await store.putRunSpec(withRemoteBundle)
  return { specUrl, bundleDigest: published.digest }
}

/**
 * Picks the runtime for this dispatch.
 *
 * `DockerRunner` is not a fallback — it is the local loop, and the fastest way to reproduce
 * a production failure. Both satisfy one interface, so nothing downstream branches on which
 * one is in use.
 */
function selectRunner(config: DispatchConfig): Runner {
  if (config.mode !== 'fargate') return new DockerRunner()
  if (!config.aws) {
    throw new Error(
      'fargate mode needs resolved AWS config; set INTELLIDEV_ENV and check the ' +
        'infrastructure is deployed (pnpm infra:verify)',
    )
  }
  return new FargateRunner({ config: config.aws })
}

function containerReachableUrl(url: string, mode: DispatchMode): string {
  if (mode !== 'docker') return url
  return url.replace(/^(https?:\/\/)(127\.0\.0\.1|localhost)(?=[:/]|$)/, '$1host.docker.internal')
}

/**
 * Records a run's terminal state, once.
 *
 * Three paths can now reach a finished run and they genuinely race: the runner's own
 * observed outcome, an ECS task-state-change event off the queue, and the reconciler's
 * sweep. That is deliberate redundancy — each covers a failure the others miss — so the
 * requirement is that whichever arrives first wins and the rest are no-ops.
 *
 * Returns whether it settled the run, so a caller can tell "I finished it" from "someone
 * else already had" rather than logging a second outcome for the same run.
 */
export async function settle(
  store: Store,
  runId: string,
  taskId: string,
  outcome: string,
  records: unknown[],
  prUrl?: string,
  failureReason?: string,
  /** Revoked on settle: a token that outlives its run is a standing credential. */
  tokens?: { revoke(runId: string): Promise<void> },
): Promise<boolean> {
  const existing = await store.getRun(runId)
  // `isRunTerminal`, not `!== 'running'`. There are four non-terminal statuses — queued,
  // provisioning, running, parked — and a run killed while its task was still PROVISIONING
  // sits in `provisioning`. Guarding on `running` alone meant exactly the leak this
  // mechanism exists to prevent: the reconciler would decline to settle it for ever.
  if (existing && isRunTerminal(existing.status)) {
    // Overwriting would replace a specific cause with whichever path was slowest —
    // typically the reconciler's "task is gone", which says nothing useful.
    return false
  }
  const succeeded = outcome === 'succeeded'
  await store.updateRun(runId, {
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
  await moveTask(store, taskId, succeeded ? 'in_review' : 'failed')
  // Not awaited: settling must not fail because a revoke was slow, and the token expires
  // on its own regardless. Logged rather than silent, so a persistent failure is visible.
  void tokens?.revoke(runId).catch(() => undefined)
  return true
}

/**
 * Move a task, recording a refusal instead of swallowing it.
 *
 * The first version of this caught and ignored the error, which hid a real state-machine
 * violation: a run reported success while its task sat on `dispatched` forever. A refused
 * transition is either a bug in the caller or a genuine race, and both deserve to be
 * visible rather than silent.
 */
async function moveTask(store: Store, taskId: string, status: TaskStatus): Promise<void> {
  const task = await store.getTask(taskId)
  if (!task || task.status === status) return
  try {
    await store.setTaskStatus(taskId, status)
  } catch (error) {
    process.stderr.write(
      `[dispatch] refused task transition ${task.status} → ${status} for ${taskId}: ` +
        `${error instanceof Error ? error.message : String(error)}\n`,
    )
  }
}

/**
 * Whether the origin is something a pull request can be opened against.
 *
 * The template's comment always said "a `file://` origin has no GitHub to open one
 * against", but the condition was never actually applied — so a real GitHub remote got the
 * local template too, and stopped at a commit nobody could reach.
 */
export function hasRemoteOrigin(repoUrl: string): boolean {
  if (repoUrl.startsWith('file:') || repoUrl.startsWith('/')) return false
  return /^https?:\/\//.test(repoUrl) || /^[^@\s]+@[^:\s]+:/.test(repoUrl)
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
      // Pushes and opens a pull request — and pushing is the point. Without it a run
      // commits into a worktree whose mirror is the container's own ephemeral storage, so
      // a "succeeded" run leaves nothing behind at all. That was true of every Fargate run
      // until now: the commit sha was real and unreachable.
      ...(hasRemoteOrigin(task.repoUrl)
        ? [{ id: 'pr' as const, kind: 'builtin' as const, action: 'github.open_pr' as const }]
        : []),
    ],
  })

  return RunSpec.parse({
    runId: run,
    taskId: task.id,
    projectId: config.projectId,
    manifestVersion: 1,
    manifest: {
      version: 1,
      project: config.projectId,
      repos: [{ url: task.repoUrl, defaultBranch: task.baseBranch }],
      harnesses: {
        default: task.harness,
        allowed: [task.harness],
        seatPool: config.projectId,
        models: config.models?.[task.harness]
          ? { [task.harness]: { model: config.models[task.harness] } }
          : {},
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
    seat: { id: 'local', pool: config.projectId, provider: 'local' },
    limits: {
      wallClockSec: 1800,
      idleKillSec: 600,
      perStageTimeoutSec: 600,
      tokensMax: 2_000_000,
      usdEstMax: 5,
    },
    // Rewritten for the runtime, exactly as the event socket URL is: a container's
    // localhost is its own, so an unrewritten loopback address looks simply dead — and the
    // broker being unreachable is the difference between an unauthenticated run and a
    // working one.
    controlPlaneUrl: containerReachableUrl(config.publicUrl, config.mode),
    streamUrl: `${containerReachableUrl(config.publicUrl, config.mode).replace(/^http/, 'ws')}/runs/${run}/stream`,
    brokerSocket: join(config.workRoot, `${run}.broker.sock`),
  })
}

export { DEFAULT_STAGE_TEMPLATE }
