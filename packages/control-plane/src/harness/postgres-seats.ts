import { and, eq, isNull } from 'drizzle-orm'
import type { NodePgDatabase } from 'drizzle-orm/node-postgres'
import type { HarnessId } from '@intellidev/shared'
import { credentials, integrations } from '../store/schema.js'
import type { SecretCipher } from '../secrets/cipher.js'
import type { HarnessAccount, HarnessAccountPublic } from './accounts.js'
import {
  materialFor,
  settingsFor,
  toRunMaterial,
  type SeatMaterial,
  type SeatSettings,
  type SeatStore,
  type SpaceScope,
} from './seat-store.js'

/**
 * Harness seats in Postgres, with the credential material encrypted.
 *
 * Two rows per seat: `runner.integrations` holds what the UI needs and `runner.credentials`
 * holds the sealed values. Splitting them is what lets a listing avoid decrypting — and it is
 * also what makes the security boundary physical, since `runner.credentials` has RLS enabled
 * with no policies and no grants, so no user's JWT can reach it under any circumstances.
 *
 * The encryption context binds each ciphertext to its integration row. A seat lifted from one
 * space into another fails to decrypt rather than quietly authorising runs it should not — and
 * with KMS that refusal comes from AWS, not from this code.
 */
export class PostgresSeatStore implements SeatStore {
  constructor(
    private readonly db: NodePgDatabase,
    private readonly cipher: SecretCipher,
  ) {}

  async list(scope: SpaceScope): Promise<HarnessAccountPublic[]> {
    const rows = await this.db
      .select()
      .from(integrations)
      .where(
        and(
          eq(integrations.clientSpaceId, scope.clientSpaceId),
          eq(integrations.kind, 'harness'),
          // Space-level rows only. A project override would be a different question and is not
          // one the UI asks here.
          isNull(integrations.projectId),
        ),
      )
    /**
     * Each seat is checked for readability, not just listed.
     *
     * A row existing is not a working credential: a seat sealed under a key no longer in use
     * cannot be opened at all, and the UI showed it as connected until a run failed. One KMS
     * decrypt per connected harness on a page load is a real cost, but there are at most three
     * of them and the alternative is a green dot that lies.
     *
     * Only the ability to open it is checked — the plaintext is discarded immediately, and no
     * caller of `list` ever sees material.
     */
    const seats = await Promise.all(
      rows.map(async (row) => {
        const harness = row.ref as HarnessId
        const listed = toPublic(harness, row.settings as unknown as SeatSettings)
        try {
          await this.material(scope, harness)
          return { ...listed, readable: true }
        } catch {
          return { ...listed, readable: false }
        }
      }),
    )
    return seats.sort((a, b) => a.harness.localeCompare(b.harness))
  }

  async has(scope: SpaceScope, harness: HarnessId): Promise<boolean> {
    return (await this.integrationId(scope, harness)) !== undefined
  }

  async material(
    scope: SpaceScope,
    harness: HarnessId,
  ): Promise<Record<string, unknown> | undefined> {
    const id = await this.integrationId(scope, harness)
    if (!id) return undefined

    const [row] = await this.db
      .select()
      .from(credentials)
      .where(eq(credentials.integrationId, id))
      .limit(1)
    // A connected seat with no credential row is a legitimate state, not a fault: opencode's
    // free tier needs no login at all, and a harness that does need one complains far more
    // clearly than a boot failure would.
    if (!row) return {}

    const opened = await this.cipher.open(
      { ciphertext: row.ciphertext, wrappedKey: row.wrappedKey, keyArn: row.keyArn },
      contextFor(id, harness),
    )
    return toRunMaterial(JSON.parse(opened) as SeatMaterial)
  }

  /**
   * Stores a seat, replacing any previous one for that harness.
   *
   * One transaction, because a seat whose integration row exists without its credential looks
   * connected and produces runs that fail at the first model call — the failure mode that cost a
   * whole Fargate run to diagnose when the token had merely expired.
   */
  async connect(scope: SpaceScope, account: HarnessAccount): Promise<void> {
    const sealedLater = materialFor(account)
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(integrations)
        .values({
          clientSpaceId: scope.clientSpaceId,
          projectId: null,
          kind: 'harness',
          ref: account.harness,
          displayName: account.label,
          settings: settingsFor(account) as unknown as Record<string, unknown>,
          status: 'connected',
        })
        .onConflictDoUpdate({
          target: [integrations.clientSpaceId, integrations.kind, integrations.ref],
          // The unique index is partial (`where project_id is null`), and Postgres will not
          // infer a partial index without its predicate — without this the insert fails with
          // "no unique or exclusion constraint matching the ON CONFLICT specification".
          targetWhere: isNull(integrations.projectId),
          set: {
            displayName: account.label,
            settings: settingsFor(account) as unknown as Record<string, unknown>,
            status: 'connected',
            updatedAt: new Date(),
          },
        })
        .returning({ id: integrations.id })
      const id = row!.id

      // Sealed against the row it is about to occupy, so it cannot be moved.
      const sealed = await this.cipher.seal(
        JSON.stringify(sealedLater),
        contextFor(id, account.harness),
      )
      await tx
        .insert(credentials)
        .values({
          integrationId: id,
          ciphertext: sealed.ciphertext,
          wrappedKey: sealed.wrappedKey,
          keyArn: sealed.keyArn,
          // A subscription login has no expiry we are told about. D3 is where rotation lands;
          // until then a dead seat is discovered by a run failing, which is why the harness's
          // own message now reaches the failure reason.
          expiresAt: null,
        })
        .onConflictDoUpdate({
          target: credentials.integrationId,
          set: {
            ciphertext: sealed.ciphertext,
            wrappedKey: sealed.wrappedKey,
            keyArn: sealed.keyArn,
            rotatedAt: new Date(),
          },
        })
    })
  }

  async remove(scope: SpaceScope, harness: HarnessId): Promise<boolean> {
    // The credential row goes with it through the cascade declared in the migration, so there
    // is no window where material outlives the integration that explains it.
    const rows = await this.db
      .delete(integrations)
      .where(
        and(
          eq(integrations.clientSpaceId, scope.clientSpaceId),
          eq(integrations.kind, 'harness'),
          eq(integrations.ref, harness),
          isNull(integrations.projectId),
        ),
      )
      .returning({ id: integrations.id })
    return rows.length > 0
  }

  private async integrationId(scope: SpaceScope, harness: HarnessId): Promise<string | undefined> {
    const [row] = await this.db
      .select({ id: integrations.id })
      .from(integrations)
      .where(
        and(
          eq(integrations.clientSpaceId, scope.clientSpaceId),
          eq(integrations.kind, 'harness'),
          eq(integrations.ref, harness),
          isNull(integrations.projectId),
        ),
      )
      .limit(1)
    return row?.id
  }
}

/**
 * What a seat's ciphertext is bound to.
 *
 * The integration id rather than the space: an id is unique and immutable, so re-connecting a
 * seat produces a new ciphertext under the same binding, and moving a row between spaces cannot
 * carry its credential.
 */
function contextFor(integrationId: string, harness: HarnessId): Record<string, string> {
  return { integrationId, kind: 'harness', harness }
}

function toPublic(harness: HarnessId, settings: SeatSettings): HarnessAccountPublic {
  return {
    harness,
    label: settings.label,
    envVars: settings.envVars,
    files: settings.files,
    connectedAt: settings.connectedAt,
    ...(settings.importedFrom ? { importedFrom: settings.importedFrom } : {}),
  }
}
