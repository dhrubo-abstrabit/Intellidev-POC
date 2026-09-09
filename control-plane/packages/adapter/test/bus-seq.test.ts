import { describe, expect, it } from 'vitest'
import { EventBus } from '../src/events/bus.js'

/**
 * How a resumed run numbers its events.
 *
 * `seq` is unique per run — the control plane enforces `(run_id, seq)` and treats a repeat as a
 * replay to be absorbed — and a resume is a *second container* for the same run.
 *
 * FOUND BY APPROVING A PARKED RUN. A bus starting at zero emitted sequences the store already
 * held, so every one was discarded as a duplicate: the live log stopped dead at the approval,
 * no stage after the gate ever appeared, and `pr.opened` was dropped, leaving the run's pull
 * request unrecorded. The run looked frozen and then finished with nothing to show.
 */
const at = () => new Date(0)

/**
 * A valid event body, since the bus parses what it stamps.
 *
 * The type is beside the point here — what is under test is the number the bus puts on it — so
 * one shape is used throughout rather than a different event per case.
 */
const provisioning = (message: string) => ({ type: 'run.provisioning', data: { message } }) as never

describe('numbering a resumed run', () => {
  it('starts where the previous container stopped', () => {
    const seen: Array<{ seq: number }> = []
    const bus = new EventBus('r', (event) => seen.push(event), at, undefined, 36)

    bus.emit(provisioning('first'))
    bus.emit(provisioning('second'))

    expect(seen.map((event) => event.seq)).toEqual([36, 37])
  })

  it('starts at zero for a run’s first container', () => {
    // The default has to stay the default, or a fresh run would skip sequences and a consumer
    // waiting to replay a gap would wait for ever.
    const seen: Array<{ seq: number }> = []
    const bus = new EventBus('r', (event) => seen.push(event), at)

    bus.emit(provisioning('only'))

    expect(seen[0]?.seq).toBe(0)
  })

  it('replays from a sequence the resumed run actually used', () => {
    /**
     * Replay is expressed in the same numbering, so an offset bus has to answer `replayFrom`
     * in those terms too — otherwise a reconnect mid-resume re-sends nothing, and whatever was
     * unacknowledged is lost rather than retried.
     */
    const bus = new EventBus('r', () => {}, at, undefined, 100)
    bus.emit(provisioning('first'))
    bus.emit(provisioning('second'))

    expect(bus.replayFrom(100).map((event) => event.seq)).toEqual([101])
    expect(bus.replayFrom(99).map((event) => event.seq)).toEqual([100, 101])
  })

  it('acknowledges by absolute sequence, not by position', () => {
    // The ack comes back from the control plane carrying the run's own numbering. Treating it
    // as an index into this container's buffer would drop events that were never acknowledged.
    const bus = new EventBus('r', () => {}, at, undefined, 50)
    bus.emit(provisioning('first'))
    bus.emit(provisioning('second'))

    bus.ack(50)

    expect(bus.replayFrom(49).map((event) => event.seq)).toEqual([51])
  })
})
