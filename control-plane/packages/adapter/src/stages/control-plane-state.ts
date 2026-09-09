import type { RunState, RunStateStore } from './types.js'

/**
 * Run state kept by the control plane rather than in the container.
 *
 * The engine already resumed from a cursor — it just wrote that cursor to a file inside the
 * container, which is sufficient for a run that never stops and useless for one that does. A
 * Fargate task parked for approval is *destroyed*, and a file inside it goes with it.
 *
 * Writing it out is what lets an approval cost nothing while it waits. The alternative — holding
 * the container open until someone decides — bills by the second for a process doing nothing,
 * for however long the decision takes.
 *
 * Every transition is saved, which the engine relies on: a run killed mid-stage resumes at that
 * stage rather than at the top. That makes `save` the hot path here, and the reason it is a plain
 * PUT of a small JSON document rather than anything cleverer.
 */
export interface ControlPlaneStateStoreOptions {
  baseUrl: string
  runId: string
  /** The run's own bearer. The same one the credential broker checks. */
  runAuth: string
  fetchImpl?: typeof fetch
  /**
   * A local mirror, written alongside every save.
   *
   * Not a cache — nothing reads it in the normal path. It exists so a run whose control plane
   * became unreachable mid-flight still has its state on disk for a person to look at, rather
   * than the state existing only in a request that failed.
   */
  mirror?: RunStateStore
  /** Retries, because losing a transition is worse than a slow one. */
  retries?: number
  retryDelayMs?: number
  onDiagnostic?: (message: string) => void
}

export class ControlPlaneStateStore implements RunStateStore {
  private readonly fetchImpl: typeof fetch

  constructor(private readonly opts: ControlPlaneStateStoreOptions) {
    this.fetchImpl = opts.fetchImpl ?? fetch
  }

  /**
   * The highest event sequence this run has already recorded, from the last `load`.
   *
   * Read by the bootstrap to seed the event bus. A resume is a new container for the same run,
   * and sequence numbers are per run — so a bus starting at zero produced events that the store
   * dropped as duplicates of the first container's.
   */
  seqHwm(): number | undefined {
    return this.lastSeqHwm
  }

  private lastSeqHwm: number | undefined

  async load(): Promise<RunState | null> {
    /**
     * A missing state is a first run, not an error.
     *
     * 404 therefore means "start clean" rather than "fail" — every run's first `load` is a 404,
     * and treating it as a fault would mean no run could ever begin.
     */
    const res = await this.request('GET')
    if (!res) return null
    if (res.status === 404) return null
    if (!res.ok) {
      // Loudly: continuing with a clean state would silently re-run stages that already
      // happened, which for a parked run means redoing work somebody already approved.
      throw new Error(`could not load run state (${res.status})`)
    }
    const body = (await res.json()) as { state: RunState | null; seqHwm?: number }
    if (typeof body.seqHwm === 'number') this.lastSeqHwm = body.seqHwm
    return body.state ?? null
  }

  async save(state: RunState): Promise<void> {
    // The mirror first, so the on-disk copy exists even if the request that follows fails.
    await this.opts.mirror?.save(state).catch(() => undefined)

    const res = await this.request('PUT', { state })
    if (!res || !res.ok) {
      /**
       * Thrown, not swallowed.
       *
       * A lost save means the next container resumes from an older cursor and repeats stages —
       * including, for an approved stage, work a person has already signed off. Failing the run
       * here is the lesser outcome, and the mirror above still holds what was lost.
       */
      throw new Error(`could not save run state (${res?.status ?? 'unreachable'})`)
    }
  }

  private async request(method: 'GET' | 'PUT', body?: unknown): Promise<Response | undefined> {
    const url = `${this.opts.baseUrl.replace(/\/$/, '')}/internal/runs/${this.opts.runId}/state`
    const attempts = (this.opts.retries ?? 3) + 1

    let last: Response | undefined
    for (let attempt = 1; attempt <= attempts; attempt++) {
      try {
        const res = await this.fetchImpl(url, {
          method,
          headers: {
            authorization: `Bearer ${this.opts.runAuth}`,
            ...(body ? { 'content-type': 'application/json' } : {}),
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        })
        // A 404 on GET is an answer, and a 4xx is a decision — neither improves by being asked
        // again. Only a server error or a dropped connection is worth retrying.
        if (res.status < 500) return res
        last = res
      } catch (error) {
        this.opts.onDiagnostic?.(
          `state ${method} attempt ${attempt}/${attempts} failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        )
      }
      if (attempt < attempts) {
        await new Promise((resolve) =>
          setTimeout(resolve, (this.opts.retryDelayMs ?? 500) * attempt),
        )
      }
    }
    return last
  }
}
