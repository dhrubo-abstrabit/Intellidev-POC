import type { HarnessId } from '@intellidev/shared'
import type { HarnessAccount, HarnessAccountPublic } from './accounts.js'

/**
 * Where harness seats live.
 *
 * A seat is a subscription login — the Claude Code OAuth token, an opencode credential file —
 * connected once by a person and reused by every run. It was a JSON file under the work root,
 * which is correct for one process on one laptop and wrong for everything after: a hosted
 * control plane loses every login on each deploy, and a second instance cannot see what the
 * first connected.
 *
 * **Scoped to a client space, not a project.** One seat serves every project in the space, which
 * is how a team shares a subscription rather than buying one per project. Connecting or removing
 * it is therefore a space-admin act, and the RLS policy on `runner.integrations` enforces that:
 * a project member can attach an MCP server to their own project but cannot touch the shared
 * seat.
 *
 * **Metadata and material are read separately, and that is the point.** Listing seats for the UI
 * must not decrypt anything — it happens on every page load, each decrypt is a KMS call at
 * ~65 ms, and a listing has no business holding credentials. So the names of the environment
 * variables and the paths of the credential files live in plaintext on the integration row, and
 * only `material()` opens the ciphertext.
 */

/** The space a seat belongs to. Seats are shared across every project in it. */
export interface SpaceScope {
  readonly clientSpaceId: string
}

export interface SeatStore {
  /** What the UI shows: names and paths, never a value. Decrypts nothing. */
  list(scope: SpaceScope): Promise<HarnessAccountPublic[]>
  /** Whether a harness is connected. Decrypts nothing. */
  has(scope: SpaceScope, harness: HarnessId): Promise<boolean>
  /**
   * The material a run needs, decrypted.
   *
   * The only method that opens a ciphertext, so it is the only one that costs a KMS call and
   * the only one worth auditing.
   */
  material(scope: SpaceScope, harness: HarnessId): Promise<Record<string, unknown> | undefined>
  /** Stores a seat, replacing any previous one for that harness. */
  connect(scope: SpaceScope, account: HarnessAccount): Promise<void>
  remove(scope: SpaceScope, harness: HarnessId): Promise<boolean>
}

/**
 * The plaintext half of a stored seat.
 *
 * Kept deliberately narrow: enough for the UI to say what is connected and what it holds,
 * without any of it being usable. `envVars` are names only and `files` are paths only — the
 * same shape `toPublic` already returns, so nothing downstream has to change.
 */
export interface SeatSettings {
  readonly label: string
  readonly envVars: string[]
  readonly files: string[]
  readonly importedFrom?: string
  readonly connectedAt: string
}

/** What gets sealed. The values, and nothing that is already on the row in plaintext. */
export interface SeatMaterial {
  readonly env?: Record<string, string>
  readonly files?: Array<{ path: string; contents: string }>
}

export function settingsFor(account: HarnessAccount): SeatSettings {
  return {
    label: account.label,
    envVars: Object.keys(account.env ?? {}),
    files: (account.files ?? []).map((file) => file.path),
    ...(account.importedFrom ? { importedFrom: account.importedFrom } : {}),
    connectedAt: account.connectedAt,
  }
}

export function materialFor(account: HarnessAccount): SeatMaterial {
  return {
    ...(account.env ? { env: account.env } : {}),
    ...(account.files ? { files: account.files } : {}),
  }
}

/** The shape `materialiseSeat` expects, from decrypted material. */
export function toRunMaterial(material: SeatMaterial): Record<string, unknown> {
  return {
    ...(material.env ? { env: material.env } : {}),
    ...(material.files ? { files: material.files } : {}),
  }
}
