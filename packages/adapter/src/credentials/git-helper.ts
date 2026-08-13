/**
 * The git credential helper protocol.
 *
 * git invokes a helper with one of `get`, `store`, `erase` and writes `key=value` lines
 * on stdin, terminated by a blank line. For `get` the helper writes the credential back
 * in the same shape.
 *
 * Kept as pure functions so the protocol is testable without a socket or a git binary —
 * the parts that talk to something else are in `broker.ts`.
 */

export type GitCredentialOperation = 'get' | 'store' | 'erase'

export interface GitCredentialRequest {
  protocol?: string
  host?: string
  path?: string
  username?: string
  /** Anything else git sent, kept so nothing is silently dropped. */
  extra: Record<string, string>
}

/**
 * Parse the key=value block git writes on stdin.
 *
 * Repeated keys (`wwwauth[]`) are joined rather than overwritten, and a line with no
 * `=` is skipped instead of throwing — a helper that dies on unexpected input turns a
 * push into an unexplained failure.
 */
export function parseGitCredentialRequest(input: string): GitCredentialRequest {
  const request: GitCredentialRequest = { extra: {} }
  for (const rawLine of input.split('\n')) {
    const line = rawLine.trim()
    if (!line) continue
    const at = line.indexOf('=')
    if (at <= 0) continue
    const key = line.slice(0, at)
    const value = line.slice(at + 1)
    switch (key) {
      case 'protocol':
        request.protocol = value
        break
      case 'host':
        request.host = value
        break
      case 'path':
        request.path = value
        break
      case 'username':
        request.username = value
        break
      default: {
        const existing = request.extra[key]
        request.extra[key] = existing === undefined ? value : `${existing}\n${value}`
      }
    }
  }
  return request
}

/** Format a credential the way git expects to read it back. */
export function formatGitCredentialResponse(cred: { username: string; password: string }): string {
  // `quit` is deliberately absent: git should keep consulting later helpers if we
  // decline, rather than being told to stop looking.
  return `username=${cred.username}\npassword=${cred.password}\n\n`
}

/**
 * Whether we should answer at all.
 *
 * A GitHub App installation token authenticates to GitHub over HTTPS and nothing else.
 * Answering for another host would hand a GitHub token to whoever asked, so an
 * unrecognised host gets silence — which git treats as "no credential", not an error.
 */
export function shouldAnswer(
  request: GitCredentialRequest,
  allowedHosts: readonly string[],
): boolean {
  if (request.protocol && request.protocol !== 'https') return false
  if (!request.host) return false
  return allowedHosts.includes(request.host)
}

/** The username GitHub expects alongside an installation token. */
export const GITHUB_APP_USERNAME = 'x-access-token'
