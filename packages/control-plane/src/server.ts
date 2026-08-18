import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import Fastify, { type FastifyInstance } from 'fastify'
import { HarnessId } from '@intellidev/shared'
import { z } from 'zod'
import { dispatchTask, type DispatchConfig } from './dispatch.js'
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
  /** Absolute path to the directory holding `index.html`. */
  publicDir?: string
}

const McpServerInput = z.object({
  id: z
    .string()
    .min(1)
    // Becomes part of a tool name the model sees and of an env var name, so it is
    // constrained here rather than sanitised in three places later.
    .regex(/^[a-z0-9_]+$/, 'id must be lower-case letters, digits or underscores'),
  name: z.string().min(1),
  url: z.string().url(),
  token: z.string().optional(),
})

const CreateTask = z.object({
  title: z.string().min(1),
  description: z.string().min(1),
  details: z.string().optional(),
  acceptanceCriteria: z.array(z.string()).default([]),
  harness: HarnessId.default('opencode'),
  repoUrl: z.string().min(1),
  baseBranch: z.string().default('main'),
  mcp: McpServerInput.optional(),
})

export async function buildServer(opts: ServerOptions): Promise<FastifyInstance> {
  const store = opts.store ?? new Store()
  const app = Fastify({ logger: false })
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
  }))

  // --- tasks ---------------------------------------------------------------

  /** Tokens are stripped on the way out: the UI never needs one, so it never gets one. */
  const publicTask = (task: TaskRow): TaskRow =>
    task.mcp ? { ...task, mcp: { ...task.mcp, token: undefined } } : task

  app.get('/api/tasks', async () => ({ tasks: store.listTasks().map(publicTask) }))

  app.post('/api/tasks', async (request, reply) => {
    const parsed = CreateTask.safeParse(request.body)
    if (!parsed.success) {
      // The field names are returned so the form can point at the offending input rather
      // than showing a generic failure.
      return reply.code(400).send({ error: 'invalid task', issues: parsed.error.issues })
    }
    return reply.code(201).send({ task: publicTask(store.createTask(parsed.data)) })
  })

  app.get<{ Params: { id: string } }>('/api/tasks/:id', async (request, reply) => {
    const task = store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    return { task: publicTask(task), runs: store.listRuns(task.id) }
  })

  app.post<{ Params: { id: string } }>('/api/tasks/:id/dispatch', async (request, reply) => {
    const task = store.getTask(request.params.id)
    if (!task) return reply.code(404).send({ error: 'no such task' })
    if (task.status !== 'not_started' && task.status !== 'failed') {
      return reply.code(409).send({ error: `task is ${task.status}` })
    }
    const { runId } = await dispatchTask({ store, task, config: opts.dispatch })
    // 202: the run has started, not finished. The UI follows the event stream from here.
    return reply.code(202).send({ runId })
  })

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

export { Store }
