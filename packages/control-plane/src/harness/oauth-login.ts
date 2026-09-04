import { createHash, randomBytes } from 'node:crypto'
import type { HarnessId } from '@intellidev/shared'

/**
 * Signing in to a harness without running its CLI.
 *
 * The login used to need a container because the *harness CLI* generated the PKCE verifier and
 * kept it — only it could complete the exchange, so only it could finish the flow. Generating the
 * verifier here removes that: the authorization code the person pastes is all we need, and the
 * whole sign-in becomes two HTTP calls from a process that is already running.
 *
 * The parameters below are not invented. Each one was read off a real authorize URL that the
 * pinned CLI itself produced, captured by starting a login task and printing what it printed.
 * Scope in particular could not be guessed: Claude Code asks for six scopes and a token missing
 * `user:inference` would authenticate perfectly and then fail at the first model call.
 *
 * The trade this makes is worth stating. Driving the CLI meant the vendor's own code decided what
 * a sign-in looked like, so a change on their side kept working. Doing it here means we own that
 * breakage — which is why `HarnessLogin` keeps the task path, and why these constants say where
 * they came from.
 */
export interface PkcePair {
  verifier: string
  challenge: string
}

/** RFC 7636 S256. The verifier is the secret; the challenge is what travels in the URL. */
export function pkce(): PkcePair {
  const verifier = randomBytes(32).toString('base64url')
  return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

export interface OAuthFlow {
  /** Where to send the person. */
  authorizeUrl(args: { challenge: string; state: string }): string
  /** Exchange the code they came back with for a credential file. */
  exchange(args: {
    code: string
    verifier: string
    state: string
    fetchImpl?: typeof fetch
  }): Promise<{ path: string; contents: string; expiresAt: Date }>
  /**
   * What the person has to paste, in their own words.
   *
   * Different per harness because the flows end differently: one shows a code on a page, the
   * other fails to load a page whose address contains the code.
   */
  readonly inputHint: string
}

const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_REDIRECT = 'https://platform.claude.com/oauth/code/callback'
/** All six, exactly as the CLI asks for them. `user:inference` is the one that matters most. */
const CLAUDE_SCOPES =
  'org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload'

export const claudeCodeFlow: OAuthFlow = {
  inputHint:
    'Sign in, then paste the code that page shows you. It may look like `abc123#xyz` — paste ' +
    'the whole thing.',

  authorizeUrl({ challenge, state }) {
    const params = new URLSearchParams({
      code: 'true',
      client_id: CLAUDE_CLIENT_ID,
      response_type: 'code',
      redirect_uri: CLAUDE_REDIRECT,
      scope: CLAUDE_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state,
    })
    return `https://claude.com/cai/oauth/authorize?${params.toString()}`
  },

  async exchange({ code, verifier, state, fetchImpl = fetch }) {
    /**
     * The callback page shows `code#state`, not a bare code.
     *
     * Pasting the whole thing is the natural thing to do, and sending it as the code produces an
     * `invalid_grant` that says nothing about a stray suffix. Split here rather than asking the
     * person to edit what they were given.
     */
    const [rawCode, pastedState] = code.trim().split('#')
    const res = await fetchImpl('https://platform.claude.com/v1/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'authorization_code',
        code: rawCode,
        redirect_uri: CLAUDE_REDIRECT,
        client_id: CLAUDE_CLIENT_ID,
        code_verifier: verifier,
        state: pastedState ?? state,
      }),
    })
    if (!res.ok) throw new Error(await describeFailure(res))
    const token = (await res.json()) as {
      access_token: string
      refresh_token: string
      expires_in?: number
      scope?: string
    }

    const expiresAt = new Date(Date.now() + (token.expires_in ?? 8 * 3600) * 1000)
    // The shape Claude Code reads, field for field as it writes it itself.
    const contents = JSON.stringify(
      {
        claudeAiOauth: {
          accessToken: token.access_token,
          refreshToken: token.refresh_token,
          expiresAt: expiresAt.getTime(),
          scopes: token.scope ?? CLAUDE_SCOPES,
        },
      },
      null,
      2,
    )
    return { path: '.claude/.credentials.json', contents, expiresAt }
  },
}

const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
/**
 * Registered with OpenAI and not ours to change.
 *
 * The redirect lands on the person's own machine, where nothing is listening, so the browser
 * shows an error page — with the authorization code in its address bar. That failure is the
 * flow working: we hold the verifier, so the code is all that was missing.
 */
const CODEX_REDIRECT = 'http://localhost:1455/auth/callback'
const CODEX_SCOPES = 'openid profile email offline_access api.connectors.read api.connectors.invoke'
/** How long codex treats a bundle as usable before refreshing it. */
const CODEX_STALE_AFTER_MS = 8 * 24 * 3600 * 1000

export const codexFlow: OAuthFlow = {
  /**
   * Written to pre-empt the alarm rather than explain it afterwards.
   *
   * The last step shows "This site can't be reached", which looks exactly like a broken sign-in
   * and is in fact the sign-in working: the redirect targets a server the codex CLI would run on
   * your machine, and there isn't one. Saying so *before* it happens is the difference between a
   * copy-paste and a support question.
   */
  inputHint:
    "Sign in, then copy that page's address (⌘L, ⌘C) and paste it below. " +
    'It will say "This site can\'t be reached" — that is expected, and the code is in the address.',

  authorizeUrl({ challenge, state }) {
    const params = new URLSearchParams({
      response_type: 'code',
      client_id: CODEX_CLIENT_ID,
      redirect_uri: CODEX_REDIRECT,
      scope: CODEX_SCOPES,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      // Both read off the CLI's own URL. Without them the account claim the credential needs
      // is absent from the id_token.
      id_token_add_organizations: 'true',
      codex_cli_simplified_flow: 'true',
      state,
      originator: 'codex_cli_rs',
    })
    return `https://auth.openai.com/oauth/authorize?${params.toString()}`
  },

  async exchange({ code, verifier, state, fetchImpl = fetch }) {
    // A whole URL is what the person has; the code is a parameter inside it.
    const authorizationCode = extractCode(code, state)
    const res = await fetchImpl('https://auth.openai.com/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'authorization_code',
        code: authorizationCode,
        redirect_uri: CODEX_REDIRECT,
        client_id: CODEX_CLIENT_ID,
        code_verifier: verifier,
      }).toString(),
    })
    if (!res.ok) throw new Error(await describeFailure(res))
    const token = (await res.json()) as {
      access_token: string
      refresh_token: string
      id_token?: string
    }

    /**
     * The account id lives in a namespaced claim inside the id_token.
     *
     * Read rather than assumed: it was found by decoding the id_token of a credential the CLI
     * itself wrote and matching the value against the `account_id` it had stored.
     */
    const accountId = token.id_token ? accountIdFrom(token.id_token) : undefined
    const now = new Date()
    const contents = JSON.stringify(
      {
        OPENAI_API_KEY: null,
        tokens: {
          id_token: token.id_token ?? '',
          access_token: token.access_token,
          refresh_token: token.refresh_token,
          ...(accountId ? { account_id: accountId } : {}),
        },
        last_refresh: now.toISOString().replace('Z', '000Z'),
        auth_mode: 'chatgpt',
      },
      null,
      2,
    )
    return {
      path: '.codex/auth.json',
      contents,
      expiresAt: new Date(now.getTime() + CODEX_STALE_AFTER_MS),
    }
  },
}

export const OAUTH_FLOWS: Partial<Record<HarnessId, OAuthFlow>> = {
  'claude-code': claudeCodeFlow,
  codex: codexFlow,
  // opencode has no scriptable sign-in of any kind; importing its file is the honest path.
}

export function oauthFlowFor(harness: HarnessId): OAuthFlow | undefined {
  return OAUTH_FLOWS[harness]
}

/**
 * Pull the authorization code out of whatever the person pasted.
 *
 * Accepts the whole failed URL, which is what they actually have, and a bare code for anyone who
 * picked it out themselves. The state is checked when both sides carry one: a mismatched state
 * means the paste came from a different sign-in, and exchanging it would bind this seat to
 * whichever account that was.
 */
export function extractCode(pasted: string, expectedState?: string): string {
  const trimmed = pasted.trim()
  if (!/^https?:\/\//.test(trimmed)) return trimmed.split('#')[0]!

  const url = new URL(trimmed)
  const code = url.searchParams.get('code')
  if (!code) throw new Error('that address has no code in it — paste the whole failed page URL')
  const state = url.searchParams.get('state')
  if (expectedState && state && state !== expectedState) {
    throw new Error('that address is from a different sign-in; start again')
  }
  return code
}

function accountIdFrom(idToken: string): string | undefined {
  try {
    const claims = JSON.parse(
      Buffer.from(idToken.split('.')[1]!, 'base64url').toString(),
    ) as Record<string, unknown>
    const auth = claims['https://api.openai.com/auth'] as Record<string, unknown> | undefined
    const id = auth?.['chatgpt_account_id']
    return typeof id === 'string' ? id : undefined
  } catch {
    return undefined
  }
}

/** The body matters: `invalid_grant` on a reused code reads nothing like a 500. */
async function describeFailure(res: Response): Promise<string> {
  const body = await res.text().catch(() => '')
  return `sign-in refused (${res.status}): ${body.slice(0, 200)}`
}
