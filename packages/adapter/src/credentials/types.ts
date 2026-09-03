import type { StageId } from '@intellidev/shared'

/**
 * Credentials the adapter needs, and who is allowed to reach them.
 *
 * THE BOUNDARY, STATED PRECISELY. A unix socket is not secret from a process running
 * as the same user — the agent could just connect to it. The broker is only a real
 * boundary because of a deliberate split:
 *
 *   uid A (adapter)  owns the broker socket at 0600, does all git and PR work
 *   uid B (harness)  writes code in the worktree, cannot open the socket
 *
 * So the agent cannot obtain a GitHub token, and if it tries `git push` itself the
 * push fails — which is correct, because pushing is ours, not the model's.
 *
 * What the agent *can* see is project secrets, because its tests need them in the
 * environment (see docs/architecture.md §8b). That exposure is accepted and bounded by
 * sandbox attestation plus the egress allowlist, not pretended away.
 */

export interface GitCredential {
  username: string
  password: string
  /** ISO timestamp. The cache refreshes before this, never after. */
  expiresAt: string
}

export interface SeatCredential {
  /** Harness this material is for, so the wrong file is never written. */
  harness: string
  /** Opaque payload the driver writes to the harness's own credential file. */
  material: Record<string, unknown>
  expiresAt: string
}

export interface ResolvedSecrets {
  /** Secret name to value, already filtered to the requesting stage. */
  values: Record<string, string>
  /** Names the control plane refused or could not resolve, so a run can say why. */
  unresolved: string[]
}

/**
 * Where credentials come from. The control plane is the only real implementation;
 * everything else is a test double, which is why this interface exists at all.
 */
export interface CredentialProvider {
  gitCredential(host: string): Promise<GitCredential>
  seatCredential(harness: string): Promise<SeatCredential>
  /**
   * Hand back a credential the harness rotated for itself.
   *
   * Optional because a local provider has nowhere to send it — the file on the developer's disk
   * is already the source of truth. It matters where the seat lives in a database and the
   * container is thrown away, which is every deployed run.
   */
  reportSeat?(harness: string, files: Array<{ path: string; contents: string }>): Promise<void>
  /** Upstream MCP server token, for the gateway rather than the harness. */
  mcpToken(serverId: string): Promise<{ token: string; expiresAt: string }>
  secrets(stage: StageId): Promise<ResolvedSecrets>
}

/** One broker request, recorded so there is an audit trail of every credential use. */
export interface BrokerAccess {
  kind: 'git' | 'seat' | 'mcp' | 'secrets'
  detail: string
  stage: StageId | null
  granted: boolean
  reason?: string
  at: string
}
