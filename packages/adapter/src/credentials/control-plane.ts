import type { StageId } from '@intellidev/shared'
import type { CredentialProvider, GitCredential, ResolvedSecrets, SeatCredential } from './types.js'

/**
 * The real provider: asks the control plane, which holds the GitHub App private key and
 * the vault references.
 *
 * The App key never leaves the control plane, so this fetches short-lived installation
 * tokens rather than anything reusable. `RUN_TOKEN` authenticates the run itself and is
 * single-use for the spec fetch — every call here carries the run's own bearer instead.
 */
export interface ControlPlaneProviderOptions {
  baseUrl: string
  runId: string
  /** Bearer for `/internal/*`. Scoped to this run and revoked when it ends. */
  runAuth: string
  fetchImpl?: typeof fetch
  /** Retries exist because a token refresh failing at minute 90 wastes the whole run. */
  retries?: number
  retryDelayMs?: number
}

export class ControlPlaneProvider implements CredentialProvider {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: ControlPlaneProviderOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  async gitCredential(host: string): Promise<GitCredential> {
    return this.post<GitCredential>('/internal/creds/git', { host })
  }

  async seatCredential(harness: string): Promise<SeatCredential> {
    return this.post<SeatCredential>('/internal/creds/seat', { harness })
  }

  async mcpToken(serverId: string): Promise<{ token: string; expiresAt: string }> {
    return this.post<{ token: string; expiresAt: string }>('/internal/creds/mcp', { serverId })
  }

  async secrets(stage: StageId): Promise<ResolvedSecrets> {
    return this.post<ResolvedSecrets>('/internal/creds/secrets', { stage })
  }

  private async post<T>(path: string, payload: Record<string, unknown>): Promise<T> {
    const attempts = (this.opts.retries ?? 2) + 1
    let lastError: unknown

    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(new URL(path, this.opts.baseUrl), {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.opts.runAuth}`,
          },
          body: JSON.stringify({ runId: this.opts.runId, ...payload }),
        })
        if (!res.ok) {
          // 4xx will not improve on retry; 5xx might.
          const detail = await res.text().catch(() => '')
          const error = new Error(`${path} failed: ${res.status} ${detail}`)
          if (res.status < 500) throw error
          lastError = error
        } else {
          return (await res.json()) as T
        }
      } catch (error) {
        lastError = error
        // A thrown 4xx must not be retried into a delay loop.
        if (error instanceof Error && /: 4\d\d /.test(error.message)) throw error
      }
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, (this.opts.retryDelayMs ?? 250) * attempt),
        )
      }
    }
    throw lastError instanceof Error ? lastError : new Error(`${path} failed`)
  }
}
