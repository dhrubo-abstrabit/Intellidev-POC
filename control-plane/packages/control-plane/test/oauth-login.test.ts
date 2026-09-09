import { describe, expect, it } from 'vitest'
import {
  claudeCodeFlow,
  codexFlow,
  extractCode,
  oauthFlowFor,
  pkce,
} from '../src/harness/oauth-login.js'
import { HarnessLogin } from '../src/harness/login.js'
import type { HarnessAccount } from '../src/harness/accounts.js'

/**
 * Signing in without running a harness CLI.
 *
 * The parameters asserted here were read off real authorize URLs the pinned CLIs produced, not
 * guessed — which is the only reason this flow can be trusted at all. The tests pin them so a
 * careless edit is caught here rather than by a token that authenticates and then cannot infer.
 */
describe('the authorize URL we build ourselves', () => {
  it('asks for every scope Claude Code asks for', () => {
    /**
     * The one that matters is `user:inference`. A token missing it signs in perfectly, stores
     * perfectly, and fails at the first model call with an error about permissions — a full
     * container spent to discover a missing word in a URL.
     */
    const url = new URL(claudeCodeFlow.authorizeUrl({ challenge: 'c', state: 's' }))
    const scopes = (url.searchParams.get('scope') ?? '').split(' ')
    expect(scopes).toContain('user:inference')
    expect(scopes).toContain('user:sessions:claude_code')
    expect(scopes).toContain('user:profile')
    expect(scopes).toContain('user:mcp_servers')
    expect(scopes).toContain('user:file_upload')
    expect(url.searchParams.get('code_challenge_method')).toBe('S256')
    expect(url.searchParams.get('redirect_uri')).toBe(
      'https://platform.claude.com/oauth/code/callback',
    )
  })

  it('keeps the two codex parameters that are easy to mistake for noise', () => {
    // `id_token_add_organizations` is what puts the account claim in the id_token, and the
    // credential file needs the account id out of it.
    const url = new URL(codexFlow.authorizeUrl({ challenge: 'c', state: 's' }))
    expect(url.searchParams.get('id_token_add_organizations')).toBe('true')
    expect(url.searchParams.get('codex_cli_simplified_flow')).toBe('true')
    expect(url.searchParams.get('scope')).toContain('offline_access')
    // Without offline_access there is no refresh token, and the seat would die in hours with
    // nothing able to renew it.
  })

  it('produces a fresh challenge each time, derived from the verifier', () => {
    const a = pkce()
    const b = pkce()
    expect(a.verifier).not.toBe(b.verifier)
    expect(a.challenge).not.toBe(b.challenge)
    // S256 of 32 random bytes, base64url: no padding, url-safe.
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
})

describe('reading what the person pasted', () => {
  it('takes the code out of the failed localhost URL', () => {
    // What codex users actually have: a page that would not load.
    expect(extractCode('http://localhost:1455/auth/callback?code=abc123&state=xyz', 'xyz')).toBe(
      'abc123',
    )
  })

  it('accepts a bare code too', () => {
    expect(extractCode('abc123')).toBe('abc123')
  })

  it('drops the state suffix Claude shows after the code', () => {
    // The callback page shows `code#state`, and pasting the whole thing is the natural act.
    expect(extractCode('abc123#somestate')).toBe('abc123')
  })

  it('refuses a paste from a different sign-in', () => {
    // Exchanging it would bind this seat to whichever account that sign-in belonged to.
    expect(() =>
      extractCode('http://localhost:1455/auth/callback?code=abc&state=other', 'expected'),
    ).toThrow(/different sign-in/)
  })

  it('says what is wrong when the address has no code', () => {
    expect(() => extractCode('http://localhost:1455/auth/callback?error=access_denied')).toThrow(
      /no code in it/,
    )
  })
})

describe('exchanging the code', () => {
  it('writes the file Claude Code actually reads', async () => {
    const fetchImpl = (async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body) as Record<string, string>
      // The verifier is what proves this is the same client that started the flow.
      expect(body['grant_type']).toBe('authorization_code')
      expect(body['code_verifier']).toBe('the-verifier')
      expect(body['code']).toBe('abc123')
      return Response.json({
        access_token: 'access-1',
        refresh_token: 'refresh-1',
        expires_in: 28800,
      })
    }) as never

    const result = await claudeCodeFlow.exchange({
      code: 'abc123#state',
      verifier: 'the-verifier',
      state: 'state',
      fetchImpl,
    })

    expect(result.path).toBe('.claude/.credentials.json')
    const parsed = JSON.parse(result.contents) as {
      claudeAiOauth: { accessToken: string; refreshToken: string; expiresAt: number }
    }
    expect(parsed.claudeAiOauth.accessToken).toBe('access-1')
    expect(parsed.claudeAiOauth.refreshToken).toBe('refresh-1')
    // Milliseconds since the epoch, which is the shape the CLI writes and our refresher reads.
    expect(parsed.claudeAiOauth.expiresAt).toBeGreaterThan(Date.now() + 7 * 3600 * 1000)
  })

  it('carries the codex account id out of the id_token', async () => {
    // Found by decoding a credential the CLI itself wrote and matching the value it had stored.
    const claims = Buffer.from(
      JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: 'acct-42' } }),
    ).toString('base64url')
    const fetchImpl = (async () =>
      Response.json({
        access_token: 'a',
        refresh_token: 'r',
        id_token: `header.${claims}.sig`,
      })) as never

    const result = await codexFlow.exchange({
      code: 'http://localhost:1455/auth/callback?code=abc&state=s',
      verifier: 'v',
      state: 's',
      fetchImpl,
    })

    const parsed = JSON.parse(result.contents) as {
      tokens: { account_id?: string }
      auth_mode: string
      last_refresh: string
    }
    expect(parsed.tokens.account_id).toBe('acct-42')
    expect(parsed.auth_mode).toBe('chatgpt')
    // The field codex judges staleness by; absent, it would refresh on every single run.
    expect(Date.parse(parsed.last_refresh)).toBeGreaterThan(0)
  })

  it('reports what the provider said when it refuses', async () => {
    // `invalid_grant` on a reused code reads nothing like a 500, and the difference is what a
    // person needs to know.
    const fetchImpl = (async () =>
      new Response('{"error":"invalid_grant"}', { status: 400 })) as never
    await expect(
      claudeCodeFlow.exchange({ code: 'x', verifier: 'v', state: 's', fetchImpl }),
    ).rejects.toThrow(/invalid_grant/)
  })
})

describe('choosing a sign-in path', () => {
  function login(mode: 'direct' | 'task') {
    const connected: HarnessAccount[] = []
    const accounts = {
      async connect(_scope: unknown, account: HarnessAccount) {
        connected.push(account)
      },
    } as never
    const started: string[] = []
    const launcher = {
      async start(spec: { loginId: string }) {
        started.push(spec.loginId)
      },
      async stop() {},
    }
    return {
      connected,
      started,
      login: new HarnessLogin(
        accounts,
        { clientSpaceId: 'space' },
        'intellidev/runner:dev',
        '/tmp',
        launcher,
        mode,
      ),
    }
  }

  it('signs in directly by default, with no container and no waiting', async () => {
    const { login: direct } = login('direct')
    const state = await direct.start('claude-code')
    // Returned immediately with a URL, because it is built rather than scraped from a subprocess.
    expect(state.status).toBe('awaiting_code')
    expect(state.authorizationUrl).toContain('claude.com/cai/oauth/authorize')
    expect(state.inputHint).toBeTruthy()
  })

  it('still drives the CLI when told to', async () => {
    /**
     * The escape hatch: a vendor changing a flow we drive ourselves should be a setting, not a
     * deploy of reverted code.
     *
     * Not awaited — the task path waits for a container to report a URL, and this test is about
     * which path was taken, not about the conversation that follows it.
     */
    const { login: task, started } = login('task')
    void task.start('claude-code')
    await new Promise((r) => setTimeout(r, 10))

    expect(started).toHaveLength(1)
    // And no URL was invented locally: the container's own output is what supplies it.
    expect(task.current()?.authorizationUrl).toBeUndefined()
    task.cancel()
  })

  it('drives codex through its own CLI, not through our OAuth', async () => {
    /**
     * Codex has a direct flow and deliberately does not use it. That flow ends on "This site
     * can't be reached" — correct behaviour, read as a failure every time — while its device
     * flow has no redirect at all, and only the CLI can perform that one because it holds the
     * device code and polls.
     *
     * The CLI is in the control-plane image now, so this is a subprocess rather than a container:
     * the same flow, about a second instead of thirty.
     */
    const { login: direct } = login('direct')
    const state = await direct.start('codex')
    // Not our authorize URL: the CLI produces its own, and it is a device page.
    expect(state.authorizationUrl ?? '').not.toContain('auth.openai.com/oauth/authorize')
    direct.cancel()
  })

  it('has a flow for both harnesses that can be driven, and none for opencode', () => {
    expect(oauthFlowFor('claude-code')).toBeDefined()
    expect(oauthFlowFor('codex')).toBeDefined()
    // opencode's sign-in is an interactive provider picker; importing its file is the honest path.
    expect(oauthFlowFor('opencode')).toBeUndefined()
  })
})
