import { RUN_WALL_CLOCK_SEC, type HarnessId } from '@intellidev/shared'

/**
 * Keeping a harness seat alive.
 *
 * A seat is one subscription login shared by every run in a client space, and until now nothing
 * kept it fresh. Three separate problems, all of which we hit:
 *
 *  - **The stored token goes stale and nobody notices.** Claude Code's access token lasts about
 *    eight hours; the stored one had been expired for a day while its refresh token was still
 *    good for another twenty-seven. Every run failed with "OAuth session expired and could not
 *    be refreshed" for want of one HTTP call.
 *  - **Claude Code will not refresh itself when run headless.** It refreshes in an interactive
 *    session and silently does not as a non-TTY subprocess, which is exactly how a run invokes
 *    it (anthropics/claude-code#53063, #50743, #42904). Waiting for the harness to do it is
 *    waiting for something that never happens.
 *  - **Refreshing rotates the refresh token.** Two containers handed the same credential both
 *    refresh, both rotate, and the loser's token — along with the copy in the database — is
 *    dead. OpenAI's own CI guidance is blunt about the same hazard: "Do not share the same
 *    auth.json across concurrent jobs or multiple machines."
 *
 * So refreshing belongs here, once, under a lock, and never in a run container. A container is
 * handed a token that is already fresh enough to outlive the run, and has no reason to refresh
 * anything.
 */

/**
 * The refresh token is gone for good, and only a person can fix it.
 *
 * Distinguished from every other failure because the response is different: a 500 or a timeout
 * is worth retrying in three hours, and this is not. `invalid_grant` means the token was already
 * redeemed — by another instance that rotated it, or by someone signing in again elsewhere,
 * which invalidates the previous family. Retrying that on a timer is a guaranteed-useless
 * request every few hours until somebody notices the seat is dead.
 *
 * FOUND BY RUNNING IT against the real provider: the stored Claude Code token came back
 * `invalid_grant — Refresh token not found or invalid`, and without this it would have been
 * reported as an ordinary failure and retried indefinitely.
 */
export class RefreshTokenRejected extends Error {}

/** A refresh token exchanged for a new bundle. */
export interface RefreshedSeat {
  /** The credential file to store, already in the harness's own format. */
  contents: string
  /** When the new access token expires. */
  expiresAt: Date
}

/** What a harness's credential file says about its own freshness. */
export interface SeatExpiry {
  /** When the access token expires, if the file says. */
  accessExpiresAt?: Date
  /**
   * When the ability to refresh is lost — a refresh token's own expiry, or the point at which a
   * harness treats its bundle as stale. Past this, only a human can reconnect.
   */
  refreshExpiresAt?: Date
}

export interface HarnessRefresher {
  /** The file this harness keeps its credential in, relative to HOME. */
  readonly path: string
  /** Read the freshness out of a credential file. */
  expiryOf(contents: string): SeatExpiry
  /** Exchange the refresh token for a new bundle. Throws if it cannot. */
  refresh(contents: string, fetchImpl?: typeof fetch): Promise<RefreshedSeat>
}

/**
 * Claude Code.
 *
 * The client id is the one its own login uses; a refresh token issued to one client cannot be
 * redeemed by another, so this is not a detail that can be tidied into configuration.
 */
const CLAUDE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e'
const CLAUDE_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token'

interface ClaudeCredentials {
  claudeAiOauth: {
    accessToken: string
    refreshToken: string
    expiresAt: number
    refreshTokenExpiresAt?: number
    [key: string]: unknown
  }
}

export const claudeCodeRefresher: HarnessRefresher = {
  path: '.claude/.credentials.json',

  expiryOf(contents) {
    const parsed = JSON.parse(contents) as ClaudeCredentials
    const oauth = parsed.claudeAiOauth
    if (!oauth) return {}
    return {
      // Milliseconds since the epoch, which is what the file stores.
      ...(oauth.expiresAt ? { accessExpiresAt: new Date(oauth.expiresAt) } : {}),
      ...(oauth.refreshTokenExpiresAt
        ? { refreshExpiresAt: new Date(oauth.refreshTokenExpiresAt) }
        : {}),
    }
  },

  async refresh(contents, fetchImpl = fetch) {
    const parsed = JSON.parse(contents) as ClaudeCredentials
    const oauth = parsed.claudeAiOauth
    if (!oauth?.refreshToken) throw new Error('the stored credential has no refresh token')

    const res = await fetchImpl(CLAUDE_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: oauth.refreshToken,
        client_id: CLAUDE_CLIENT_ID,
      }),
    })
    if (!res.ok) throw await classify(res)
    const token = (await res.json()) as {
      access_token: string
      refresh_token?: string
      expires_in?: number
    }

    const expiresIn = token.expires_in ?? 8 * 3600
    const expiresAt = new Date(Date.now() + expiresIn * 1000)
    /**
     * The rotated refresh token is stored, or the next refresh fails.
     *
     * `?? oauth.refreshToken` because a server that does not rotate returns none, and replacing
     * a good token with undefined would break the seat far more thoroughly than not refreshing
     * it would have.
     */
    const updated: ClaudeCredentials = {
      ...parsed,
      claudeAiOauth: {
        ...oauth,
        accessToken: token.access_token,
        refreshToken: token.refresh_token ?? oauth.refreshToken,
        expiresAt: expiresAt.getTime(),
      },
    }
    return { contents: JSON.stringify(updated, null, 2), expiresAt }
  },
}

/**
 * Codex.
 *
 * Its CLI does refresh itself, but only inside the container it runs in — and that container is
 * destroyed, so the refreshed bundle is lost and the stored one keeps ageing. OpenAI's guidance
 * is to persist `auth.json` between runs and to keep one per serialised stream, which is what
 * refreshing centrally achieves for a seat shared by a whole client space.
 *
 * `last_refresh` rather than a token expiry, because that is the field the file carries and the
 * one the CLI itself decides staleness from.
 */
const CODEX_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann'
const CODEX_TOKEN_URL = 'https://auth.openai.com/oauth/token'
/** How long codex treats a bundle as usable without refreshing. */
const CODEX_STALE_AFTER_MS = 8 * 24 * 3600 * 1000

interface CodexCredentials {
  tokens: { access_token: string; refresh_token: string; id_token?: string; [k: string]: unknown }
  last_refresh?: string
  [key: string]: unknown
}

export const codexRefresher: HarnessRefresher = {
  path: '.codex/auth.json',

  expiryOf(contents) {
    const parsed = JSON.parse(contents) as CodexCredentials
    if (!parsed.last_refresh) return {}
    const last = new Date(parsed.last_refresh).getTime()
    if (Number.isNaN(last)) return {}
    // Treated as the access expiry so the same margin logic applies: refresh well before codex
    // would consider the bundle stale, rather than discovering it during a run.
    return { accessExpiresAt: new Date(last + CODEX_STALE_AFTER_MS) }
  },

  async refresh(contents, fetchImpl = fetch) {
    const parsed = JSON.parse(contents) as CodexCredentials
    const refreshToken = parsed.tokens?.refresh_token
    if (!refreshToken) throw new Error('the stored credential has no refresh token')

    const res = await fetchImpl(CODEX_TOKEN_URL, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
        client_id: CODEX_CLIENT_ID,
        // Asked for explicitly: without it the response may omit the id_token, and codex reads
        // the account id out of that.
        scope: 'openid profile email',
      }),
    })
    if (!res.ok) throw await classify(res)
    const token = (await res.json()) as {
      access_token: string
      refresh_token?: string
      id_token?: string
      expires_in?: number
    }

    const now = new Date()
    const updated: CodexCredentials = {
      ...parsed,
      tokens: {
        ...parsed.tokens,
        access_token: token.access_token,
        refresh_token: token.refresh_token ?? parsed.tokens.refresh_token,
        ...(token.id_token ? { id_token: token.id_token } : {}),
      },
      // The field codex judges staleness by. Stored in the format its own CLI writes.
      last_refresh: now.toISOString().replace('Z', '000Z'),
    }
    return {
      contents: JSON.stringify(updated, null, 2),
      expiresAt: new Date(now.getTime() + CODEX_STALE_AFTER_MS),
    }
  },
}

export const REFRESHERS: Partial<Record<HarnessId, HarnessRefresher>> = {
  'claude-code': claudeCodeRefresher,
  codex: codexRefresher,
  // opencode's free tier needs no login at all, and its paid providers are configured as plain
  // API keys, which do not expire and so have nothing to refresh.
}

export function refresherFor(harness: HarnessId): HarnessRefresher | undefined {
  return REFRESHERS[harness]
}

/**
 * How much life an access token must have left to be handed to a run.
 *
 * Derived from the run's own ceiling rather than chosen: a run is killed at `RUN_WALL_CLOCK_SEC`,
 * so a token handed out at the start has to outlive that or it expires somewhere in the middle —
 * and Claude Code cannot refresh one headless, so the run would fail having done the work.
 *
 * The slack on top covers the gap between this check and the container actually starting: the
 * task is queued, an image is pulled, the run boots. That is minutes rather than seconds, and
 * measuring it precisely would be false precision — doubling the ceiling is the honest version of
 * "comfortably more than a run can take".
 *
 * Renewal is the backstop, not the plan. A run that outlasts even this asks again and gets a
 * fresh token; this margin is what makes that rare rather than routine.
 */
export const REFRESH_MARGIN_MS = RUN_WALL_CLOCK_SEC * 2 * 1000

/** Whether this credential should be refreshed before being used. */
export function needsRefresh(expiry: SeatExpiry, now = new Date()): boolean {
  if (!expiry.accessExpiresAt) return false
  return expiry.accessExpiresAt.getTime() - now.getTime() < REFRESH_MARGIN_MS
}

/** Whether refreshing is still possible at all, or a human has to sign in again. */
export function canStillRefresh(expiry: SeatExpiry, now = new Date()): boolean {
  if (!expiry.refreshExpiresAt) return true
  return expiry.refreshExpiresAt.getTime() > now.getTime()
}

/**
 * Turn a refused refresh into either "try again later" or "a person must sign in".
 *
 * The body decides, not the status: providers return `invalid_grant` with a 400, which is the
 * same status they use for requests that are merely malformed.
 */
async function classify(res: Response): Promise<Error> {
  const body = await res.text().catch(() => '')
  const message = `refresh refused (${res.status}): ${body.slice(0, 200)}`
  return /invalid_grant|invalid_request|expired/i.test(body)
    ? new RefreshTokenRejected(message)
    : new Error(message)
}
