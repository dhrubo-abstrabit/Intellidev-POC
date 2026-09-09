import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { McpServerRecord } from './types.js'
import type { McpStore } from './store.js'

/**
 * The connected-server catalogue, persisted to one JSON file.
 *
 * Unlike the task store this one is NOT in memory only, and the reason is narrow: an OAuth
 * consent is a human action. Losing tasks on restart is a shrug; making someone re-authorise
 * every server on restart would make the feature unusable.
 *
 * It is still a local development shim. The file holds live refresh tokens, so it is written
 * `0600` and lives under the work root rather than in the repo — but a real deployment wants
 * these in a secrets manager, keyed per project, with rotation. `docs/architecture.md §8`
 * describes that end state; this is the smallest thing that lets the flow be tested.
 */
export class FileMcpStore implements McpStore {
  private servers = new Map<string, McpServerRecord>()

  private constructor(private readonly path: string) {}

  static async open(path: string): Promise<FileMcpStore> {
    const registry = new FileMcpStore(path)
    await registry.load()
    return registry
  }

  private async load(): Promise<void> {
    const raw = await readFile(this.path, 'utf8').catch(() => null)
    if (!raw) return
    try {
      const parsed = JSON.parse(raw) as { servers?: McpServerRecord[] }
      for (const server of parsed.servers ?? []) this.servers.set(server.id, server)
    } catch {
      // A corrupt file should not stop the control plane from booting; the servers simply
      // need reconnecting, and that is recoverable in a way a crash loop is not.
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    await writeFile(this.path, JSON.stringify({ servers: [...this.servers.values()] }, null, 2))
    // Set after writing: the file contains refresh tokens.
    await chmod(this.path, 0o600).catch(() => undefined)
  }

  async list(): Promise<McpServerRecord[]> {
    return [...this.servers.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  async get(id: string): Promise<McpServerRecord | undefined> {
    return this.servers.get(id)
  }

  /**
   * Insert or update, preserving anything the caller did not mention.
   *
   * Merging rather than replacing matters for tokens: the UI re-submits a server to rename
   * or re-point it and never sends credentials back, so a replace would silently log it out.
   */
  async upsert(patch: McpServerRecord): Promise<McpServerRecord> {
    const existing = this.servers.get(patch.id)
    const merged: McpServerRecord = {
      ...existing,
      ...patch,
      ...(patch.token === undefined && existing?.token ? { token: existing.token } : {}),
      ...(patch.oauth === undefined && existing?.oauth ? { oauth: existing.oauth } : {}),
    }
    this.servers.set(merged.id, merged)
    await this.save()
    return merged
  }

  async patch(id: string, changes: Partial<McpServerRecord>): Promise<McpServerRecord> {
    const existing = this.servers.get(id)
    if (!existing) throw new Error(`no such MCP server ${id}`)
    const merged = { ...existing, ...changes }
    this.servers.set(id, merged)
    await this.save()
    return merged
  }

  async remove(id: string): Promise<boolean> {
    const had = this.servers.delete(id)
    if (had) await this.save()
    return had
  }

  /**
   * The in-process equivalent of the database's advisory lock.
   *
   * Correct for one process, which is all a file-backed store can ever serve — a second instance
   * would be reading a different file. Kept so both implementations satisfy one contract and the
   * refresh path does not have to ask which store it is talking to.
   */
  private readonly holds = new Map<string, Promise<unknown>>()

  async withServerLock<T>(id: string, body: () => Promise<T>): Promise<T> {
    // Chained rather than rejected: a second caller waits its turn, which is what the database
    // lock does too.
    const previous = this.holds.get(id) ?? Promise.resolve()
    const mine = previous.then(body, body)
    this.holds.set(
      id,
      mine.catch(() => undefined),
    )
    try {
      return await mine
    } finally {
      if (this.holds.get(id) === mine) this.holds.delete(id)
    }
  }
}
