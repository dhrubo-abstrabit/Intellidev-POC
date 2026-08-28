import { and, eq, sql } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import { credentials, integrations } from '../store/schema.js'
import type { SecretCipher } from '../secrets/cipher.js'
import type { McpServerRecord } from './types.js'
import type { McpStore } from './store.js'

/**
 * Connected MCP servers in Postgres, with their tokens encrypted.
 *
 * Project-scoped, unlike the harness seat: a server is attached to the project whose runs need
 * it, and connecting one is a project-level act that `manageable_project_ids()` governs. A team
 * shares a subscription; it does not share a Linear workspace.
 *
 * The split between what is stored in the clear and what is sealed follows the record's own
 * shape. `token`, `oauth.accessToken`, `oauth.refreshToken` and `oauth.clientSecret` are
 * credentials; everything else — the URL, the health, the tool names, the client id, the expiry
 * — is what the UI renders and what a refresh needs before it has decrypted anything.
 */

/** The project a server is attached to. */
export interface McpScope {
  readonly clientSpaceId: string
  readonly projectId: string
}

/** What is sealed. Everything else lives in the clear on the integration row. */
interface McpSecrets {
  readonly token?: string
  readonly accessToken?: string
  readonly refreshToken?: string
  readonly clientSecret?: string
}

export class PostgresMcpStore {
  /**
   * A view bound to one project.
   *
   * The unscoped methods stay, because a scope has to come from somewhere; this is what the rest
   * of the control plane holds so no call site has to remember to pass it.
   */
  for(scope: McpScope): McpStore {
    return {
      list: () => this.list(scope),
      get: (id) => this.get(scope, id),
      upsert: (record) => this.upsert(scope, record),
      patch: (id, changes) => this.patch(scope, id, changes),
      remove: (id) => this.remove(scope, id),
      withServerLock: (id, body) => this.withServerLock(scope, id, body),
    }
  }

  constructor(
    private readonly db: NodePgDatabase,
    private readonly cipher: SecretCipher,
  ) {}

  async list(scope: McpScope): Promise<McpServerRecord[]> {
    const rows = await this.db
      .select()
      .from(integrations)
      .where(and(eq(integrations.projectId, scope.projectId), eq(integrations.kind, 'mcp')))
    // Deliberately without credentials: listing is what the UI does on every page load, and a
    // server's name, health and tool list are the whole of what it needs.
    return rows
      .map((row) => row.settings as unknown as McpServerRecord)
      .sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(scope: McpScope, id: string): Promise<McpServerRecord | undefined> {
    const found = await this.row(scope, id)
    if (!found) return undefined
    return await this.withSecrets(found.id, found.settings)
  }

  /**
   * Inserts or updates, preserving credentials the caller did not mention.
   *
   * Merging rather than replacing matters: the UI re-submits a server to rename or re-point it
   * and never sends tokens back, so a replace would silently log it out.
   */
  async upsert(scope: McpScope, patch: McpServerRecord): Promise<McpServerRecord> {
    const existing = await this.get(scope, patch.id)
    const merged: McpServerRecord = {
      ...existing,
      ...patch,
      ...(patch.token === undefined && existing?.token ? { token: existing.token } : {}),
      ...(patch.oauth === undefined && existing?.oauth ? { oauth: existing.oauth } : {}),
    }
    await this.write(scope, merged)
    return merged
  }

  async patch(
    scope: McpScope,
    id: string,
    changes: Partial<McpServerRecord>,
  ): Promise<McpServerRecord> {
    const existing = await this.get(scope, id)
    if (!existing) throw new Error(`no such MCP server ${id}`)
    const merged = { ...existing, ...changes }
    await this.write(scope, merged)
    return merged
  }

  async remove(scope: McpScope, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(integrations)
      .where(
        and(
          eq(integrations.projectId, scope.projectId),
          eq(integrations.kind, 'mcp'),
          eq(integrations.ref, id),
        ),
      )
      .returning({ id: integrations.id })
    return rows.length > 0
  }

  /**
   * Runs `body` with an exclusive lock on one server, across every instance.
   *
   * This is what the in-process refresh guard could not do. Two runs dispatched together both
   * notice the same stale token and both POST the same refresh token; providers that rotate
   * refresh tokens — Atlassian and Asana are documented cases — treat the second POST as replay
   * under RFC 6819 §5.2.2.3 and revoke the whole token family. The result is a permanent
   * disconnect needing manual re-authorisation, not a retryable error. A map keyed by server id
   * prevents that inside one process and does nothing at all across two.
   *
   * `pg_advisory_xact_lock` rather than a session lock or a row: it releases on commit, on
   * rollback, and on the connection dying, so an instance that crashes mid-refresh cannot leave
   * the server locked for ever. That property is why it is worth holding a transaction open
   * across a network call — a token refresh is one round trip, and the alternative failure is
   * unrecoverable.
   */
  async withServerLock<T>(scope: McpScope, id: string, body: () => Promise<T>): Promise<T> {
    return await this.db.transaction(async (tx) => {
      // Two keys rather than a hash of the pair, so a project and a server id cannot collide
      // with a different pair that happens to hash the same.
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtext(${scope.projectId}), hashtext(${id}))`,
      )
      return await body()
    })
  }

  private async row(scope: McpScope, id: string) {
    const [row] = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.projectId, scope.projectId),
          eq(integrations.kind, 'mcp'),
          eq(integrations.ref, id),
        ),
      )
      .limit(1)
    return row ? { id: row.id, settings: row.settings as unknown as McpServerRecord } : undefined
  }

  /** Re-attaches the sealed fields to a record read from the clear settings. */
  private async withSecrets(
    integrationId: string,
    settings: McpServerRecord,
  ): Promise<McpServerRecord> {
    const [row] = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.integrationId, integrationId))
      .limit(1)
    // A server with no credential row is legitimate: `auth: 'none'` servers have nothing to
    // store, and one mid-connect has a record before it has tokens.
    if (!row) return settings

    const secrets = JSON.parse(
      await this.cipher.open(
        { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey, keyArn: row.keyArn },
        contextFor(integrationId, settings.id),
      ),
    ) as McpSecrets

    return {
      ...settings,
      ...(secrets.token ? { token: secrets.token } : {}),
      ...(settings.oauth
        ? {
            oauth: {
              ...settings.oauth,
              ...(secrets.accessToken ? { accessToken: secrets.accessToken } : {}),
              ...(secrets.refreshToken ? { refreshToken: secrets.refreshToken } : {}),
              ...(secrets.clientSecret ? { clientSecret: secrets.clientSecret } : {}),
            },
          }
        : {}),
    }
  }

  /** Writes a record, splitting it into clear settings and sealed secrets. */
  private async write(scope: McpScope, record: McpServerRecord): Promise<void> {
    const { settings, secrets } = split(record)

    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrations)
        .values({
          clientSpaceId: scope.clientSpaceId,
          projectId: scope.projectId,
          kind: 'mcp',
          ref: record.id,
          displayName: record.name,
          settings: settings as unknown as Record<string, unknown>,
          status: record.health === 'unauthorized' ? 'needs_reauth' : 'connected',
        })
        .onConflictDoUpdate({
          // The unique index is partial (`where project_id is not null`), so the predicate has
          // to be given or Postgres will not infer it.
          target: [integrations.projectId, integrations.kind, integrations.ref],
          targetWhere: sql`${integrations.projectId} is not null`,
          set: {
            displayName: record.name,
            settings: settings as unknown as Record<string, unknown>,
            status: record.health === 'unauthorized' ? 'needs_reauth' : 'connected',
            updatedAt: new Date(),
          },
        })
        .returning({ id: integrations.id })
      const integrationId = row!.id

      if (!hasSecret(secrets)) {
        // Nothing to store, and nothing should linger: a server switched from bearer to none
        // must not keep a token nobody can see.
        await tx.delete(credentials).where(eq(credentials.integrationId, integrationId))
        return
      }

      const sealed = await this.cipher.seal(
        JSON.stringify(secrets),
        contextFor(integrationId, record.id),
      )
      await tx
        .insert(credentials)
        .values({
          integrationId,
          ciphertext: sealed.ciphertext,
          wrappedKey: sealed.wrappedKey,
          keyArn: sealed.keyArn,
          ...(record.oauth?.expiresAt ? { expiresAt: new Date(record.oauth.expiresAt) } : {}),
        })
        .onConflictDoUpdate({
          target: credentials.integrationId,
          set: {
            ciphertext: sealed.ciphertext,
            wrappedKey: sealed.wrappedKey,
            keyArn: sealed.keyArn,
            expiresAt: record.oauth?.expiresAt ? new Date(record.oauth.expiresAt) : null,
            rotatedAt: new Date(),
          },
        })
    })
  }
}

/** Separates a record into what may be stored in the clear and what must be sealed. */
function split(record: McpServerRecord): { settings: McpServerRecord; secrets: McpSecrets } {
  const { token, oauth, ...rest } = record
  const { accessToken, refreshToken, clientSecret, ...oauthPublic } = oauth ?? {}
  return {
    settings: {
      ...rest,
      // The OAuth state minus its tokens: a refresh needs the client id, the server URL and the
      // expiry before it has decrypted anything, and the UI needs the expiry to say "expired".
      ...(oauth ? { oauth: oauthPublic as McpServerRecord['oauth'] } : {}),
    } as McpServerRecord,
    secrets: {
      ...(token ? { token } : {}),
      ...(accessToken ? { accessToken } : {}),
      ...(refreshToken ? { refreshToken } : {}),
      ...(clientSecret ? { clientSecret } : {}),
    },
  }
}

function hasSecret(secrets: McpSecrets): boolean {
  return Object.values(secrets).some(Boolean)
}

/**
 * What an MCP ciphertext is bound to.
 *
 * The integration id, plus the server id it claims to be for. Moving a row between projects
 * changes the integration id, so its credential cannot come along.
 */
function contextFor(integrationId: string, serverId: string): Record<string, string> {
  return { integrationId, kind: 'mcp', server: serverId }
}
