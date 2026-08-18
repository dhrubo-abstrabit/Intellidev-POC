import { describe, expect, it } from 'vitest'
import { loginSupported, pickSignInUrl } from '../src/harness/login.js'

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

  it('ignores a bare link with no parameters, which is never the sign-in page', () => {
    expect(pickSignInUrl('see https://example.test/docs for help')).toBeUndefined()
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
