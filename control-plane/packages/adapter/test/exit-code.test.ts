import { describe, expect, it } from 'vitest'
import { exitCodeFor } from '../src/cli/adapter.js'

/**
 * What the container's exit code says about a run.
 *
 * This is how every run gets *reported*: the control plane's reconciler reads the ECS stop
 * reason, and a non-zero exit is described as "adapter exited 1" and settled as a failure. So
 * this one expression decides whether a run that worked looks like one.
 */
describe('the exit code a run reports', () => {
  it('is 0 for a run that parked for approval', () => {
    /**
     * FOUND ON A RUN THAT WORKED. A pipeline gated on `code` ran design, branch and code,
     * changed a file, parked — and the task showed "Essential container in task exited ·
     * adapter exited 1".
     *
     * The container is meant to stop there; that is how waiting for a person costs nothing.
     * Reporting it as a crash made the feature look broken in exactly the case it was built for.
     */
    expect(exitCodeFor('parked')).toBe(0)
  })

  it('is 0 for a run that succeeded', () => {
    expect(exitCodeFor('succeeded')).toBe(0)
  })

  it('is 1 for every outcome that is not one of those', () => {
    // Listed rather than asserted on a default, so a new outcome added later has to be thought
    // about here instead of quietly inheriting whichever branch it lands in.
    for (const outcome of ['failed', 'cancelled', 'timed_out', 'unknown']) {
      expect(exitCodeFor(outcome), outcome).toBe(1)
    }
  })
})
