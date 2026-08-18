import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { HarnessId } from '@intellidev/shared'
import { z } from 'zod'
import { dispatchTask, type DispatchConfig } from './dispatch.js'
import {
  HARNESS_AUTH,
  readCredentialFile,
  recipeFor,
  toPublic as accountToPublic,
  type HarnessAccounts,
} from './harness/accounts.js'
import { HarnessLogin, loginSupported } from './harness/login.js'
import { McpOAuth } from './mcp/oauth.js'
import { MCP_PRESETS } from './mcp/presets.js'
import type { McpRegistry } from './mcp/registry.js'
import { toPublic, type McpAuthKind } from './mcp/types.js'
import { verifyServer } from './mcp/verify.js'
import { Store, type TaskRow } from './store.js'

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
  dispatch: DispatchConfig
  /** The connected-server catalogue. Persisted, unlike tasks. */
  mcp: McpRegistry
  /** Harness subscription logins. Also persisted, for the same reason. */
  accounts: HarnessAccounts
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
  const store = opts.store ?? new Store()
  const app = Fastify({ logger: false })
  const oauth = new McpOAuth(opts.mcp)
  const login = new HarnessLogin(opts.accounts, opts.dispatch.image, opts.dispatch.workRoot)
  const publicDir =
    opts.publicDir ?? join(dirname(new URL(import.meta.url).pathname), '..', 'public')

  app.get('/', async (_request, reply) => {
    const html = await readFile(join(publicDir, 'index.html'), 'utf8')
    return reply.type('text/html; charset=utf-8').send(html)
  })

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
      HarnessId.options.map((harness) => {
        const recipe = recipeFor(harness)
        const viaEnv = Boolean(recipe?.envVar && opts.dispatch.harnessEnv?.[recipe.envVar])
        return [harness, Boolean(opts.accounts.get(harness)) || viaEnv]
      }),
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
    accounts: opts.accounts.list().map(accountToPublic),
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
        const account = await opts.accounts.connect({
          harness,
          label: parsed.data.label ?? harness,
          env: { [recipe.envVar!]: token },
          connectedAt: new Date().toISOString(),
          importedFrom: recipe.command,
        })
        return reply.code(201).send({ account: accountToPublic(account) })
      }

      const from = path ?? recipe.hostPath!
      const contents = await readCredentialFile(from)
      const account = await opts.accounts.connect({
        harness,
        label: parsed.data.label ?? harness,
        files: [{ path: recipe.homePath!, contents }],
        connectedAt: new Date().toISOString(),
        importedFrom: from,
      })
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
      const removed = await opts.accounts.remove(harness.data)
      if (!removed) return reply.code(404).send({ error: 'not connected' })
      return { ok: true }
    },
  )

  // --- tasks ---------------------------------------------------------------

  app.get('/api/tasks', async () => ({ tasks: store.listTasks() }))

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTask.safeParse(request.body)
    if (!parsed.success) {
      // The field names are returned so the form can point at the offending input rather
      // than showing a generic failure.
      return reply.code(400).send({ error: 'invalid task', issues: parsed.error.issues })
    }
    // Referencing a server that was never connected would fail thirty minutes in, at the
    // first tool call, so it is refused here instead.
    const unknown = parsed.data.mcpServerIds.filter((id) => !opts.mcp.get(id))
    if (unknown.length > 0) {
      return reply.code(400).send({ error: `not a connected MCP server: ${unknown.join(', ')}` })
    }
    return reply.code(201).send({ task: store.createTask(parsed.data) })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    return { task, runs: store.listRuns(task.id) }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/dispatch', async (request, reply) => {
    const task = store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    if (task.status !== 'not_started' && task.status !== 'failed') {
      return reply.code(409).send({ error: `task is ${task.status}` })
    }
    const { runId } = await dispatchTask({
      store,
      task,
      config: opts.dispatch,
      mcp: { registry: opts.mcp, oauth },
      accounts: opts.accounts,
    })
    // 202: the run has started, not finished. The UI follows the event stream from here.
    return reply.code(202).send({ runId })
  })

  // --- mcp servers ---------------------------------------------------------

  app.get('/api/mcp/presets', async () => ({ presets: MCP_PRESETS }))

  app.get('/api/mcp/servers', async () => ({ servers: opts.mcp.list().map(toPublic) }))

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
    const server = opts.mcp.get(request.params.id)
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
      const redirectUri = callbackUrl(request.headers.host)
      const { authorizationUrl } = await oauth.begin(server, redirectUri)
      return { kind: 'oauth', authorizationUrl }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      await opts.mcp.patch(server.id, { health: 'error', lastError: message })
      return reply.code(502).send({ error: message })
    }
  })

  app.post<{ Params: { id: string } }>('/api/mcp/servers/:id/verify', async (request, reply) => {
    const server = opts.mcp.get(request.params.id)
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

  app.get<{ Params: { id: string } }>('/api/runs/:id', async (request, reply) => {
    const run = store.getRun(request.params.id)
    if (!run) return reply.code(404).send({ error: 'no such run' })
    return { run }
  })

  app.get<{ Params: { id: string }; Querystring: { since?: string } }>(
    '/api/runs/:id/events',
    async (request, reply) => {
      if (!store.getRun(request.params.id)) return reply.code(404).send({ error: 'no such run' })
      const since = Number(request.query.since ?? -1)
      return { events: store.eventsSince(request.params.id, Number.isNaN(since) ? -1 : since) }
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
      if (!store.getRun(runId)) return reply.code(404).send({ error: 'no such run' })

      reply.raw.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        // Without this, a proxy can hold the whole stream until the run ends.
        'x-accel-buffering': 'no',
      })

      const send = (event: unknown) => reply.raw.write(`data: ${JSON.stringify(event)}\n\n`)
      const since = Number(request.query.since ?? -1)
      for (const event of store.eventsSince(runId, Number.isNaN(since) ? -1 : since)) send(event)

      const unsubscribe = store.subscribe(runId, send)
      // Comment frames keep intermediaries from closing an idle stream during a long stage.
      const keepAlive = setInterval(() => reply.raw.write(': keep-alive\n\n'), 15_000)

      request.raw.on('close', () => {
        clearInterval(keepAlive)
        unsubscribe()
      })
      return reply
    },
  )

  return app
}

/**
 * Where the authorization server should send the human back.
 *
 * Built from the request's own Host header so it matches whatever port the control plane was
 * actually started on — an OAuth client is registered against an exact redirect URI, and a
 * hardcoded 4000 would silently break `PORT=4001`.
 */
function callbackUrl(host: string | undefined): string {
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

export { Store }
