import { chmod, mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import type { HarnessId } from '@intellidev/shared'

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
  command: string
  hint: string
}

export const HARNESS_AUTH: readonly HarnessAuthRecipe[] = [
  {
    harness: 'claude-code',
    kind: 'env',
    envVar: 'CLAUDE_CODE_OAUTH_TOKEN',
    command: 'claude setup-token',
    hint: 'Long-lived subscription token. Preferred over copying credentials: it is revocable on its own, and on macOS the real login lives in the Keychain rather than in a file that could be imported.',
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
export class HarnessAccounts {
  private accounts = new Map<HarnessId, HarnessAccount>()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<HarnessAccounts> {
    const store = new HarnessAccounts(path)
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

  list(): HarnessAccount[] {
    return [...this.accounts.values()].sort((a, b) => a.harness.localeCompare(b.harness))
  }

  get(harness: HarnessId): HarnessAccount | undefined {
    return this.accounts.get(harness)
  }

  async connect(account: HarnessAccount): Promise<HarnessAccount> {
    this.accounts.set(account.harness, account)
    await this.save()
    return account
  }

  async remove(harness: HarnessId): Promise<boolean> {
    const had = this.accounts.delete(harness)
    if (had) await this.save()
    return had
  }

  /** Material in the shape `materialiseSeat` expects, or undefined when not connected. */
  materialFor(harness: HarnessId): Record<string, unknown> | undefined {
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
