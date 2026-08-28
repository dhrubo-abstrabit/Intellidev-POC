#!/usr/bin/env node
/**
 * Drives the control plane from the shell, the way the UI will from the other repo.
 *
 * The UI lives elsewhere, so there is otherwise no client for this API — and testing by
 * inserting rows straight into the database would skip the parts most likely to be wrong: the
 * repository allowlist, the status machine, dispatch's refusals, and soon the JWT check. This
 * goes through HTTP for exactly that reason.
 *
 * Signs in with Supabase when credentials are available and sends the token, even though the
 * API does not require one yet. That way the day gating lands, this client already works and
 * the failure surfaces here rather than in someone else's repo.
 *
 *   pnpm task list
 *   pnpm task create "Add a hello function" --repo owner/name [--branch main]
 *   pnpm task dispatch <taskId>
 *   pnpm task watch <runId>
 *   pnpm task run "Add a hello function" --repo owner/name    # create, dispatch, watch
 */
import { readFileSync } from 'node:fs'

function fromEnvOrDotEnv(key: string): string | undefined {
  const direct = process.env[key]
  if (direct) return direct
  try {
    return readFileSync(new URL('../../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.trim().startsWith(`${key}=`))
      ?.split('=')
      .slice(1)
      .join('=')
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}

const BASE = process.env['INTELLIDEV_API'] ?? `http://127.0.0.1:${process.env['PORT'] ?? 4000}`

/**
 * A Supabase access token, if this environment can get one.
 *
 * Optional on purpose. The API is not gated yet, and a hard requirement would make the CLI
 * unusable for the in-memory local loop that has no Supabase project at all.
 */
async function accessToken(): Promise<string | undefined> {
  const url = fromEnvOrDotEnv('SUPABASE_URL')
  const anon = fromEnvOrDotEnv('SUPABASE_ANON_KEY')
  const email = fromEnvOrDotEnv('INTELLIDEV_DEV_EMAIL')
  const password = fromEnvOrDotEnv('INTELLIDEV_DEV_PASSWORD')
  if (!url || !anon || !email || !password) return undefined

  const res = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: 'POST',
    headers: { apikey: anon, 'content-type': 'application/json' },
    body: JSON.stringify({ email, password }),
  })
  if (!res.ok) {
    // A warning rather than a failure: the token is not required yet, and a wrong password
    // should not stop someone testing dispatch.
    process.stderr.write(`  ! sign-in failed (${res.status}); continuing without a token\n`)
    return undefined
  }
  return ((await res.json()) as { access_token: string }).access_token
}

const token = await accessToken()

async function api(path: string, init: RequestInit = {}): Promise<unknown> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: {
      // Only when there is a body. Fastify rejects a request that declares JSON and sends
      // nothing — which is every POST here that carries no payload, like dispatch.
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...init.headers,
    },
  })
  const text = await res.text()
  let body: Record<string, unknown> = {}
  try {
    body = text ? (JSON.parse(text) as Record<string, unknown>) : {}
  } catch {
    // A non-JSON body is still worth showing; swallowing it leaves a bare status code.
  }
  if (!res.ok) {
    // `message` before `error`, because Fastify sets `error` to the generic status text
    // ("Bad Request") and puts the useful sentence in `message`.
    const reason = body['message'] ?? body['error'] ?? text
    throw new Error(`${res.status} ${String(reason || res.statusText).slice(0, 400)}`)
  }
  return body
}

/** `--flag value` pairs, so ordering in the argument list does not matter. */
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}

interface Task {
  id: string
  title: string
  status: string
  repoUrl: string
  baseBranch: string
}

async function create(title: string): Promise<Task> {
  const repo = flag('repo')
  if (!repo || !repo.includes('/')) {
    throw new Error("--repo owner/name is required, and must be on the project's allowlist")
  }
  const body = {
    title,
    description: flag('description') ?? title,
    acceptanceCriteria: [flag('criteria') ?? 'the change is implemented and a test covers it'],
    harness: flag('harness') ?? 'claude-code',
    repoUrl: `https://github.com/${repo}.git`,
    baseBranch: flag('branch') ?? 'main',
    mcpServerIds: (flag('mcp') ?? '').split(',').filter(Boolean),
  }
  const { task } = (await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify(body),
  })) as { task: Task }
  console.log(`  created  ${task.id}  ${task.title}`)
  return task
}

async function dispatch(taskId: string): Promise<string> {
  const { runId } = (await api(`/api/tasks/${taskId}/dispatch`, { method: 'POST' })) as {
    runId: string
  }
  console.log(`  dispatched  run ${runId}`)
  return runId
}

/**
 * Follows a run's event stream until it ends.
 *
 * Reads the SSE endpoint by hand rather than with a library: the framing is two lines, and the
 * useful part is `since`, which is what makes a reconnect gapless. Printing the seq alongside
 * each event makes a gap visible instead of merely absent.
 */
async function watch(runId: string): Promise<void> {
  let since = -1
  for (;;) {
    const res = await fetch(`${BASE}/api/runs/${runId}/stream?since=${since}`, {
      headers: token ? { authorization: `Bearer ${token}` } : {},
    })
    if (!res.ok || !res.body) {
      throw new Error(`stream failed: ${res.status}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let ended = false

    while (!ended) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      // SSE frames are separated by a blank line; anything else is a partial frame.
      const frames = buffer.split('\n\n')
      buffer = frames.pop() ?? ''
      for (const frame of frames) {
        const line = frame.split('\n').find((l) => l.startsWith('data: '))
        if (!line) continue
        const event = JSON.parse(line.slice(6)) as {
          seq: number
          type: string
          stage?: string
          [k: string]: unknown
        }
        since = Math.max(since, event.seq)
        console.log(
          `  ${String(event.seq).padStart(3)}  ${event.type.padEnd(18)}` +
            `${(event.stage ?? '').padEnd(10)}${summarise(event)}`,
        )
        if (event.type === 'run.finished' || event.type === 'run.failed') ended = true
      }
    }

    if (ended) return
    // The stream closed without a terminal event, which is what a dropped connection looks
    // like. Reconnecting from `since` is exactly what the UI does, so exercise the same path.
    console.log(`  … stream closed, reconnecting from seq ${since}`)
  }
}

/** The one field worth showing per event type, rather than the whole body. */
function summarise(event: Record<string, unknown>): string {
  for (const key of ['message', 'outcome', 'prUrl', 'reason', 'branch', 'status']) {
    const value = event[key]
    if (typeof value === 'string' && value) return value.slice(0, 90)
  }
  return ''
}

/**
 * Positional arguments, with `--flag value` pairs removed.
 *
 * Filtering only on the `--` prefix was not enough: it dropped the flag names and left their
 * *values* in the positionals, so `--repo x --description "y"` ended up appended to the title.
 */
const positionals: string[] = []
{
  const argv = process.argv.slice(2)
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith('--')) {
      i++ // skip this flag's value
      continue
    }
    positionals.push(arg)
  }
}
const [command, ...rest] = positionals

try {
  switch (command) {
    case 'list': {
      const { tasks } = (await api('/api/tasks')) as { tasks: Task[] }
      if (tasks.length === 0) console.log('  no tasks')
      for (const t of tasks) {
        console.log(`  ${t.id}  ${t.status.padEnd(16)}${t.title}`)
      }
      break
    }
    case 'create':
      await create(rest.join(' '))
      break
    case 'dispatch':
      if (!rest[0]) throw new Error('usage: pnpm task dispatch <taskId>')
      await dispatch(rest[0])
      break
    case 'watch':
      if (!rest[0]) throw new Error('usage: pnpm task watch <runId>')
      await watch(rest[0])
      break
    case 'run': {
      const task = await create(rest.join(' '))
      const runId = await dispatch(task.id)
      await watch(runId)
      break
    }
    default:
      console.log(
        [
          '',
          '  pnpm task list',
          '  pnpm task create "<title>" --repo owner/name [--branch main] [--harness claude-code]',
          '  pnpm task dispatch <taskId>',
          '  pnpm task watch <runId>',
          '  pnpm task run "<title>" --repo owner/name      create, dispatch and follow',
          '',
          `  API      ${BASE}`,
          `  token    ${token ? 'signed in' : 'none (set INTELLIDEV_DEV_EMAIL and _PASSWORD)'}`,
          '',
        ].join('\n'),
      )
  }
} catch (error) {
  console.error(`\n  ${error instanceof Error ? error.message : String(error)}\n`)
  process.exit(1)
}
