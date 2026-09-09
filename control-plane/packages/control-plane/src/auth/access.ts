import { sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { AuthenticatedUser } from './jwt.js'

/**
 * Whether a verified user may act on a project.
 *
 * **Asked of the database, not answered here.** The product schema already defines who can see
 * and manage what, in `current_project_ids()` and `manageable_project_ids()`, and those same
 * functions back the RLS policies protecting every other table. Reimplementing the rule in
 * TypeScript would create a second definition that drifts — and the drift would be silent,
 * because both would look right in isolation.
 *
 * The query runs with the user's claims installed, so those functions resolve `auth.uid()` to
 * the person who actually presented the token. That is the same mechanism PostgREST uses, and
 * it means a change to their membership model changes what this returns without anything here
 * being edited.
 */

export type ProjectAccess = 'none' | 'read' | 'manage'

export class ProjectAccessChecker {
  /**
   * Cached per user and project.
   *
   * Membership changes rarely and this is asked on every request; a minute of staleness is the
   * cost of not paying a round trip per call. Deliberately short, because the direction that
   * matters is *revocation* — someone removed from a project should lose access promptly, and a
   * long cache is how "we removed them" turns into "they still had it".
   */
  private readonly cache = new Map<string, { access: ProjectAccess; at: number }>()

  constructor(
    private readonly db: NodePgDatabase,
    private readonly opts: { ttlMs?: number; now?: () => number } = {},
  ) {}

  async check(user: AuthenticatedUser, projectId: string): Promise<ProjectAccess> {
    const key = `${user.id}:${projectId}`
    const now = this.opts.now?.() ?? Date.now()
    const hit = this.cache.get(key)
    if (hit && now - hit.at < (this.opts.ttlMs ?? 60_000)) return hit.access

    const access = await this.ask(user, projectId)
    this.cache.set(key, { access, at: now })
    return access
  }

  /** Drops a user's cached answers. Called when their membership is known to have changed. */
  forget(userId: string): void {
    for (const key of this.cache.keys()) {
      if (key.startsWith(`${userId}:`)) this.cache.delete(key)
    }
  }

  private async ask(user: AuthenticatedUser, projectId: string): Promise<ProjectAccess> {
    return await this.db.transaction(async (tx) => {
      /**
       * Adopt the caller's identity for the length of this transaction.
       *
       * `set local` rather than `set`, so it unwinds with the transaction and cannot leak onto
       * the next query that borrows this pooled connection — which is the failure mode that
       * would hand one user another's answers.
       */
      await tx.execute(
        sql`select set_config('request.jwt.claims', ${JSON.stringify(user.claims)}, true)`,
      )
      await tx.execute(sql`set local role authenticated`)

      const result = await tx.execute<{ manage: boolean; read: boolean }>(sql`
        select
          ${projectId}::uuid in (select public.manageable_project_ids()) as manage,
          ${projectId}::uuid in (select public.current_project_ids()) as read
      `)
      const row = (result.rows ?? result)[0] as { manage?: boolean; read?: boolean } | undefined
      if (row?.manage) return 'manage'
      if (row?.read) return 'read'
      return 'none'
    })
  }
}
