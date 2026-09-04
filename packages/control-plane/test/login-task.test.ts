import { describe, expect, it } from 'vitest'
import { HarnessLogin, type LoginTaskLauncher } from '../src/harness/login.js'
import type { HarnessAccount } from '../src/harness/accounts.js'

/**
 * Harness logins driven as a task, which is the only form that works on a hosted control plane.
 *
 * Its image has no harness CLI and no docker, and Fargate cannot nest containers — so the login
 * runs in the runner image and reports back. These tests drive that conversation without ECS:
 * the launcher is a fake, and the "container" is this test calling the same methods the real one
 * reaches over `/internal/logins/*`.
 */
function harness() {
  const connected: HarnessAccount[] = []
  const started: Array<{ loginId: string; token: string; argv: readonly string[] }> = []
  const stopped: string[] = []

  const launcher: LoginTaskLauncher = {
    async start(spec) {
      started.push({ loginId: spec.loginId, token: spec.token, argv: spec.argv })
    },
    async stop(loginId) {
      stopped.push(loginId)
    },
  }

  const accounts = {
    async connect(_scope: unknown, account: HarnessAccount) {
      connected.push(account)
    },
  } as never

  const login = new HarnessLogin(
    accounts,
    { clientSpaceId: 'space' },
    'intellidev/runner:dev',
    '/tmp',
    launcher,
    // Explicitly the task path: `direct` is the default now, and these tests are about the
    // container one — which is kept as the escape hatch if a vendor changes a flow.
    'task',
  )
  return { login, launcher, connected, started, stopped }
}

const CODEX_URL =
  'https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_x&state=abc'

describe('a login that runs as a task', () => {
  it('waits for the container to report a sign-in link, then offers it', async () => {
    const { login, started } = harness()
    const starting = login.start('codex')
    // The container forwards the CLI's output as it arrives; this is that.
    await new Promise((r) => setTimeout(r, 10))
    login.ingestTaskOutput(
      started[0]!.loginId,
      `Starting local login server on http://localhost:1455.\n${CODEX_URL}\n`,
    )
    const state = await starting

    expect(state.authorizationUrl).toBe(CODEX_URL)
    // Not the callback server it announces first — that is a blank page for the person.
    expect(state.authorizationUrl).not.toContain('localhost:1455')
    /**
     * Nothing to paste back.
     *
     * Codex signs in by device code now: the person types a code into the vendor's own page and
     * the CLI polls until it is approved. The callback flow it replaced ended on "This site
     * can't be reached", which was the flow working and looked like a failure.
     */
    expect(state.needsCode).toBe(false)
  })

  it('sends a pasted URL as a callback to replay, and a pasted code as a code', async () => {
    /**
     * The two shapes a person can be handed. Codex leaves an authorization code in the address
     * bar of a page the browser could not load; Claude prints a code to copy. Telling them apart
     * by shape means nobody has to be asked which kind they have.
     */
    const { login, started } = harness()
    const starting = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    const id = started[0]!.loginId
    login.ingestTaskOutput(id, CODEX_URL)
    await starting

    login.submitCode('http://localhost:1455/auth/callback?code=xyz&state=abc')
    expect(login.takeTaskInput(id)).toEqual({
      kind: 'callback',
      value: 'http://localhost:1455/auth/callback?code=xyz&state=abc',
    })
    // Taken once: the container must not replay the same callback twice.
    expect(login.takeTaskInput(id)).toBeUndefined()

    login.submitCode('ABCD-1234')
    expect(login.takeTaskInput(id)).toEqual({ kind: 'code', value: 'ABCD-1234' })
  })

  it('refuses a bearer that is not this login', async () => {
    const { login, started } = harness()
    const starting = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    const { loginId, token } = started[0]!
    login.ingestTaskOutput(loginId, CODEX_URL)
    await starting

    expect(login.verifyTaskToken(loginId, `Bearer ${token}`)).toBe(true)
    expect(login.verifyTaskToken(loginId, 'Bearer wrong-token-of-same-ish-length')).toBe(false)
    expect(login.verifyTaskToken('another-login', `Bearer ${token}`)).toBe(false)
    expect(login.verifyTaskToken(loginId, undefined)).toBe(false)
  })

  it('stores the credential the task captured', async () => {
    const { login, started, connected } = harness()
    const starting = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    const id = started[0]!.loginId
    login.ingestTaskOutput(id, CODEX_URL)
    await starting

    await login.completeTask(id, {
      exitCode: 0,
      files: [{ path: '.codex/auth.json', contents: '{"tokens":{"access":"x"}}' }],
    })
    expect(connected).toHaveLength(1)
    expect(connected[0]?.harness).toBe('codex')
    expect(login.current()?.status).toBe('connected')
  })

  it('does not store a seat when the task wrote no credential', async () => {
    /**
     * A CLI can exit 0 having written nothing — an abandoned consent screen looks exactly like
     * this. Storing that would show a connected seat that fails at the first model call, which
     * is the failure this whole path exists to stop producing.
     */
    const { login, started, connected } = harness()
    const starting = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    const id = started[0]!.loginId
    login.ingestTaskOutput(id, CODEX_URL)
    await starting

    await login.completeTask(id, { exitCode: 0, files: [], missing: ['.codex/auth.json'] })
    expect(connected).toHaveLength(0)
    expect(login.current()?.status).toBe('failed')
    expect(login.current()?.error).toContain('.codex/auth.json')
  })

  it('stops the task when a login is cancelled', async () => {
    // A task left running holds a sign-in window open and bills until its own timeout.
    const { login, started, stopped } = harness()
    const starting = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    login.ingestTaskOutput(started[0]!.loginId, CODEX_URL)
    await starting

    login.cancel()
    await new Promise((r) => setTimeout(r, 10))
    expect(stopped).toEqual([started[0]!.loginId])
    expect(login.current()?.status).toBe('failed')
  })

  it('ignores a report from a login that has been superseded', async () => {
    // Two logins in a row: the first task may still be exiting when the second starts, and its
    // report must not overwrite the second's state or store the wrong harness's credential.
    const { login, started, connected } = harness()
    const first = login.start('codex')
    await new Promise((r) => setTimeout(r, 10))
    const firstId = started[0]!.loginId
    login.ingestTaskOutput(firstId, CODEX_URL)
    await first

    const second = login.start('claude-code')
    await new Promise((r) => setTimeout(r, 10))
    login.ingestTaskOutput(started[1]!.loginId, 'https://claude.com/cai/oauth/authorize?code=true')
    await second

    await login.completeTask(firstId, {
      exitCode: 0,
      files: [{ path: '.codex/auth.json', contents: '{}' }],
    })
    expect(connected).toHaveLength(0)
    expect(login.current()?.harness).toBe('claude-code')
  })
})
