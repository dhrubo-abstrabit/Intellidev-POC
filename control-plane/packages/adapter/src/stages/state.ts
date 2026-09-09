import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { RunState, RunStateStore } from './types.js'

export function initialState(runId: string, templateName: string): RunState {
  return {
    runId,
    templateName,
    cursor: 0,
    gateFailures: {},
    visits: {},
    records: [],
    status: 'running',
    resumeTokens: {},
    pendingSteers: [],
    totalStageRuns: 0,
  }
}

/** For tests and dry runs. */
export class MemoryStateStore implements RunStateStore {
  private state: RunState | null = null
  /** Every save, in order — lets a test assert what was persisted and when. */
  readonly history: RunState[] = []

  async load(): Promise<RunState | null> {
    return this.state ? structuredClone(this.state) : null
  }

  async save(state: RunState): Promise<void> {
    this.state = structuredClone(state)
    this.history.push(structuredClone(state))
  }
}

/**
 * Writes state beside the worktree so a restarted adapter resumes at its last gate.
 *
 * Written to a temp file and renamed, because a process killed mid-write would
 * otherwise leave truncated JSON — and a run that cannot parse its own state has to
 * start over, which is exactly what this exists to prevent.
 */
export class FileStateStore implements RunStateStore {
  constructor(private readonly path: string) {}

  async load(): Promise<RunState | null> {
    try {
      return JSON.parse(await readFile(this.path, 'utf8')) as RunState
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null
      throw error
    }
  }

  async save(state: RunState): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true })
    const temp = `${this.path}.tmp`
    await writeFile(temp, JSON.stringify(state, null, 2), 'utf8')
    await rename(temp, this.path)
  }
}
