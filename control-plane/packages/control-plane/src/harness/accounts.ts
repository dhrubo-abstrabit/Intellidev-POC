import { execFile } from 'node:child_process'
import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir, platform } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@intellidev/shared'
import type { SeatStore, SpaceScope } from './seat-store.js'

/**
 * Subscription logins for the harnesses, connected once and reused by every run.
 *
 * **Imported, not impersonated.** A subscription login belongs to the vendor's own OAuth client
 * id, so driving that flow ourselves would mean impersonating their client — fragile, and not
 * ours to do. Instead the sanctioned command runs on a machine that has a browser
 * (`claude setup-token`, `codex login`, `opencode auth login`) and what it produces is imported
 * here. That is the same division as the MCP flow: consent happens where a human is, and the
 * container only ever receives material.
 */
export type SeatKind = 'env' | 'file'

export interface HarnessAccount {
  harness: HarnessId
  label: string
  /** Names and values merged into the harness environment. */
  env?: Record<string, string>
  /** Credential files, written under the run's HOME. Paths are relative to it. */
  files?: Array<{ path: string; contents: string }>
  connectedAt: string
  /** Where it was imported from, so the UI can say what to re-run to refresh it. */
  importedFrom?: string
}

/** What the browser may see: names and paths, never a value. */
export interface HarnessAccountPublic {
  harness: HarnessId
  label: string
  envVars: string[]
  files: string[]
  connectedAt: string
  importedFrom?: string
  /**
   * Whether the stored material can actually be read.
   *
   * A row existing is not the same as a usable credential, and the UI showed "connected" for a
   * seat sealed under a key that is no longer in use — so the only way to discover it was a
   * failed run. `unreadable` means the ciphertext cannot be opened at all, which is a different
   * problem from an expired token and needs a different fix.
   *
   * Deliberately not "valid": nothing here can tell whether a token the harness would accept is
   * still live without asking the vendor, and that is D3's job. This answers the narrower
   * question it can answer honestly.
   */
  readable?: boolean
}

export function toPublic(account: HarnessAccount): HarnessAccountPublic {
  return {
    harness: account.harness,
    label: account.label,
    envVars: Object.keys(account.env ?? {}),
    files: (account.files ?? []).map((file) => file.path),
    connectedAt: account.connectedAt,
    ...(account.importedFrom ? { importedFrom: account.importedFrom } : {}),
  }
}

/**
 * How each harness authenticates, and how to obtain the credential.
 *
 * Every field here was checked against the pinned CLIs rather than assumed: `claude setup-token`
 * advertises "requires Claude subscription", `CLAUDE_CODE_OAUTH_TOKEN` appears in the Claude Code
 * binary, and `codex login` / `opencode auth login` both write the JSON files named below.
 */
export interface HarnessAuthRecipe {
  harness: HarnessId
  kind: SeatKind
  /** For `env`: the variable the harness reads. */
  envVar?: string
  /** For `file`: where it lands on the host, and where it must go in the run's HOME. */
  hostPath?: string
  homePath?: string
  /**
   * macOS Keychain service holding the login, when there is no file to import.
   *
   * Claude Code keeps its credentials in the Keychain on macOS, which is why pasting a token
   * used to be the only option here — there was no file to point at. Reading the Keychain
   * removes that step on the machine where the login already happened.
   */
  keychainService?: string
  /** Where the Keychain material has to be written for the harness to find it. */
  keychainHomePath?: string
  command: string
  hint: string
}

export const HARNESS_AUTH: readonly HarnessAuthRecipe[] = [
  {
    harness: 'claude-code',
    kind: 'env',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    keychainService: 'Claude Code-credentials',
    keychainHomePath: '.claude/.credentials.json',
    command: 'claude setup-token',
    hint: 'Import reads the login already in your macOS Keychain. A token from `claude setup-token` is the safer option: it is independently revocable and carries no refresh token for a container to rotate.',
  },
  {
    harness: 'codex',
    kind: 'file',
    hostPath: join(homedir(), '.codex', 'auth.json'),
    homePath: '.codex/auth.json',
    command: 'codex login',
    hint: 'Imports the ChatGPT subscription login. The file holds a refresh token, so runs using it must not overlap.',
  },
  {
    harness: 'opencode',
    kind: 'file',
    hostPath: join(homedir(), '.local', 'share', 'opencode', 'auth.json'),
    homePath: '.local/share/opencode/auth.json',
    command: 'opencode auth login',
    hint: 'Imports whichever provider you logged into. Without this, opencode falls back to its free hosted models.',
  },
]

export function recipeFor(harness: HarnessId): HarnessAuthRecipe | undefined {
  return HARNESS_AUTH.find((entry) => entry.harness === harness)
}

/**
 * Persisted account store.
 *
 * Same reasoning as the MCP registry: a login is a human action, so losing it on restart would
 * make the feature unusable. Written `0600` because the file holds live credentials.
 */
/**
 * Seats in a JSON file, for development without a database.
 *
 * Kept because the in-memory task store has no database behind it either, and the pairing
 * should stay consistent: a developer running without Postgres gets a control plane that works
 * rather than one that fails the moment a run needs a seat.
 *
 * **Ignores the space scope**, because a file holds one space's worth of seats and there is no
 * second space to confuse it with. That is a real difference from the Postgres store and the
 * reason this is not the default anywhere a database exists.
 */
export class FileSeatStore implements SeatStore {
  private accounts = new Map<HarnessId, HarnessAccount>()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<FileSeatStore> {
    const store = new FileSeatStore(path)
    const raw = await readFile(path, 'utf8').catch(() => null)
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as { accounts?: HarnessAccount[] }
        for (const account of parsed.accounts ?? []) store.accounts.set(account.harness, account)
      } catch {
        // A corrupt file costs a reconnect, not a boot failure.
      }
    }
    return store
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify({ accounts: [...this.accounts.values()] }, null, 2))
    await chmod(this.path, 0o600).catch(() => undefined)
  }

  async list(): Promise<HarnessAccountPublic[]> {
    return (
      [...this.accounts.values()]
        .sort((a, b) => a.harness.localeCompare(b.harness))
        // Always readable: this store holds plaintext, so there is no ciphertext to fail on. The
        // field is still reported, so the UI does not have to know which store is behind it.
        .map((account) => ({ ...toPublic(account), readable: true }))
    )
  }

  async has(_scope: SpaceScope, harness: HarnessId): Promise<boolean> {
    return this.accounts.has(harness)
  }

  async connect(_scope: SpaceScope, account: HarnessAccount): Promise<void> {
    this.accounts.set(account.harness, account)
    await this.save()
  }

  async remove(_scope: SpaceScope, harness: HarnessId): Promise<boolean> {
    const had = this.accounts.delete(harness)
    if (had) await this.save()
    return had
  }

  /** Material in the shape `materialiseSeat` expects, or undefined when not connected. */
  async material(
    _scope: SpaceScope,
    harness: HarnessId,
  ): Promise<Record<string, unknown> | undefined> {
    const account = this.accounts.get(harness)
    if (!account) return undefined
    return {
      ...(account.env ? { env: account.env } : {}),
      ...(account.files ? { files: account.files } : {}),
    }
  }
}

/**
 * Read a credential file the vendor CLI wrote.
 *
 * Validated as JSON before being stored, because the failure it prevents — importing an empty or
 * half-written file — otherwise shows up much later as an unauthenticated run.
 */
export async function readCredentialFile(path: string): Promise<string> {
  const info = await stat(path).catch(() => null)
  if (!info?.isFile()) {
    throw new Error(`no credential file at ${path} — run the harness's login command first`)
  }
  const contents = await readFile(path, 'utf8')
  try {
    JSON.parse(contents)
  } catch {
    throw new Error(`${path} is not valid JSON; the login may not have completed`)
  }
  return contents
}

/**
 * Read a harness login out of the macOS Keychain.
 *
 * Only the fields the harness needs are kept. Claude Code stores its own MCP OAuth tokens in the
 * same Keychain entry, and copying those into a container would hand a run credentials for every
 * server the human ever connected in their own editor — nothing to do with this task.
 */
export async function readKeychainCredential(
  service: string,
  keep: readonly string[],
): Promise<string> {
  if (platform() !== 'darwin') {
    throw new Error('reading the Keychain is only supported on macOS')
  }

  const raw = await new Promise<string>((resolve, reject) => {
    execFile(
      'security',
      ['find-generic-password', '-s', service, '-w'],
      { maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(
            new Error(
              `no Keychain item "${service}" — log in to the harness on this machine first`,
            ),
          )
          return
        }
        resolve(stdout.trim())
      },
    )
  })

  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(raw) as Record<string, unknown>
  } catch {
    throw new Error(`Keychain item "${service}" is not JSON`)
  }

  const filtered = Object.fromEntries(
    keep.flatMap((key) => (key in parsed ? [[key, parsed[key]]] : [])),
  )
  if (Object.keys(filtered).length === 0) {
    throw new Error(`Keychain item "${service}" has none of: ${keep.join(', ')}`)
  }
  return JSON.stringify(filtered)
}

/** The only Keychain fields a run needs: the subscription login itself. */
export const KEYCHAIN_KEEP = ['claudeAiOauth'] as const
