import { spawn } from 'node:child_process'
import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Signing in to a harness from inside a container the control plane started.
 *
 * The control plane used to spawn these logins itself: `docker run` for Claude Code, the host
 * binary for codex. Neither survives being hosted — its image has no docker and no harness CLIs,
 * and Fargate cannot run a container inside a container. So the login moves to where the CLIs
 * already live, which is the runner image, and the control plane drives it the same way it
 * drives a run: the container dials **out**, and nothing reaches in.
 *
 * The awkward part is codex. It signs in through a callback to `localhost:1455`, and the
 * browser's localhost is not this container's — so the redirect fails in the person's browser
 * with the authorization code sitting in the address bar. Replaying that URL against the
 * callback server *here* completes the exchange, because the server waiting on it is the one
 * that holds the PKCE verifier. `kind: 'callback'` is that replay.
 */
export interface LoginAgentOptions {
  /** Where the control plane is, from inside the container. */
  baseUrl: string
  loginId: string
  /** Bearer for `/internal/logins/*`. Scoped to this login and short-lived. */
  token: string
  /** The CLI to run, already split. */
  argv: readonly string[]
  /** Credential files to collect afterwards, relative to the login's HOME. */
  capture: readonly string[]
  /** Where this CLI's own callback server listens, when it has one. */
  callbackPort?: number
  fetchImpl?: typeof fetch
  /** How often to ask for input. Tighter than a person can type, loose enough to be cheap. */
  pollMs?: number
  /** A login that nobody completes must not hold a container open forever. */
  timeoutMs?: number
}

interface PendingInput {
  kind: 'code' | 'callback' | 'cancel'
  value?: string
}

export async function runLoginAgent(opts: LoginAgentOptions): Promise<number> {
  const fetchImpl = opts.fetchImpl ?? fetch
  const pollMs = opts.pollMs ?? 1000
  const timeoutMs = opts.timeoutMs ?? 10 * 60_000

  const headers = { authorization: `Bearer ${opts.token}`, 'content-type': 'application/json' }
  const url = (path: string) =>
    `${opts.baseUrl.replace(/\/$/, '')}/internal/logins/${opts.loginId}${path}`

  // A HOME of its own, so the captured file is this login's and nothing else's.
  const home = await mkdtemp(join(tmpdir(), 'intellidev-login-'))

  const child = spawn(opts.argv[0]!, opts.argv.slice(1), {
    env: { ...process.env, HOME: home },
    stdio: ['pipe', 'pipe', 'pipe'],
  })

  /**
   * Output is forwarded as it arrives, not at the end.
   *
   * The control plane scrapes the authorization URL out of it, and a person is waiting for that
   * URL — buffering until exit would mean the link appears only once the login has already timed
   * out waiting for them to use it.
   */
  const send = async (path: string, body: unknown): Promise<Response | undefined> => {
    try {
      return await fetchImpl(url(path), { method: 'POST', headers, body: JSON.stringify(body) })
    } catch {
      // A dropped frame is not worth killing a login over; the next one carries the same tail.
      return undefined
    }
  }

  let output = ''
  const forward = (chunk: Buffer) => {
    const text = chunk.toString('utf8')
    output += text
    void send('/output', { chunk: text })
  }
  child.stdout.on('data', forward)
  child.stderr.on('data', forward)

  const exited = new Promise<number>((resolve) => {
    child.on('exit', (code, signal) => resolve(code ?? (signal ? 128 : 1)))
    child.on('error', () => resolve(-2))
  })

  /**
   * Ask for whatever the person supplied, until the CLI exits.
   *
   * Polling rather than a socket because a login lasts a minute and this is one request a
   * second against an endpoint that answers 204 almost every time — a WebSocket would be more
   * machinery for the same result.
   */
  let stop = false
  const pump = (async () => {
    const deadline = Date.now() + timeoutMs
    while (!stop) {
      if (Date.now() > deadline) {
        child.kill('SIGTERM')
        await send('/output', { chunk: '\nintellidev: login timed out waiting for input\n' })
        return
      }
      await new Promise((r) => setTimeout(r, pollMs))
      if (stop) return
      let pending: PendingInput | undefined
      try {
        const res = await fetchImpl(url('/input'), { headers })
        if (res.status === 204) continue
        if (!res.ok) continue
        pending = (await res.json()) as PendingInput
      } catch {
        continue
      }
      if (!pending) continue

      if (pending.kind === 'cancel') {
        child.kill('SIGTERM')
        return
      }
      if (pending.kind === 'code' && pending.value) {
        child.stdin.write(`${pending.value}\n`)
      }
      if (pending.kind === 'callback' && pending.value) {
        /**
         * The person's browser could not reach the callback server; this container can.
         *
         * Only the path and query are taken from what they pasted — the host is this
         * container's own loopback, so a pasted URL cannot become a request to anywhere else.
         */
        try {
          const pasted = new URL(pending.value)
          const target = `http://127.0.0.1:${opts.callbackPort ?? 1455}${pasted.pathname}${pasted.search}`
          const res = await fetchImpl(target)
          await send('/output', {
            chunk: `\nintellidev: replayed the callback locally (${res.status})\n`,
          })
        } catch (error) {
          await send('/output', {
            chunk: `\nintellidev: that did not look like a callback URL (${String(error)})\n`,
          })
        }
      }
    }
  })()

  const exitCode = await exited
  stop = true
  await pump

  /**
   * The credential, read from the throwaway HOME.
   *
   * Missing files are reported rather than omitted: a CLI that exits 0 without writing its
   * credential is a real outcome, and a seat stored empty would look connected and fail at the
   * first model call.
   */
  const files: Array<{ path: string; contents: string }> = []
  const missing: string[] = []
  for (const relative of opts.capture) {
    try {
      files.push({ path: relative, contents: await readFile(join(home, relative), 'utf8') })
    } catch {
      missing.push(relative)
    }
  }

  await send('/complete', { exitCode, files, missing, output: output.slice(-4000) })
  return exitCode
}
