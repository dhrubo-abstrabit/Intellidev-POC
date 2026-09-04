import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

/**
 * The built-in UI against the authentication gate.
 *
 * Every `/api/*` route requires a bearer token. The page is a single static file with no build
 * step, so nothing type-checks its calls — and each of these mistakes looked like a broken
 * feature rather than a missing header when it happened.
 */
const page = readFileSync(new URL('../public/index.html', import.meta.url), 'utf8')

describe('the built-in UI carries its token everywhere', () => {
  it('does not use EventSource, which cannot send an Authorization header', () => {
    /**
     * FOUND BY DISPATCHING A TASK. The run stream was an `EventSource`, which has no way to set
     * request headers — so every connection returned 401 once the API was gated, and the only
     * visible symptom was "stream interrupted — reconnecting…" repeating while the run itself
     * ran perfectly.
     *
     * The replacement reads the same server-sent events over `fetch`, which can carry the token.
     */
    expect(page).not.toContain('new EventSource')
  })

  it('keeps the token out of the query string', () => {
    /**
     * The obvious fix for EventSource is `?access_token=…`, and it is the wrong one: a URL is
     * recorded in load balancer access logs, in browser history and in referrers. A bearer token
     * belongs in a header.
     */
    expect(page).not.toMatch(/[?&](access_token|token|jwt|apikey)=/)
  })

  it('sends the token on API calls without editing every call site', () => {
    // `fetch` is wrapped once. Twenty call sites each remembering a header is twenty chances to
    // forget one, and a forgotten one reads as a broken panel rather than as a missing header.
    expect(page).toContain('window.fetch = async')
    expect(page).toContain('authorization: `Bearer ${token}`')
  })

  it('stores the token in sessionStorage rather than localStorage', () => {
    // A bearer credential should not outlive the tab on disk.
    expect(page).toContain('sessionStorage.getItem(TOKEN_KEY)')
    expect(page).not.toMatch(/localStorage\.(get|set)Item\(\s*TOKEN_KEY/)
  })
})

describe('the sign-in popup', () => {
  it('does not ask for noopener on the window it needs to navigate', () => {
    /**
     * FOUND BY CLICKING IT. `window.open` returns null whenever `noopener` is set — there is no
     * handle to give back, by specification. The window opened, stayed `about:blank`, and
     * nothing could navigate it, for both harnesses.
     *
     * The handle is the entire reason the window is opened blank on the click and navigated
     * afterwards, so the two cannot both be had.
     */
    const call = page.match(/window\.open\([^)]*\)/)
    expect(call).not.toBeNull()
    expect(call![0]).not.toContain('noopener')
    // The anchor fallback still carries it, since nothing needs that window's handle.
    expect(page).toContain('rel="noopener noreferrer"')
  })
})
