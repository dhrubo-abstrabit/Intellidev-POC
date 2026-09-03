import { request } from 'node:http'
import type { GitCredential, ResolvedSecrets, SeatCredential } from './types.js'

/**
 * Client for the broker's unix socket.
 *
 * Used by the git credential helper subprocess and by the adapter itself. Deliberately
 * `node:http` rather than `fetch`: fetch cannot address a unix socket without pulling
 * in a custom dispatcher, and this runs in a short-lived helper where startup cost is
 * the whole cost.
 */
export class BrokerClient {
  constructor(
    private readonly socketPath: string,
    private readonly timeoutMs = 10_000,
  ) {}

  async gitCredential(body: string): Promise<string> {
    return this.call('POST', '/git-credential', body)
  }

  async seatCredential(harness: string): Promise<SeatCredential> {
    return JSON.parse(
      await this.call('GET', `/seat?harness=${encodeURIComponent(harness)}`),
    ) as SeatCredential
  }

  /** Reports a credential the harness rewrote, so the stored copy does not go stale. */
  async reportSeat(
    harness: string,
    files: Array<{ path: string; contents: string }>,
  ): Promise<void> {
    await this.call('POST', '/seat-rotation', JSON.stringify({ harness, files }))
  }

  async mcpToken(serverId: string): Promise<{ token: string; expiresAt: string }> {
    return JSON.parse(
      await this.call('GET', `/mcp-token?server=${encodeURIComponent(serverId)}`),
    ) as { token: string; expiresAt: string }
  }

  async secrets(): Promise<ResolvedSecrets> {
    return JSON.parse(await this.call('GET', '/secrets')) as ResolvedSecrets
  }

  async healthy(): Promise<boolean> {
    try {
      return (await this.call('GET', '/healthz')).trim() === 'ok'
    } catch {
      return false
    }
  }

  private call(method: string, path: string, body?: string): Promise<string> {
    return new Promise((resolve, reject) => {
      const req = request(
        { socketPath: this.socketPath, path, method, timeout: this.timeoutMs },
        (res) => {
          let data = ''
          res.setEncoding('utf8')
          res.on('data', (chunk: string) => {
            data += chunk
          })
          res.on('end', () => {
            const status = res.statusCode ?? 0
            if (status >= 400) {
              reject(new Error(`broker ${method} ${path} failed: ${status} ${data}`))
              return
            }
            resolve(data)
          })
        },
      )
      req.on('error', reject)
      req.on('timeout', () => {
        req.destroy(new Error(`broker ${method} ${path} timed out`))
      })
      if (body !== undefined) req.write(body)
      req.end()
    })
  }
}

/** Typed helper for the adapter's own git usage. */
export async function fetchGitCredential(
  client: BrokerClient,
  host: string,
): Promise<GitCredential | null> {
  const response = await client.gitCredential(`protocol=https\nhost=${host}\n\n`)
  if (!response.trim()) return null
  const fields: Record<string, string> = {}
  for (const line of response.split('\n')) {
    const at = line.indexOf('=')
    if (at > 0) fields[line.slice(0, at)] = line.slice(at + 1)
  }
  const username = fields['username']
  const password = fields['password']
  if (!username || !password) return null
  // The helper protocol carries no expiry; the broker's cache owns that.
  return { username, password, expiresAt: new Date(Date.now() + 60_000).toISOString() }
}
