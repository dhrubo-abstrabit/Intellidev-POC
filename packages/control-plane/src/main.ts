import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildServer } from './server.js'
import { loadAwsConfig } from './aws/config.js'
import { LifecycleReconciler } from './lifecycle/reconciler.js'
import { InMemoryStore, PostgresStore, type ProjectScope, type Store } from './store.js'
import { LocalSecretCipher } from './secrets/cipher.js'
import { KmsSecretCipher } from './secrets/kms-cipher.js'
import { FargateRunner } from './runner/fargate.js'
import { FargateLoginLauncher } from './harness/fargate-login.js'
import { SeatRefresher } from './harness/seat-refresher.js'
import { RefreshSweep } from './harness/refresh-sweep.js'
import { PostgresSeatStore } from './harness/postgres-seats.js'
import { JwtVerifier } from './auth/jwt.js'
import { RunTokenRegistry } from './runs/tokens.js'
import { FileSeatStore } from './harness/accounts.js'
import { FileMcpStore } from './mcp/registry.js'
import type { DispatchMode } from './dispatch.js'

/**
 * Dev entry point.
 *
 * `INTELLIDEV_MODE=docker` runs each task in the golden image, which is the mode that
 * validates the container path. `inline` runs the adapter in this process, which is faster
 * to iterate on. The UI cannot tell them apart, and that is the test.
 */
/** Where AWS calls go. One definition, shared by the runtime config and the KMS client. */
const region = process.env['AWS_REGION'] ?? process.env['AWS_DEFAULT_REGION'] ?? 'ap-south-1'

const port = Number(process.env['PORT'] ?? 4000)
const mode = (process.env['INTELLIDEV_MODE'] ?? 'inline') as DispatchMode
// Resolved against the repo root, not the cwd: `pnpm --filter` runs this from the package
// directory, where a relative `examples/bundle` points at nothing.
const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const workRoot = resolve(process.env['INTELLIDEV_WORK_ROOT'] ?? join(repoRoot, '.intellidev-work'))
const bundleRoot = resolve(process.env['INTELLIDEV_BUNDLE'] ?? join(repoRoot, 'examples/bundle'))

/**
 * Provider credentials to forward into a run.
 *
 * An allowlist rather than the whole environment: a run should not inherit every secret the
 * control plane happens to hold. Named here so which providers work is a fact you can read
 * rather than discover.
 */
const PROVIDER_KEYS = [
  // A long-lived subscription token from `claude setup-token`. Verified against the pinned
  // CLI binary, which reads this name.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
] as const

const harnessEnv = Object.fromEntries(
  PROVIDER_KEYS.flatMap((key) => {
    const value = process.env[key]
    return value ? [[key, value]] : []
  }),
)

/**
 * Model overrides, per harness.
 *
 * Per-harness rather than one global value, because model ids are not interchangeable:
 * opencode wants `provider/model` while Claude Code wants its own names. A single override
 * applied to whichever harness a task happened to pick is a way to silently break the others.
 * `INTELLIDEV_MODEL` stays as a fallback for the common case of using one harness.
 */
const models = Object.fromEntries(
  (['opencode', 'claude-code', 'codex'] as const).flatMap((harness) => {
    const specific = process.env[`INTELLIDEV_MODEL_${harness.toUpperCase().replace(/-/g, '_')}`]
    const value = specific ?? process.env['INTELLIDEV_MODEL']
    return value ? [[harness, value]] : []
  }),
)

await mkdir(workRoot, { recursive: true })

// Under the work root, not the repo: the file holds live OAuth refresh tokens.
// Replaced below once the project scope is known, exactly as seats are.
const fileMcp = await FileMcpStore.open(join(workRoot, 'mcp-servers.json'))
// Replaced below once the project scope is known; seats are space-scoped and Postgres
// needs that, while the file store has only one space to hold.
const fileSeats = await FileSeatStore.open(join(workRoot, 'harness-accounts.json'))

/**
 * Fargate mode resolves every resource name from SSM before the server starts.
 *
 * Eagerly, not on first dispatch: a missing parameter should stop the process with a
 * message naming the path, rather than failing one run halfway through with an SDK error.
 */
const aws =
  mode === 'fargate'
    ? await loadAwsConfig({
        env: process.env['INTELLIDEV_ENV'] ?? 'dev',
        region,
      })
    : undefined

/**
 * Which store this process uses.
 *
 * Postgres when a connection string is configured, in memory otherwise — so a developer
 * with no database still gets a working UI, and nothing has to be remembered to get
 * durability once one exists. The choice is logged, because "my board keeps emptying" and
 * "my board persists" are the same symptom seen from opposite sides.
 *
 * Session-mode pooler only: transaction mode loses `LISTEN`/`NOTIFY` (measured: 0 of 3
 * cross-connection notifications) and cannot hold the migrator's advisory lock.
 */
const databaseUrl = process.env['SUPABASE_CONNECTION_STRING_SESSION']
const store: Store = databaseUrl
  ? new PostgresStore({
      connectionString: databaseUrl,
      // On whenever there is a database. It costs one idle connection and it is the
      // difference between "the UI shows a stalled run" and "the UI is right" the moment a
      // second instance exists — which is not a state anyone remembers to turn a flag on for.
      crossInstanceFanOut: true,
      onDiagnostic: (message) => process.stderr.write(`${message}\n`),
    })
  : new InMemoryStore()

// Opens the LISTEN connection before serving, so the first request cannot race it.
if (store instanceof PostgresStore) await store.start()
// One registry shared by dispatch (which mints) and the event socket (which verifies), so
// there is exactly one place a run's token can be revoked.
/**
 * Run tokens, durable wherever there is a database.
 *
 * The in-memory default is correct for exactly one process. Behind a load balancer a token
 * minted while dispatching on one instance is unverifiable on another, so a container's broker
 * calls fail on about half of them — and which half depends on routing, which is why this had
 * to be fixed before a second instance exists rather than after.
 */
const tokens = new RunTokenRegistry(store instanceof PostgresStore ? { store } : {})

/**
 * Where a run reaches this control plane from outside the process.
 *
 * Set it explicitly for any deployment: a Fargate task cannot reach the host's loopback,
 * so the default is only ever right for the local Docker path, where
 * `containerReachableUrl` rewrites it to host.docker.internal.
 */
const publicUrl = process.env['INTELLIDEV_PUBLIC_URL'] ?? `http://127.0.0.1:${port}`

/**
 * Placeholder tenancy for the in-memory path.
 *
 * Well-formed uuids because both stores share one set of types, and recognisable on sight so a
 * value that leaked into a real database would be obvious rather than plausible.
 */
const DEV_PROJECT_ID = '00000000-0000-0000-0000-0000000000d1'
const DEV_SPACE_ID = '00000000-0000-0000-0000-0000000000d2'
const DEV_WORKSPACE_ID = '00000000-0000-0000-0000-0000000000d3'

/**
 * Which project this process serves.
 *
 * `workspaceId` is looked up rather than configured, because `public.tasks.workspace_id` is NOT
 * NULL and a wrong value would be accepted by the column and rejected by a composite foreign
 * key much later. One query at boot removes the chance of a typo becoming a runtime failure.
 *
 * The in-memory path has no projects table, so it gets the configured ids as-is. That keeps the
 * local loop working without a database, which every task here has had to preserve.
 */
async function resolveScope(): Promise<ProjectScope> {
  const projectId = process.env['INTELLIDEV_PROJECT_ID']
  const clientSpaceId = process.env['INTELLIDEV_CLIENT_SPACE_ID']

  if (!(store instanceof PostgresStore)) {
    // Stable placeholders: nothing joins on them in memory, but they must be well-formed
    // uuids because the Postgres path shares the same types.
    return {
      projectId: projectId ?? DEV_PROJECT_ID,
      clientSpaceId: clientSpaceId ?? DEV_SPACE_ID,
      workspaceId: DEV_WORKSPACE_ID,
    }
  }

  if (!projectId) {
    throw new Error(
      'INTELLIDEV_PROJECT_ID is required when a database is configured. Run `pnpm dev:seed` ' +
        'to create a development project and it will print the ids to set.',
    )
  }

  const found = await store.findProject(projectId)
  if (!found) {
    throw new Error(
      `project ${projectId} does not exist in this database. Run \`pnpm dev:seed\`, or check ` +
        'INTELLIDEV_PROJECT_ID against the project you meant.',
    )
  }
  if (clientSpaceId && clientSpaceId !== found.clientSpaceId) {
    // Both are configured, so disagreement is a copy-paste error worth stopping for rather
    // than silently preferring one.
    throw new Error(
      `INTELLIDEV_CLIENT_SPACE_ID (${clientSpaceId}) is not the space project ${projectId} ` +
        `belongs to (${found.clientSpaceId}).`,
    )
  }
  return found
}

/** The Supabase project tokens are issued by. Absent means no authentication is possible. */
const supabaseUrl = process.env['SUPABASE_URL']

const scope = await resolveScope()

/**
 * Where harness seats live.
 *
 * Postgres wherever there is a database, because a seat in a file is lost on every deploy and
 * invisible to a second instance. The cipher is local here: KMS is for the hosted control plane,
 * whose task role holds the key grant — this process deliberately does not.
 */
/**
 * How credential material is encrypted.
 *
 * KMS wherever a key is configured, which is every deployment; the local cipher only where
 * there is none. That distinction matters: the local one derives its master key from a
 * passphrase in the source, so it protects against a database dump and against nothing else. It
 * is a development convenience, and running a deployment on it would mean the key that guards
 * every stored credential is a string anyone with the repository can read.
 *
 * Both write the same envelope format, so a secret sealed in development can be read in
 * development and one sealed under KMS can be read under KMS — but not across, by design. A
 * ciphertext records which key sealed it, and opening it with the wrong one fails loudly rather
 * than returning something plausible.
 */
const credentialKeyArn = process.env['INTELLIDEV_CREDENTIAL_KEY_ARN']
const cipher = credentialKeyArn
  ? new KmsSecretCipher(credentialKeyArn, { clientConfig: { region } })
  : new LocalSecretCipher(secretPassphrase())

const accounts = store instanceof PostgresStore ? store.seats(cipher) : fileSeats

/**
 * Keeps the harness seat alive, centrally.
 *
 * A run never refreshes its own credential: two runs sharing a seat would both rotate the
 * refresh token and invalidate each other, and Claude Code does not refresh when run headless
 * anyway. Refreshing here means a container is handed a token with more life left than the run
 * has budget, and has no reason to touch it.
 *
 * The advisory lock is only available with a database behind it. Without one there is a single
 * process by definition, and the in-flight promise inside the refresher is the whole guard.
 */
const seatRefresher = new SeatRefresher({
  accounts,
  ...(accounts instanceof PostgresSeatStore ? { lock: accounts.withSeatLock.bind(accounts) } : {}),
  onEvent: (event) => {
    // Quiet about the common case: "still fresh" every three hours across three harnesses is
    // noise that would bury the one line that matters.
    if (event.outcome === 'still-fresh') return
    process.stdout.write(
      `[seat] ${event.harness} ${event.outcome}${event.detail ? ` — ${event.detail}` : ''}\n`,
    )
  },
})

/**
 * Connected MCP servers, project-scoped.
 *
 * Postgres wherever there is a database, for the same reasons as seats: a file is lost on every
 * deploy, invisible to a second instance, and its refresh guard protects only one process.
 */
const mcp = store instanceof PostgresStore ? store.mcp(cipher).for(scope) : fileMcp

/**
 * The passphrase the local cipher derives its master key from.
 *
 * Configurable so a developer's stored seats survive a restart, and so two checkouts do not
 * silently share one. It is a development convenience and offers no protection against anyone
 * who can read the machine, which is exactly why deployments use KMS instead.
 */
function secretPassphrase(): string {
  return process.env['INTELLIDEV_SECRET_PASSPHRASE'] ?? 'intellidev-local-development'
}

/**
 * The repository this deployment is allowed to act on.
 *
 * A task names a repository from the project's allowlist, so a fresh project can dispatch
 * nothing until one is added. Seeding it from configuration keeps the local loop a single
 * command; the UI grows an explicit "add repository" action in a later phase.
 */
const devRepo = process.env['INTELLIDEV_DEV_REPO']
if (devRepo) {
  const [owner, repo] = devRepo.split('/')
  if (!owner || !repo) {
    throw new Error(`INTELLIDEV_DEV_REPO must be "owner/repo", got "${devRepo}"`)
  }
  await store.addProjectRepo(scope, {
    owner,
    repo,
    installationRef: process.env['GITHUB_APP_INSTALLATION_ID'] ?? 'unknown',
  })
}

/**
 * Authentication, when there is a Supabase project to authenticate against.
 *
 * Absent for the in-memory local loop, which has no way to issue a token — and the banner says
 * so, because a server that is open should never be quietly open. Requires a database too: the
 * access check asks the product's own helper functions who may see what, and there is nothing to
 * ask without one.
 */
const auth =
  supabaseUrl && store instanceof PostgresStore
    ? {
        verifier: new JwtVerifier({ projectUrl: supabaseUrl }),
        access: store.projectAccess(),
      }
    : undefined

const app = await buildServer({
  store,
  ...(auth ? { auth } : {}),
  scope,
  tokens,
  dispatch: {
    mode,
    bundleRoot,
    image: process.env['INTELLIDEV_IMAGE'] ?? 'intellidev/runner:dev',
    // The dev default. Every project-scoped resource name derives from this, so a real
    // deployment sets it rather than inheriting a value that would make two projects
    // share one cache prefix.
    projectId: process.env['INTELLIDEV_PROJECT_ID'] ?? 'local',
    publicUrl,
    tokens,
    ...(aws ? { aws } : {}),
    workRoot,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(Object.keys(harnessEnv).length > 0 ? { harnessEnv } : {}),
    ...(process.env['INTELLIDEV_GITHUB_TOKEN']
      ? { githubToken: process.env['INTELLIDEV_GITHUB_TOKEN'] }
      : {}),
    // In docker mode a local bare repo has to be visible inside the container, or git
    // cannot reach an origin that is just a host path.
    ...(process.env['INTELLIDEV_MOUNT_REPO']
      ? {
          extraMounts: [
            {
              source: resolve(process.env['INTELLIDEV_MOUNT_REPO']),
              target: resolve(process.env['INTELLIDEV_MOUNT_REPO']),
            },
          ],
        }
      : {}),
  },
  mcp,
  accounts,
  seatRefresher,
  /**
   * Harness logins run as their own task when this process cannot spawn one.
   *
   * Only in fargate mode, and only with AWS configured — locally, docker and the CLIs are right
   * here and spawning is both simpler and faster. One task per login, torn down afterwards:
   * reusing a container between connections would carry one harness's session into the next.
   */
  ...(mode === 'fargate' && aws
    ? {
        loginLauncher: new FargateLoginLauncher(
          new FargateRunner({ config: aws }),
          publicUrl,
          process.env['INTELLIDEV_IMAGE'] ?? 'intellidev/runner:dev',
        ),
      }
    : {}),
  publicDir: resolve(import.meta.dirname, '..', 'public'),
})

const shutdownTasks: Array<() => void | Promise<void>> = []
function onShutdown(task: () => void | Promise<void>): void {
  shutdownTasks.push(task)
}

/**
 * The lifecycle reconciler, started only where there is something to reconcile.
 *
 * It runs *after* listen so a slow first sweep cannot delay the port opening, and it sweeps
 * immediately on start because a restart is exactly when orphaned runs exist — the
 * in-process observer that was watching them died with the previous process.
 */
/**
 * Keeping seats alive while nothing is running.
 *
 * Refreshing before a dispatch is only enough if dispatches keep happening. A quiet weekend is
 * longer than an access token lives, and long enough to walk a refresh token towards its own
 * expiry — past which no automation helps and a person has to sign in again. The failure is
 * silent until the next dispatch, which is the worst moment to find it.
 *
 * Started after listen, for the same reason the reconciler is: a slow first pass should not
 * delay the port opening. Only where seats are actually stored, since the in-memory loop has
 * nothing to keep alive.
 */
if (store instanceof PostgresStore) {
  const sweep = new RefreshSweep({
    accounts,
    refresher: seatRefresher,
    // One space today: the one this control plane serves. A multi-space deployment would list
    // them from the database here, and the sweep does not otherwise change.
    scopes: () => [{ clientSpaceId: scope.clientSpaceId }],
    onEvent: (event) => {
      if (event.outcome === 'still-fresh') return
      process.stdout.write(`[seat] ${event.harness} ${event.outcome} — ${event.detail ?? ''}\n`)
    },
  })
  sweep.start()
  onShutdown(() => {
    sweep.stop()
  })
}

if (aws) {
  const reconciler = new LifecycleReconciler({
    store,
    clusterName: aws.clusterName,
    queueUrl: aws.taskEventsQueueUrl,
    region: aws.region,
    tokens,
    log: (message) => process.stderr.write(`${message}\n`),
  })
  reconciler.start()
  onShutdown(() => {
    reconciler.stop()
  })
}

/**
 * Shut down in an order that does not strand work.
 *
 * FOUND BY RUNNING IT. The previous version registered `process.once('SIGTERM', …)` to stop the
 * reconciler — which *replaces* Node's default behaviour of exiting. The signal stopped the
 * reconciler and the process ran on for ever, so `kill` appeared to do nothing and the port
 * stayed held. On ECS that is worse than untidy: a task that ignores SIGTERM is killed after the
 * stop timeout, so every deploy waits out the grace period and in-flight runs die hard rather
 * than draining.
 *
 * Order matters. The server closes first so nothing new arrives and in-flight requests finish;
 * the store closes second, since a request still completing needs it; and the exit is
 * unconditional, because a hung close must not turn a restart into a hang.
 */
let shuttingDown = false
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    // A second signal while draining means "stop waiting", which is what an impatient operator
    // and an orchestrator escalating both mean by it.
    if (shuttingDown) process.exit(1)
    shuttingDown = true
    process.stderr.write(`\n  ${signal} — shutting down\n`)

    void (async () => {
      for (const task of shutdownTasks) {
        await Promise.resolve(task()).catch(() => undefined)
      }
      await app.close().catch(() => undefined)
      await store.close().catch(() => undefined)
      process.exit(0)
    })()
  })
}

/**
 * Which interface to listen on.
 *
 * Loopback locally, so a development server is not exposed on the network by accident. A
 * container has to bind `0.0.0.0` or nothing outside it can connect — including the load
 * balancer's health check, which would mark the task unhealthy and cycle it for ever.
 *
 * Configuration rather than a mode check, because "am I in a container" is not something this
 * process can know reliably, and guessing it wrong fails in the direction of exposure.
 */
const host = process.env['INTELLIDEV_BIND_HOST'] ?? '127.0.0.1'

await app.listen({ port, host })

// Read before the banner is built, because listing seats is a database query now. Names only:
// the listing decrypts nothing, which is what keeps a page load off the KMS path.
const connectedSeats = (await accounts.list(scope)).map((seat) => seat.harness)
const connectedServers = (await mcp.list()).length

process.stderr.write(
  [
    ``,
    `  Intellidev control plane`,
    `  → http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}`,
    ``,
    `  mode    ${mode}${mode === 'inline' ? '  (set INTELLIDEV_MODE=docker to run in a container)' : ''}`,
    `  bundle  ${bundleRoot}`,
    `  work    ${workRoot}`,
    `  store   ${databaseUrl ? `postgres (${new URL(databaseUrl).hostname})` : 'in memory — nothing survives a restart'}`,
    `  project ${scope.projectId}`,
    `  space   ${scope.clientSpaceId}`,
    `  repos   ${(await store.listProjectRepos(scope)).map((r) => `${r.owner}/${r.repo}`).join(', ') || 'none allowlisted — tasks cannot be created'}`,
    `  mcp     ${connectedServers} connected server(s)`,
    `  model   ${
      Object.entries(models)
        .map(([h, v]) => `${h}=${v}`)
        .join(' ') || 'harness default'
    }`,
    `  keys    ${Object.keys(harnessEnv).join(', ') || 'none forwarded'}`,
    `  seats   ${connectedSeats.join(', ') || 'no harness connected'}`,
    /**
     * Three states, not two.
     *
     * A gate with no publishable key is the third: the API is correctly closed, and the sign-in
     * page cannot open it, because the browser has nothing to present. It looks healthy from
     * every angle except a person trying to log in — which is how it reached production, working
     * locally the whole time because the key was in `.env`.
     */
    `  auth    ${
      !auth
        ? 'OPEN — no SUPABASE_URL, anyone reaching this port can dispatch'
        : process.env['SUPABASE_ANON_KEY']
          ? `supabase (${new URL(supabaseUrl!).hostname})`
          : `supabase (${new URL(supabaseUrl!).hostname}) — but NO SUPABASE_ANON_KEY, so nobody can sign in`
    }`,
    `  crypto  ${credentialKeyArn ? `kms (${credentialKeyArn.split('/').pop()})` : 'local passphrase — development only'}`,
    ``,
  ].join('\n'),
)
