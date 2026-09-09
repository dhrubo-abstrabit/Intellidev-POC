import type { McpServerRecord } from './types.js'

/**
 * The connected-server catalogue, for one project.
 *
 * Scope is bound when the store is made rather than passed to every method. That keeps the call
 * sites — eighteen of them — reading as "the servers this request may see", and it is the shape
 * a per-request store wants once requests carry a user's project rather than configuration
 * doing.
 */
export interface McpStore {
  list(): Promise<McpServerRecord[]>
  get(id: string): Promise<McpServerRecord | undefined>
  /** Insert or update, preserving credentials the caller did not mention. */
  upsert(record: McpServerRecord): Promise<McpServerRecord>
  patch(id: string, changes: Partial<McpServerRecord>): Promise<McpServerRecord>
  remove(id: string): Promise<boolean>
  /**
   * Runs `body` with an exclusive hold on one server.
   *
   * Exists so a token refresh cannot run twice at once. Providers that rotate refresh tokens
   * treat a concurrent second POST as replay and revoke the whole token family, which is a
   * permanent disconnect rather than a retryable error.
   */
  withServerLock<T>(id: string, body: () => Promise<T>): Promise<T>
}
