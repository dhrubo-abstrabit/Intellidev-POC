import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { HarnessId, StageTemplate, WELL_KNOWN_STAGE_IDS } from '@intellidev/shared'
import { z } from 'zod'
import {
  ApprovalRefused,
  builtInStageTemplate,
  decideRun,
  dispatchTask,
  DispatchRefused,
  projectRunEvent,
  type DispatchConfig,
} from './dispatch.js'
import {
  HARNESS_AUTH,
  readCredentialFile,
  recipeFor,
  toPublic as accountToPublic,
} from './harness/accounts.js'
import {
  HarnessLogin,
  type LoginMode,
  type LoginTaskLauncher,
  loginSupported,
} from './harness/login.js'
import type { SeatRefresher } from './harness/seat-refresher.js'
import type { SeatStore } from './harness/seat-store.js'
import type { JwtVerifier } from './auth/jwt.js'
import type { ProjectAccessChecker } from './auth/access.js'
import { McpOAuth } from './mcp/oauth.js'
import { ensureSeededStageTemplates, resolveStages } from './stages/resolve.js'
import { MCP_PRESETS } from './mcp/presets.js'
import type { McpStore } from './mcp/store.js'
import { toPublic, type McpAuthKind } from './mcp/types.js'
import { verifyServer } from './mcp/verify.js'
import websocket from '@fastify/websocket'
import { AgentEvent } from '@intellidev/shared'
import {
  InMemoryStore,
  RepoNotAllowed,
  type ProjectScope,
  type Store,
  type TaskRow,
} from './store.js'
import { RunTokenRegistry } from './runs/tokens.js'
import { ControlPlaneCredentialBroker, CredentialRefused } from './runs/credentials.js'
import { AppNotInstalled, gitHubAppFromEnv } from './github/app.js'

/**
 * The control plane, cut to what a UI needs to be useful: create a task, dispatch it, watch
 * it happen.
 *
 * Routes follow `docs/ui-contract.md` so the real UI can point at this unchanged. What is
 * missing is deliberate and listed in the docs: no Postgres, no seats, no approvals, no
 * multi-project.
 */
export interface ServerOptions {
  store?: Store
  /**
   * Who may call the human-facing API.
   *
   * Optional, and its absence is what keeps the local loop working: a developer with no Supabase
   * project has no way to obtain a token, and requiring one would make the in-memory path
   * unusable. When it is absent the server says so in its banner rather than being quietly open.
   */
  auth?: {
    readonly verifier: JwtVerifier
    readonly access: ProjectAccessChecker
  }
  /**
   * Which project this server serves.
   *
   * Configuration for now, resolved once at boot. It becomes per-request when login lands —
   * the shape is already right, because every scoped call takes it as an argument rather than
   * reading it from a field.
   */
  scope: ProjectScope
  /**
   * Per-run bearer tokens. Shared with dispatch, which mints one per run.
   *
   * Passed in rather than created here so the same registry serves the event socket and,
   * from B3, the credential broker — one run token, one place that can revoke it.
   */
  tokens?: RunTokenRegistry
  dispatch: DispatchConfig
  /** The connected-server catalogue. Persisted, unlike tasks. */
  mcp: McpStore
  /** Harness subscription logins. Also persisted, for the same reason. */
  accounts: SeatStore
  /**
   * How to run a harness login when this process cannot spawn one.
   *
   * Absent in development. Present when hosted, where the control plane's own image has no
   * harness CLI and no docker, and Fargate cannot nest containers.
   */
  loginLauncher?: LoginTaskLauncher
  /**
   * Whether to sign in from this process or by driving the harness CLI in a container.
   *
   * Defaults to the direct flow. Switchable because the direct flow's OAuth parameters were read
   * off the CLI rather than documented by the vendor, and a change on their side should be
   * answerable with a setting.
   */
  loginMode?: LoginMode
  /**
   * Keeps the harness seat fresh, so a run is handed a token that outlives it.
   *
   * Passed through to the credential broker. Absent in tests and in the in-memory loop, where
   * there is nothing to refresh and no provider to call.
   */
  seatRefresher?: Pick<SeatRefresher, 'ensureFresh' | 'accept' | 'inspect'>
  /** Absolute path to the directory holding `index.html`. */
  publicDir?: string
}

/**
 * An id becomes part of a tool name the model sees and of an env var name, so it is
 * constrained at the edge rather than sanitised in three places later.
 */
const McpServerId = z
  .string()
  .min(1)
  .regex(/^[a-z0-9_]+$/, 'id must be lower-case letters, digits or underscores')

const UpsertMcpServer = z.object({
  id: McpServerId,
  name: z.string().min(1),
  url: z.string().url(),
  auth: z.enum(['none', 'bearer', 'oauth2']),
  /** Only ever sent for `bearer`; omitted on edit means "keep the token you have". */
  token: z.string().optional(),
  scope: z.string().optional(),
})

const ConnectHarness = z.object({
  harness: HarnessId,
  label: z.string().min(1).optional(),
  /** For env-based harnesses. Never returned by any route. */
  token: z.string().min(1).optional(),
  /** For file-based harnesses; defaults to where that CLI writes its credential. */
  path: z.string().min(1).optional(),
  /**
   * The credential file's contents, sent by the browser.
   *
   * `path` only works when the control plane shares a filesystem with the person using it,
   * which stopped being true the moment it was hosted: reading `~/.codex/auth.json` on a
   * container in another datacentre finds nothing. Uploading the contents is the form that
   * works in both places, so the UI sends this and `path` remains for the CLI.
   */
  contents: z.string().min(1).max(256_000).optional(),
})

const CreateTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  details: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  harness: HarnessId.default('opencode'),
  repoUrl: z.string().min(1),
  baseBranch: z.string().default('main'),
  /** Ids of already-connected servers. Credentials are never sent with a task. */
  mcpServerIds: z.array(McpServerId).default([]),
})

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const store = opts.store ?? new InMemoryStore()
  const tokens = opts.tokens ?? new RunTokenRegistry()
  const app = Fastify({ logger: false })
  /**
   * The space seats belong to.
   *
   * Derived from the server's project scope rather than passed separately: a project always sits
   * in exactly one client space, and two sources for the same fact is how they come to disagree.
   */
  const seatScope = { clientSpaceId: opts.scope.clientSpaceId }

  /**
   * The gate on everything a person calls.
   *
   * Split by prefix rather than by listing routes: `/internal/*` is what a run container talks
   * to and authenticates with its own run token, and `/api/*` is what a browser or the CLI
   * talks to. A prefix cannot be forgotten when a route is added, which a list can.
   *
   * Registered as `onRequest`, so an unauthenticated call is refused before a body is parsed or
   * a handler allocates anything.
   */
  if (opts.auth) {
    const { verifier, access } = opts.auth
    app.addHook('onRequest', async (request, reply) => {
      const url = request.url.split('?')[0] ?? ''
      if (!url.startsWith('/api/')) return

      let user
      try {
        user = await verifier.verify(request.headers.authorization)
      } catch {
        // No detail: which part of the token was wrong helps someone probing and helps a real
        // user not at all, since signing in again is the only remedy either way.
        return reply.code(401).send({ error: 'authentication required' })
      }

      const granted = await access.check(user, opts.scope.projectId)
      if (granted === 'none') {
        // 404 rather than 403. A project someone has no access to should not be confirmed to
        // exist by the shape of the refusal.
        return reply.code(404).send({ error: 'no such project' })
      }

      // Reads are open to anyone with access; anything that changes state or spends compute
      // needs manage. Methods rather than a per-route table, so a new route is safe by default.
      const mutating = request.method !== 'GET' && request.method !== 'HEAD'
      if (mutating && granted !== 'manage') {
        return reply.code(403).send({ error: 'you may view this project but not change it' })
      }

      // Handlers that need to know who is calling read it from here rather than re-verifying.
      ;(request as { user?: typeof user }).user = user
    })
  }

  await app.register(websocket)
  const oauth = new McpOAuth(opts.mcp)
  const login = new HarnessLogin(
    opts.accounts,
    seatScope,
    opts.dispatch.image,
    opts.dispatch.workRoot,
    /**
     * A launcher only where one is needed.
     *
     * With docker and the CLIs to hand — a developer's machine — spawning locally is simpler and
     * faster. Hosted there is neither, so the login runs as a task from the runner image and the
     * container reports back over `/internal/logins/*`.
     */
    opts.loginLauncher,
    opts.loginMode,
  )
  const publicDir =
    opts.publicDir ?? join(dirname(new URL(import.meta.url).pathname), '..', 'public')

  app.get('/', async (_request, reply) => {
    const html = await readFile(join(publicDir, 'index.html'), 'utf8')
    return (
      reply
        .type('text/html; charset=utf-8')
        /**
         * Never cached.
         *
         * The page is read from disk on every request precisely so a change is live without a
         * restart — but with no cache headers a browser is free to keep an old copy for as long
         * as it likes, and it does. Adding the sign-in screen produced exactly that: the code
         * was served, the browser showed the version from before it existed, and the symptom
         * looked like the feature not working.
         *
         * There is nothing to gain from caching here. It is a single small document served to a
         * handful of people, and staleness costs far more than the bytes.
         */
        .header('cache-control', 'no-store, must-revalidate')
        .send(html)
    )
  })

  /**
   * What a load balancer asks before sending traffic.
   *
   * Deliberately outside `/api/*`, so it is not behind the authentication gate: a health check
   * arrives without a token, and gating it would mark every healthy target unhealthy.
   *
   * It checks the database rather than only that the process is alive. An instance that cannot
   * reach Postgres can accept a request and fail it — every dispatch, every task list, every
   * event read — so it should be taken out of the pool rather than left to serve errors. That
   * is the difference between a liveness check and a useful one.
   */
  app.get('/healthz', async (_request, reply) => {
    try {
      await store.listProjectRepos(opts.scope)
    } catch (error) {
      // 503 rather than 500: this instance is unavailable, not broken in a way retrying
      // elsewhere will not fix.
      return reply.code(503).send({
        status: 'unhealthy',
        reason: error instanceof Error ? error.message.slice(0, 200) : 'store unreachable',
      })
    }
    return { status: 'ok' }
  })

  /**
   * What a browser needs *before* it can authenticate.
   *
   * Ungated by necessity: the page cannot fetch its sign-in configuration from a route that
   * requires sign-in. Deliberately outside `/api/*` so that is structural rather than an
   * exception someone has to remember.
   *
   * The anon key is publishable — it identifies the project and grants nothing on its own,
   * which is why Supabase ships it to browsers. Every meaningful permission still comes from a
   * user's own token and the RLS policies behind it. Nothing else is exposed here.
   */
  app.get('/auth-config', async () => ({
    supabaseUrl: process.env['SUPABASE_URL'] ?? null,
    supabaseAnonKey: process.env['SUPABASE_ANON_KEY'] ?? null,
    // So the page can skip the login entirely on a local loop that has no auth configured.
    required: Boolean(opts.auth),
  }))

  app.get('/api/config', async () => ({
    mode: opts.dispatch.mode,
    image: opts.dispatch.image,
    harnesses: HarnessId.options,
    hasGithubToken: Boolean(opts.dispatch.githubToken),
    /**
     * Which harnesses have a credential, so the UI can say so before a run is spent.
     * `env` counts a key forwarded from the control plane's own environment, since that
     * authenticates a run just as well as a connected account.
     */
    harnessAuth: Object.fromEntries(
      await Promise.all(
        HarnessId.options.map(async (harness) => {
          const recipe = recipeFor(harness)
          const viaEnv = Boolean(recipe?.envVar && opts.dispatch.harnessEnv?.[recipe.envVar])
          return [harness, (await opts.accounts.has(seatScope, harness)) || viaEnv] as const
        }),
      ),
    ),
  }))

  // --- harness accounts ----------------------------------------------------

  app.get('/api/harness/recipes', async () => ({
    recipes: HARNESS_AUTH.map((recipe) => ({
      ...recipe,
      // Whether "Sign in" can drive this harness's own login, or whether the file it writes
      // has to be imported instead.
      canSignIn: loginSupported(recipe.harness),
    })),
  }))

  /**
   * Start a sign-in by running the harness's own login inside the image.
   *
   * Returns as soon as the CLI prints its link, so the UI can open a window promptly. The rest
   * of the flow is watched through the status route: a login is a human at a browser, and how
   * long that takes is not ours to predict.
   */
  app.post<{ Params: { harness: string } }>(
    '/api/harness/login/:harness/start',
    async (request, reply) => {
      const harness = HarnessId.safeParse(request.params.harness)
      if (!harness.success) return reply.code(400).send({ error: 'not a harness' })
      try {
        return { login: await login.start(harness.data) }
      } catch (error) {
        return reply
          .code(400)
          .send({ error: error instanceof Error ? error.message : String(error) })
      }
    },
  )

  app.post('/api/harness/login/code', async (request, reply) => {
    const parsed = z.object({ code: z.string().min(1) }).safeParse(request.body)
    if (!parsed.success) return reply.code(400).send({ error: 'a code is required' })
    try {
      login.submitCode(parsed.data.code)
      return { login: login.current() }
    } catch (error) {
      return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.get('/api/harness/login/status', async () => ({ login: login.current() ?? null }))

  app.post('/api/harness/login/cancel', async () => {
    login.cancel()
    return { ok: true }
  })

  app.get('/api/harness/accounts', async () => ({
    // Already public: names and paths, never a value, and no decryption on a path that runs
    // on every page load.
    accounts: await opts.accounts.list(seatScope),
  }))

  /**
   * Connect a harness by importing what its own login produced.
   *
   * `token` for the env-based harnesses, `path` for the file-based ones — defaulting to where
   * that CLI writes it, so the common case is a button rather than a filesystem hunt.
   */
  app.post('/api/harness/accounts', async (request, reply) => {
    const parsed = ConnectHarness.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid account', issues: parsed.error.issues })
    }
    const { harness, token, path } = parsed.data
    const recipe = recipeFor(harness)
    if (!recipe) return reply.code(400).send({ error: `no auth recipe for ${harness}` })

    try {
      if (recipe.kind === 'env') {
        if (!token) return reply.code(400).send({ error: `${harness} needs a token` })
        const account = {
          harness,
          label: parsed.data.label ?? harness,
          env: { [recipe.envVar!]: token },
          connectedAt: new Date().toISOString(),
          importedFrom: recipe.command,
        }
        await opts.accounts.connect(seatScope, account)
        return reply.code(201).send({ account: accountToPublic(account) })
      }

      /**
       * Contents when the browser sent them, the filesystem otherwise.
       *
       * Parsed either way rather than trusted: a truncated or wrong-file upload is a real
       * mistake, and it is far cheaper to reject it here than to store it, show the seat as
       * connected, and have a run fail at its first model call.
       */
      const from = path ?? recipe.hostPath!
      const contents = parsed.data.contents ?? (await readCredentialFile(from))
      try {
        JSON.parse(contents)
      } catch {
        return reply
          .code(400)
          .send({ error: `that does not look like ${harness}'s credential file (not valid JSON)` })
      }
      const account = {
        harness,
        label: parsed.data.label ?? harness,
        files: [{ path: recipe.homePath!, contents }],
        connectedAt: new Date().toISOString(),
        importedFrom: from,
      }
      await opts.accounts.connect(seatScope, account)
      return reply.code(201).send({ account: accountToPublic(account) })
    } catch (error) {
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.delete<{ Params: { harness: string } }>(
    '/api/harness/accounts/:harness',
    async (request, reply) => {
      const harness = HarnessId.safeParse(request.params.harness)
      if (!harness.success) return reply.code(400).send({ error: 'not a harness' })
      const removed = await opts.accounts.remove(seatScope, harness.data)
      if (!removed) return reply.code(404).send({ error: 'not connected' })
      return { ok: true }
    },
  )

  /**
   * The GitHub App, if this deployment has one.
   *
   * Declared here rather than beside the credential broker that also uses it, because the
   * repository routes below reference it and a `const` used before its declaration is a
   * temporal dead zone — it typechecks and then throws at runtime, which has already happened
   * twice in this codebase.
   *
   * Configured from the environment, so a deployment gains the App by setting two variables
   * rather than by a code change. Absent locally, where a PAT is enough.
   */
  const githubApp = gitHubAppFromEnv()

  // --- repositories --------------------------------------------------------
  //
  // Which repositories this project may act on. The GitHub App is installed at *space* level and
  // can cover a whole organisation, so being able to reach a repository says nothing about
  // whether this project should. That gap is what this list closes, and why `task_specs.repo_id`
  // is a foreign key into it rather than free text.

  // --- stage templates -----------------------------------------------------

  /**
   * The templates this project can run, both scopes at once.
   *
   * `resolved` comes back alongside because the list alone does not answer the question people
   * actually have — "what will a new task run?" — and working it out from four nullable fields
   * in a UI would reimplement resolution in a second place, where it would drift.
   */
  app.get('/api/stage-templates', async () => {
    /**
     * Seeded on first look, so the screen opens on something real.
     *
     * Showing the built-in stages without a row behind them would mean the first edit has
     * nothing to edit — and "these are your stages, but you cannot change them yet" is the
     * confusion the whole feature exists to remove.
     *
     * The repository is only used to decide whether a `pr` stage makes sense, and the first
     * allowed repo is the honest answer at this point: no task has been chosen yet.
     */
    const repos = await store.listProjectRepos(opts.scope)
    const firstRepo = repos[0]
    await ensureSeededStageTemplates({
      store,
      scope: opts.scope,
      seed: builtInStageTemplate(
        firstRepo ? `https://github.com/${firstRepo.owner}/${firstRepo.repo}.git` : 'file:///local',
      ),
    }).catch(() => undefined)

    const templates = await store.listStageTemplates(opts.scope)
    const resolved = await resolveStages({
      store,
      scope: opts.scope,
      builtIn: builtInStageTemplate('https://github.com/placeholder/placeholder.git'),
    })
    return {
      templates,
      /** What a new task picks up today, and which level decided it. */
      effective: { source: resolved.source, name: resolved.template.name, stages: resolved.template.stages },
      /** The stage ids the UI offers first. Not a constraint — any slug is valid. */
      wellKnown: WELL_KNOWN_STAGE_IDS,
    }
  })

  app.post('/api/stage-templates', async (request, reply) => {
    const body = (request.body ?? {}) as {
      id?: string
      name?: string
      description?: string
      stages?: unknown
      isDefault?: boolean
      scope?: 'project' | 'space'
    }
    if (!body.name?.trim()) return reply.code(400).send({ error: 'a template needs a name' })

    /**
     * Parsed before it is stored, not when it is run.
     *
     * A template saved broken would be accepted here and fail at dispatch — or worse, at stage
     * one inside a container. The same schema the engine uses is the one that guards the write.
     */
    let stages
    try {
      stages = StageTemplate.parse({ name: body.name, stages: body.stages }).stages
    } catch (error) {
      return reply.code(400).send({
        error: 'those stages would not run',
        detail: error instanceof Error ? error.message : String(error),
      })
    }

    // Space scope is the deliberate choice, so a project cannot change what every other project
    // in the space inherits by accident.
    const projectId = body.scope === 'space' ? undefined : opts.scope.projectId

    const saved = await store.saveStageTemplate({
      ...(body.id ? { id: body.id } : {}),
      clientSpaceId: opts.scope.clientSpaceId,
      ...(projectId ? { projectId } : {}),
      name: body.name.trim(),
      ...(body.description ? { description: body.description } : {}),
      stages,
      isDefault: body.isDefault ?? false,
    })
    return reply.code(201).send({ template: saved })
  })

  app.delete<{ Params: { id: string } }>('/api/stage-templates/:id', async (request, reply) => {
    const existing = await store.getStageTemplate(request.params.id)
    /**
     * Checked before deleting, because dispatch runs as the service role and RLS does not
     * constrain it. Without this, an id from another space would be deleted by anyone who could
     * guess it.
     */
    if (!existing || existing.clientSpaceId !== opts.scope.clientSpaceId) {
      return reply.code(404).send({ error: 'no such template' })
    }
    if (existing.projectId && existing.projectId !== opts.scope.projectId) {
      return reply.code(404).send({ error: 'no such template' })
    }
    return { deleted: await store.deleteStageTemplate(request.params.id) }
  })

  app.get('/api/repos', async () => ({ repos: await store.listProjectRepos(opts.scope) }))

  /**
   * Repositories the App could be pointed at, for a picker.
   *
   * Answered from the installation rather than from anything stored, so it reflects what a
   * person actually granted — including a repository added to the installation a minute ago.
   */
  app.get('/api/repos/available', async (_request, reply) => {
    if (!githubApp) return reply.code(400).send({ error: 'no GitHub App is configured' })
    const known = await store.listProjectRepos(opts.scope)
    const anchor = known[0]
    if (!anchor) {
      // Listing needs an installation to ask, and an installation is found from a repository.
      // With none added yet there is nothing to anchor on, which is a state the UI should
      // handle by asking for the first repository by name.
      return { repos: [], reason: 'add one repository by name first' }
    }
    const available = await githubApp.listRepositories(anchor.owner, anchor.repo)
    const already = new Set(known.map((r) => `${r.owner}/${r.repo}`))
    return { repos: available.filter((r) => !already.has(`${r.owner}/${r.repo}`)) }
  })

  /**
   * Adds a repository, after confirming the App can actually reach it.
   *
   * Verified here rather than trusted, because the alternative is discovering it thirty seconds
   * into a run: a repository the App is not installed on produces a 403 from git inside a
   * container, which reaches a person as a failed run rather than as a form error naming the
   * fix.
   */
  app.post('/api/repos', async (request, reply) => {
    const parsed = z
      .object({ owner: z.string().min(1), repo: z.string().min(1) })
      .safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'owner and repo are required' })
    }
    if (!githubApp) return reply.code(400).send({ error: 'no GitHub App is configured' })

    const { owner, repo } = parsed.data
    try {
      const found = await githubApp.describeRepository(owner, repo)
      const added = await store.addProjectRepo(opts.scope, {
        owner,
        repo,
        // The installation GitHub resolved, not one configured by hand: an id typed into an
        // environment variable is an id that goes stale when someone reinstalls the App.
        installationRef: String(found.installationId),
        defaultBranch: found.defaultBranch,
      })
      return reply.code(201).send({ repo: added })
    } catch (error) {
      if (error instanceof AppNotInstalled) {
        // Carries the install link, which is the whole remedy.
        return reply.code(400).send({ error: error.message })
      }
      return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) })
    }
  })

  app.delete<{ Params: { owner: string; repo: string } }>(
    '/api/repos/:owner/:repo',
    async (request, reply) => {
      const removed = await store.removeProjectRepo(
        opts.scope,
        request.params.owner,
        request.params.repo,
      )
      if (!removed) return reply.code(404).send({ error: 'not on this project' })
      return { ok: true }
    },
  )

  // --- tasks ---------------------------------------------------------------

  app.get('/api/tasks', async () => ({ tasks: await store.listTasks(opts.scope) }))

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTask.safeParse(request.body)
    if (!parsed.success) {
      // The field names are returned so the form can point at the offending input rather
      // than showing a generic failure.
      return reply.code(400).send({ error: 'invalid task', issues: parsed.error.issues })
    }
    // Referencing a server that was never connected would fail thirty minutes in, at the
    // first tool call, so it is refused here instead.
    // Resolved in parallel: a task may name several servers, and one round trip each
    // would be paid on every task creation.
    const known = await Promise.all(
      parsed.data.mcpServerIds.map(async (id) => [id, await opts.mcp.get(id)] as const),
    )
    const unknown = known.filter(([, server]) => !server).map(([id]) => id)
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `not a connected MCP server: ${unknown.join(', ')}` })
    }
    try {
      return reply.code(201).send({ task: await store.createTask(parsed.data, opts.scope) })
    } catch (error) {
      // A repository outside the project's allowlist is a 400 the form can render, not a
      // fault: the App may well be able to reach it, which is a different question from
      // whether this project may act on it.
      if (error instanceof RepoNotAllowed) {
        return reply.code(400).send({ error: error.message })
      }
      throw error
    }
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = await store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    return { task, runs: await store.listRuns(task.id) }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/dispatch', async (request, reply) => {
    const task = await store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    if (task.status !== 'not_started' && task.status !== 'failed') {
      return reply.code(409).send({ error: `task is ${task.status}` })
    }
    let runId: string
    try {
      ;({ runId } = await dispatchTask({
        store,
        task,
        config: opts.dispatch,
        mcp: { registry: opts.mcp, oauth },
        accounts: opts.accounts,
      }))
    } catch (error) {
      // A refusal means nothing was created, so it is a 400 on the form rather than a run
      // that appears on the board only to fail. The task stays dispatchable.
      if (error instanceof DispatchRefused) {
        return reply.code(400).send({ error: error.message })
      }
      throw error
    }
    // 202: the run has started, not finished. The UI follows the event stream from here.
    return reply.code(202).send({ runId })
  })

  // --- mcp servers ---------------------------------------------------------

  app.get('/api/mcp/presets', async () => ({ presets: MCP_PRESETS }))

  app.get('/api/mcp/servers', async () => ({ servers: (await opts.mcp.list()).map(toPublic) }))

  app.post('/api/mcp/servers', async (request, reply) => {
    const parsed = UpsertMcpServer.safeParse(request.body)
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid server', issues: parsed.error.issues })
    }
    const { scope, ...rest } = parsed.data
    const saved = await opts.mcp.upsert({
      ...rest,
      health: 'unknown',
      // Carried on the oauth record because that is where the flow reads it from; a bearer
      // server has no use for it.
      ...(rest.auth === 'oauth2' && scope
        ? { oauth: { authorizationServerUrl: '', clientId: '', scope } }
        : {}),
    })
    return reply.code(201).send({ server: toPublic(saved) })
  })

  app.delete<{ Params: { id: string } }>('/api/mcp/servers/:id', async (request, reply) => {
    const removed = await opts.mcp.remove(request.params.id)
    if (!removed) return reply.code(404).send({ error: 'no such server' })
    return { ok: true }
  })

  /**
   * Start connecting.
   *
   * For OAuth this returns a URL for the browser to open; for anything else there is nothing
   * interactive to do, so it verifies immediately. One endpoint either way, so the UI has a
   * single "Connect" button rather than two that mean different things.
   */
  app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/connect', async (request, reply) => {
    const server = await opts.mcp.get(request.params.id)
    if (!server) return reply.code(404).send({ error: 'no such server' })

    if (server.auth !== 'oauth2') {
      const result = await verifyServer(server, await oauth.accessToken(server))
      const saved = await opts.mcp.patch(server.id, {
        health: result.health,
        ...(result.tools ? { tools: result.tools, toolCount: result.tools.length } : {}),
        verifiedAt: new Date().toISOString(),
        lastError: result.error,
      })
      return { kind: 'verified', server: toPublic(saved) }
    }

    try {
      const redirectUri = callbackUrl(request.headers.host, opts.dispatch.publicUrl)
      const { authorizationUrl } = await oauth.begin(server, redirectUri)
      return { kind: 'oauth', authorizationUrl }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await opts.mcp.patch(server.id, { health: 'error', lastError: message })
      return reply.code(502).send({ error: message })
    }
  })

  app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/verify', async (request, reply) => {
    const server = await opts.mcp.get(request.params.id)
    if (!server) return reply.code(404).send({ error: 'no such server' })
    const result = await verifyServer(server, await oauth.accessToken(server))
    const saved = await opts.mcp.patch(server.id, {
      health: result.health,
      ...(result.tools ? { tools: result.tools, toolCount: result.tools.length } : {}),
      verifiedAt: new Date().toISOString(),
      lastError: result.error,
    })
    return { server: toPublic(saved) }
  })

  /**
   * The OAuth redirect target.
   *
   * Returns a small page that tells the opener it is done and closes itself, so the UI can
   * refresh without polling. It is plain HTML rather than a redirect back into the app
   * because the popup is a separate window and has no state worth preserving.
   */
  app.get<{ Querystring: { code?: string; state?: string; error?: string } }>(
    '/oauth/callback',
    async (request, reply) => {
      const { code, state, error } = request.query
      let message: string
      let ok = false

      if (error) {
        message = `Authorization was refused: ${error}`
      } else if (!code || !state) {
        message = 'The authorization server did not return a code.'
      } else {
        try {
          const server = await oauth.complete(state, code)
          // Verify straight away, so "connected" in the UI means tools were actually listed.
          const result = await verifyServer(server, await oauth.accessToken(server))
          await opts.mcp.patch(server.id, {
            health: result.health,
            ...(result.tools ? { tools: result.tools, toolCount: result.tools.length } : {}),
            verifiedAt: new Date().toISOString(),
            lastError: result.error,
          })
          ok = result.health === 'ok'
          message = ok
            ? `Connected ${server.name} — ${result.tools?.length ?? 0} tools available.`
            : `Authorized ${server.name}, but listing tools failed: ${result.error ?? 'unknown'}`
        } catch (failure) {
          message = failure instanceof Error ? failure.message : String(failure)
        }
      }

      return reply.type('text/html; charset=utf-8').send(callbackPage(message, ok))
    },
  )

  // --- runs ----------------------------------------------------------------

  /**
   * Decide a run that is waiting for approval.
   *
   * Approving resumes it in a fresh container, from the stage after the one that parked.
   * Rejecting settles it as cancelled — a different fact from "it never happened", and the only
   * one that is true.
   *
   * Under `/api`, so it carries a person's own token rather than a run's: this is the one
   * decision in the system that must come from a human, and the run token is held by the very
   * container the decision is about.
   */
  app.post<{ Params: { id: string } }>('/api/runs/:id/decision', async (request, reply) => {
    const body = (request.body ?? {}) as { decision?: unknown }
    if (body.decision !== 'approved' && body.decision !== 'rejected') {
      return reply.code(400).send({ error: 'decision must be "approved" or "rejected"' })
    }

    try {
      const outcome = await decideRun({
        store,
        runId: request.params.id,
        decision: body.decision,
        config: opts.dispatch,
        mcp: { registry: opts.mcp, oauth },
        accounts: opts.accounts,
      })
      return outcome
    } catch (error) {
      if (error instanceof ApprovalRefused) {
        // 409, not 400: the request is well formed and the run is simply not in a state where
        // this means anything — approving twice being the obvious way to arrive here.
        return reply.code(409).send({ error: error.message })
      }
      throw error
    }
  })

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = await store.getRun(request.params.id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    return { run }
  })

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      if (!(await store.getRun(request.params.id)))
        return reply.code(404).send({ error: 'no such run' })
      const since = Number(request.query.since ?? -1)
      return {
        events: await store.eventsSince(request.params.id, Number.isNaN(since) ? -1 : since),
      }
    },
  )

  /**
   * SSE. Backfills from `since` before subscribing, so a client that reconnects gets a
   * gapless stream — the guarantee `docs/ui-contract.md` makes to the UI.
   */
  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/runs/:id/stream',
    async (request, reply) => {
      const runId = request.params.id
      if (!(await store.getRun(runId))) return reply.code(404).send({ error: 'no such run' })

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Without this, a proxy can hold the whole stream until the run ends.
        'x-accel-buffering': 'no',
      })

      const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      const requested = Number(request.query.since ?? -1)
      const since = Number.isNaN(requested) ? -1 : requested

      /**
       * Backfill and live delivery are one subscription, not two steps.
       *
       * Reading `eventsSince` and then subscribing had two defects: an event landing between
       * the read and the registration was missed, and once cross-instance fan-out existed
       * the subscription re-delivered from the start — which put 0,1,2,3,4,0,1,2,3,4 on the
       * wire in a live two-instance test. Passing `since` gives the subscription one
       * watermark covering both.
       */
      const unsubscribe = store.subscribe(runId, send, { since })
      // Comment frames keep intermediaries from closing an idle stream during a long stage.
      const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000)

      request.raw.on('close', () => {
        clearInterval(keepAlive)
        unsubscribe()
      })
      return reply
    },
  )

  /**
   * The credential broker.
   *
   * Four endpoints, all authenticated by the run's own bearer and all scoped to the run that
   * bearer resolves to. The run id is never read from the request body — taking it from
   * there is exactly how one run ends up holding another's credentials.
   *
   * This is what lets a container hold nothing but its run token: B3's whole point.
   */
  const broker = new ControlPlaneCredentialBroker({
    store,
    tokens,
    accounts: opts.accounts,
    // So a run is handed a token with more life left than it has budget, and never has cause to
    // refresh one itself — which is what makes two runs on one seat safe.
    ...(opts.seatRefresher ? { seatRefresher: opts.seatRefresher } : {}),
    mcpToken: async (serverId) => {
      const server = await opts.mcp.get(serverId)
      if (!server) return undefined
      // Refreshed here because this is the only place that can: the container is headless
      // and deliberately holds no refresh token. Reuses the same `oauth` the routes use, so
      // there is one refresh path and D1's single-flight guard covers all of it.
      return (await oauth.accessToken(server)) ?? undefined
    },
    ...(githubApp ? { githubApp } : {}),
    ...(opts.dispatch.githubToken ? { githubToken: opts.dispatch.githubToken } : {}),
    onGrant: (grant) => {
      // Recorded, because a credential handed out with no trace is indistinguishable from
      // one that leaked. The detail is a host, a harness or a server id — never a secret.
      process.stderr.write(
        `[broker] ${grant.granted ? 'granted' : 'refused'} ${grant.kind} ` +
          `(${grant.detail}) to ${grant.runId}${grant.reason ? ` — ${grant.reason}` : ''}\n`,
      )
    },
  })

  /** Shared shape for the four broker routes, so authentication cannot be forgotten. */
  const brokered = <T>(handler: (runId: string, body: Record<string, unknown>) => Promise<T>) => {
    return async (
      request: { headers: Record<string, unknown>; body?: unknown },
      reply: { code(status: number): { send(payload: unknown): unknown } },
    ) => {
      try {
        const runId = await broker.authenticate(String(request.headers['authorization'] ?? ''))
        const body = (request.body ?? {}) as Record<string, unknown>
        return await handler(runId, body)
      } catch (error) {
        if (error instanceof CredentialRefused) {
          return reply.code(error.status).send({ error: error.message })
        }
        // Anything else is ours, not the run's; do not leak the internals to a container.
        process.stderr.write(`[broker] internal error: ${String(error)}\n`)
        return reply.code(500).send({ error: 'credential broker failed' })
      }
    }
  }

  app.post(
    '/internal/creds/git',
    brokered((runId, body) => broker.git(runId, String(body['host'] ?? ''))),
  )
  app.post(
    '/internal/creds/seat',
    brokered((runId, body) => broker.seat(runId, String(body['harness'] ?? ''))),
  )
  /**
   * The stage engine's own state, read and written by the run that owns it.
   *
   * This is what lets a run park for approval and cost nothing while it waits: the container
   * writes its cursor here and exits, and the container that resumes reads it back. Keeping it
   * inside the container instead would mean either losing it on exit or holding the container
   * open for however long a decision takes.
   *
   * Authenticated as every other `/internal` route is — by the run's own bearer, resolved to a
   * run id. The id in the path is checked against it rather than trusted, so a run cannot read
   * or overwrite another run's progress.
   */
  app.get<{ Params: { id: string } }>('/internal/runs/:id/state', async (request, reply) => {
    let runId: string
    try {
      runId = await broker.authenticate(String(request.headers['authorization'] ?? ''))
    } catch (error) {
      const status = error instanceof CredentialRefused ? error.status : 500
      return reply.code(status).send({ error: 'not this run' })
    }
    if (runId !== request.params.id) return reply.code(403).send({ error: 'not this run' })

    const run = await store.getRun(runId)
    // 404 rather than a null body: a run's first load is always a miss, and the store treats
    // that as "start clean" — an empty 200 would be indistinguishable from a corrupted save.
    if (!run?.engineState) return reply.code(404).send({ error: 'no state yet' })
    return { state: run.engineState }
  })

  app.put<{ Params: { id: string } }>('/internal/runs/:id/state', async (request, reply) => {
    let runId: string
    try {
      runId = await broker.authenticate(String(request.headers['authorization'] ?? ''))
    } catch (error) {
      const status = error instanceof CredentialRefused ? error.status : 500
      return reply.code(status).send({ error: 'not this run' })
    }
    if (runId !== request.params.id) return reply.code(403).send({ error: 'not this run' })

    const state = (request.body as { state?: unknown } | undefined)?.state
    // An object, not merely truthy: storing a string or an array here would be accepted by JSONB
    // and fail much later, when a resumed run tried to read a cursor off it.
    if (!state || typeof state !== 'object' || Array.isArray(state)) {
      return reply.code(400).send({ error: 'state must be an object' })
    }

    await store.updateRun(runId, { engineState: state as Record<string, unknown> })
    return reply.code(204).send()
  })

  /**
   * A credential a run's harness rotated for itself, handed back.
   *
   * Refreshing centrally removes the *reason* a harness would rotate, not its ability — codex
   * refreshes reactively on a 401. Without this the container would finish holding a working
   * token while the stored one is dead, which is the state the claude-code seat was found in.
   */
  app.post(
    '/internal/creds/seat-rotation',
    brokered((runId, body) =>
      broker.reportSeat(
        runId,
        String(body['harness'] ?? ''),
        (body['files'] ?? []) as Array<{ path: string; contents: string }>,
      ),
    ),
  )
  app.post(
    '/internal/creds/mcp',
    brokered((runId, body) => broker.mcp(runId, String(body['serverId'] ?? ''))),
  )
  app.post(
    '/internal/creds/secrets',
    brokered((runId, body) => broker.secrets(runId, body['stage'] as never)),
  )

  /**
   * A login task reporting in.
   *
   * Authenticated by a bearer minted for that one login, not by a user's token: the container
   * has no user. The three routes are deliberately narrow — forward output, ask for input,
   * report the result — and each is refused unless the bearer matches the login in flight, so a
   * finished or superseded login cannot be written to.
   */
  const loginBearer = (request: {
    headers: Record<string, unknown>
    params: unknown
  }): string | undefined => {
    const id = (request.params as { id?: string }).id
    if (!id) return undefined
    const authorization = request.headers['authorization']
    return login.verifyTaskToken(id, typeof authorization === 'string' ? authorization : undefined)
      ? id
      : undefined
  }

  app.post<{ Params: { id: string } }>('/internal/logins/:id/output', async (request, reply) => {
    const id = loginBearer(request as never)
    if (!id) return reply.code(401).send({ error: 'not this login' })
    const chunk = (request.body as { chunk?: unknown })?.chunk
    if (typeof chunk === 'string') login.ingestTaskOutput(id, chunk)
    return reply.code(204).send()
  })

  app.get<{ Params: { id: string } }>('/internal/logins/:id/input', async (request, reply) => {
    const id = loginBearer(request as never)
    if (!id) return reply.code(401).send({ error: 'not this login' })
    const pending = login.takeTaskInput(id)
    // 204 is the common answer by far: the container asks once a second while a person reads a
    // consent screen, and an empty body is cheaper than a JSON null.
    return pending ? reply.send(pending) : reply.code(204).send()
  })

  app.post<{ Params: { id: string } }>('/internal/logins/:id/complete', async (request, reply) => {
    const id = loginBearer(request as never)
    if (!id) return reply.code(401).send({ error: 'not this login' })
    const body = (request.body ?? {}) as {
      exitCode?: number
      files?: Array<{ path: string; contents: string }>
      missing?: string[]
      output?: string
    }
    await login.completeTask(id, {
      exitCode: Number(body.exitCode ?? 1),
      files: body.files ?? [],
      ...(body.missing ? { missing: body.missing } : {}),
      ...(body.output ? { output: body.output } : {}),
    })
    return reply.code(204).send()
  })

  /**
   * Where a run's events arrive.
   *
   * The adapter dials **out** to this, which is what makes the runtime a swap: nothing
   * reaches into a running container, so Docker and Fargate need no different treatment and
   * no inbound rule exists for a compromised run to abuse.
   *
   * Every frame is acknowledged by `seq`, and that ack is the contract: it means the event
   * is durably stored and the run may stop holding it. Acknowledging before the append
   * would turn a control-plane crash into a permanent hole in the log — which is the one
   * thing the sequence numbers exist to prevent.
   */
  app.get<{ Params: { id: string }; Querystring: { token?: string } }>(
    '/internal/runs/:id/events',
    { websocket: true },
    // Async because verifying a run token is now a database read: tokens are durable, so an
    // instance that did not mint one can still verify it.
    async (connection, request) => {
      const socket = connection as unknown as {
        send(data: string): void
        close(code?: number, reason?: string): void
        on(event: string, listener: (...args: never[]) => void): void
      }

      // Authorise against the token's *own* run, never the id in the path. Trusting the
      // path would let a valid token for run A write events into run B.
      const authorisedRunId = await tokens.verify(request.query.token ?? '')
      if (!authorisedRunId) {
        socket.close(4401, 'invalid or expired run token')
        return
      }
      if (authorisedRunId !== request.params.id) {
        socket.close(4403, 'token does not belong to this run')
        return
      }

      socket.on('message', (raw: never) => {
        // The handler body is async because the store is; the listener itself cannot be,
        // so the promise is launched here and every failure path is handled inside.
        void handleFrame(raw)
      })

      const handleFrame = async (raw: never): Promise<void> => {
        let frame: { type?: string; event?: unknown }
        try {
          frame = JSON.parse(String(raw)) as { type?: string; event?: unknown }
        } catch {
          // Unparseable frames are dropped rather than fatal: killing the socket would make
          // the run replay everything, which is a worse outcome than losing one bad frame.
          return
        }
        if (frame.type !== 'event') return

        const parsed = AgentEvent.safeParse(frame.event)
        if (!parsed.success) return
        // The event's own runId is authoritative and must match the authorised run.
        if (parsed.data.runId !== authorisedRunId) return

        // `appendEvent` already drops duplicate and out-of-order seqs, which is what makes
        // a replay idempotent — the adapter re-sends on every reconnect by design.
        try {
          // Awaited before the ack. Acking first would let the adapter drop an event that a
          // control-plane crash then lost — a permanent hole, which is the one thing the
          // sequence numbers exist to prevent.
          await store.appendEvent(parsed.data)
          /**
           * The same projection the inline path applies.
           *
           * Without it a Fargate run finished with no stage records and a null pr_url, because
           * that projection lived in dispatch's sink — which is fed by tailing an events file
           * that container runs do not have. The run worked; everything anyone would look at
           * afterwards was missing.
           *
           * After the append and before the ack, so a projection failure leaves the event
           * unacknowledged and the adapter replays it, rather than acking a half-recorded event.
           */
          const run = await store.getRun(authorisedRunId)
          if (run) await projectRunEvent(store, run.id, run.taskId, parsed.data)
        } catch {
          // Not acked, so the adapter keeps holding it and replays on the next reconnect.
          // Silence here is deliberate: the run must not be told a transient write failure
          // means its event was rejected.
          return
        }
        socket.send(JSON.stringify({ type: 'ack', seq: parsed.data.seq }))
      }
    },
  )

  return app
}

/**
 * Where the authorization server should send the human back.
 *
 * FOUND BY CONNECTING SUPABASE ON THE DEPLOYED PLANE. The scheme was hardcoded to `http`, which
 * is correct only for loopback: RFC 8252 lets a native client use plain HTTP on localhost, and
 * every other redirect must be https. Registration was refused with `redirect_uris.0: URL must
 * use https, be localhost, or use a custom scheme` — a message that never reached the panel,
 * because a schema check ran first and complained about the shape of the error instead.
 *
 * The configured public URL is preferred over the Host header because it is the one address the
 * deployment guarantees is reachable and correctly schemed. Behind a load balancer the request
 * itself arrives as plain HTTP, so trusting the connection's scheme would reproduce this bug.
 *
 * The header remains the fallback for a developer who has not set one: it keeps the port the
 * control plane actually started on, and a client registered against an exact redirect URI would
 * otherwise break on `PORT=4001`.
 */
export function callbackUrl(host: string | undefined, publicUrl: string | undefined): string {
  if (publicUrl) {
    try {
      return new URL('/oauth/callback', publicUrl).toString()
    } catch {
      // A malformed value should not stop a local sign-in; fall through to the header.
    }
  }
  return `http://${host ?? '127.0.0.1:4000'}/oauth/callback`
}

function callbackPage(message: string, ok: boolean): string {
  return `<!doctype html><meta charset="utf-8"><title>${ok ? 'Connected' : 'Connection failed'}</title>
<style>
  body { font: 15px/1.5 -apple-system, system-ui, sans-serif; margin: 0; display: grid;
         place-items: center; height: 100vh; background: #ffffff; color: #11150f; }
  .card { max-width: 34rem; padding: 28px 32px; border: 1px solid #e3e6df; border-radius: 14px; }
  h1 { font-size: 15px; margin: 0 0 8px; color: ${ok ? '#12915a' : '#b4231f'}; }
  p { margin: 0; color: #55605a; }
</style>
<div class="card">
  <h1>${ok ? 'Connected' : 'Connection failed'}</h1>
  <p>${escapeHtml(message)}</p>
  <p style="margin-top:10px">This window closes on its own.</p>
</div>
<script>
  try { window.opener && window.opener.postMessage({ type: 'intellidev:mcp-connected' }, '*') } catch {}
  setTimeout(() => window.close(), ${ok ? 1200 : 6000})
</script>`
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch] as string,
  )
}

export type { Store }
