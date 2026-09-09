import { describe, expect, it } from 'vitest'
import { HarnessLogin, loginSupported, pickSignInUrl } from '../src/harness/login.js'

/**
 * Both fixtures are verbatim from the pinned CLIs, because the whole point of this function is
 * to survive whatever they actually print rather than what a schema says they should.
 */
const CODEX_OUTPUT = `Starting local login server on http://localhost:1455.
If your browser did not open, navigate to this URL to authenticate:

https://auth.openai.com/oauth/authorize?response_type=code&client_id=app_EMoamEEZ73f0CkXaXp7hrann&redirect_uri=http%3A%2F%2Flocalhost%3A1455%2Fauth%2Fcallback&scope=openid%20profile&code_challenge=zJjXiC&code_challenge_method=S256&state=8_2pRN

On a remote or headless machine? Use \`codex login --device-auth\` instead.`

const CLAUDE_OUTPUT = `Opening browser to sign in…
If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback&code_challenge=kGDcyJ&code_challenge_method=S256&state=RBbd3Q
Paste code here if prompted > `

describe('picking the sign-in link', () => {
  /**
   * REGRESSION. Codex announces its own callback server on the line *above* the sign-in link, so
   * taking the first URL sent people to a blank local page and the login could never complete.
   */
  it('skips the local callback server codex announces first', () => {
    const url = pickSignInUrl(CODEX_OUTPUT)
    expect(url).toMatch(/^https:\/\/auth\.openai\.com\/oauth\/authorize\?/)
    expect(url).not.toContain('localhost:1455/')
  })

  it('takes the authorize link out of Claude Code output, prompt and all', () => {
    const url = pickSignInUrl(CLAUDE_OUTPUT)
    expect(url).toMatch(/^https:\/\/claude\.com\/cai\/oauth\/authorize\?/)
    // The trailing `> ` of the prompt must not end up glued to the URL.
    expect(url?.endsWith('RBbd3Q')).toBe(true)
  })

  it('drops sentence punctuation that follows a link', () => {
    expect(pickSignInUrl('visit https://example.test/auth?x=1.')).toBe(
      'https://example.test/auth?x=1',
    )
  })

  it('ignores a bare docs link, but not a bare device-code page', () => {
    /**
     * The rule used to be "no query string, not a sign-in link", which held until codex's device
     * flow — it sends someone to `https://auth.openai.com/codex/device` and passes the code
     * separately, so the only URL in the output was being discarded and the panel showed nothing.
     *
     * A bare URL now qualifies on its path alone, which still excludes documentation.
     */
    expect(pickSignInUrl('see https://example.test/docs for help')).toBeUndefined()
    expect(pickSignInUrl('open https://auth.openai.com/codex/device and enter TTBH-R6N6P')).toBe(
      'https://auth.openai.com/codex/device',
    )
    // A real authorization URL still wins over anything bare in the same output.
    expect(
      pickSignInUrl('docs https://auth.openai.com/codex/device or https://x.test/authorize?a=1'),
    ).toBe('https://x.test/authorize?a=1')
  })

  it('returns nothing when the CLI printed no link at all', () => {
    expect(pickSignInUrl('Welcome to Codex\nsigned in already')).toBeUndefined()
  })
})

describe('which harnesses can sign in', () => {
  it('covers claude-code and codex, and leaves opencode to import', () => {
    expect(loginSupported('claude-code')).toBe(true)
    expect(loginSupported('codex')).toBe(true)
    // opencode's login is an interactive provider picker with no scriptable form.
    expect(loginSupported('opencode')).toBe(false)
  })
})

describe('a login that runs nowhere but a container', () => {
  /**
   * The `host` variant is gone.
   *
   * It existed for codex, whose browser callback had to land on the same localhost the browser
   * would visit — impossible on a hosted control plane, where "host" is a container in another
   * datacentre. Its device flow needs no callback at all, so nothing runs on the host any more
   * and the refusal that explained the impossibility has nothing left to refuse.
   */
  it('offers no scriptable login for opencode, whose picker cannot be driven', () => {
    expect(loginSupported('opencode')).toBe(false)
  })

  it('signs codex in by device code, which needs no callback', () => {
    // The property that removed the whole class of problem: no localhost, nothing to paste.
    expect(loginSupported('codex')).toBe(true)
  })
})
