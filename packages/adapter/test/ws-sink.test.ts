import { describe, expect, it } from 'vitest'
import { AgentEvent } from '@intellidev/shared'
import { WebSocketEventSink, type WebSocketLike } from '../src/bootstrap/ws-sink.js'

/** A controllable socket double, so reconnects are deterministic rather than timed. */
class FakeSocket implements WebSocketLike {
  static instances: FakeSocket[] = []
  readonly sent: string[] = []
  readyState = 0
  onopen: ((event: unknown) => void) | null = null
  onmessage: ((event: { data: unknown }) => void) | null = null
  onclose: ((event: unknown) => void) | null = null
  onerror: ((event: unknown) => void) | null = null
  closedWith: number | undefined

  constructor(readonly url: string) {
    FakeSocket.instances.push(this)
  }

  send(data: string): void {
    if (this.readyState !== 1) throw new Error('socket is not open')
    this.sent.push(data)
  }

  close(code?: number): void {
    this.closedWith = code
    this.readyState = 3
  }

  open(): void {
    this.readyState = 1
    this.onopen?.({})
  }

  drop(): void {
    this.readyState = 3
    this.onclose?.({})
  }

  ack(seq: number): void {
    this.onmessage?.({ data: JSON.stringify({ type: 'ack', seq }) })
  }

  /** Events it received, in order. */
  get seqs(): number[] {
    return this.sent.map((raw) => (JSON.parse(raw) as { event: { seq: number } }).event.seq)
  }
}

function event(seq: number): AgentEvent {
  return AgentEvent.parse({
    seq,
    runId: 'run_1',
    ts: new Date(1700000000000 + seq).toISOString(),
    stage: null,
    type: 'run.provisioning',
    data: { message: `event ${seq}` },
  })
}

/** A bus stand-in that holds unacked events, exactly as the real one does. */
function buffer() {
  let events: AgentEvent[] = []
  return {
    push: (e: AgentEvent) => events.push(e),
    replayFrom: (seq: number) => events.filter((e) => e.seq > seq),
    ack: (seq: number) => {
      events = events.filter((e) => e.seq > seq)
    },
    get pending() {
      return events.length
    },
  }
}

function make(opts: { maxBackoffMs?: number } = {}) {
  FakeSocket.instances = []
  const held = buffer()
  const sink = new WebSocketEventSink({
    url: 'ws://cp/internal/runs/run_1/events',
    token: 'tok',
    runId: 'run_1',
    replayFrom: (seq) => held.replayFrom(seq),
    onAck: (seq) => held.ack(seq),
    connect: (url) => new FakeSocket(url),
    maxBackoffMs: opts.maxBackoffMs ?? 5,
  })
  return { sink, held, socketAt: (i: number) => FakeSocket.instances[i]! }
}

describe('shipping events out', () => {
  it('dials out with the run token, never accepting a connection', async () => {
    // Outbound is what lets Docker and Fargate share one runner interface, and why no
    // inbound security-group rule exists for a compromised run to abuse.
    const { sink, socketAt } = make()
    sink.start()
    expect(socketAt(0).url).toBe('ws://cp/internal/runs/run_1/events?token=tok')
    sink.close()
  })

  it('sends events once the socket is open', () => {
    const { sink, held, socketAt } = make()
    sink.start()
    socketAt(0).open()
    for (const seq of [0, 1, 2]) {
      const e = event(seq)
      held.push(e)
      sink.sink(e)
    }
    expect(socketAt(0).seqs).toEqual([0, 1, 2])
    sink.close()
  })

  it('drops acknowledged events so a long run stays bounded', () => {
    const { sink, held, socketAt } = make()
    sink.start()
    socketAt(0).open()
    for (const seq of [0, 1, 2]) {
      const e = event(seq)
      held.push(e)
      sink.sink(e)
    }
    expect(held.pending).toBe(3)
    socketAt(0).ack(1)
    expect(held.pending).toBe(1)
    expect(sink.acknowledged).toBe(1)
    sink.close()
  })

  it('never throws at the emit site, even with no socket', () => {
    // An event is a fact that already happened. Failing to ship it must never fail the run
    // that produced it.
    const { sink, held } = make()
    const e = event(0)
    held.push(e)
    expect(() => sink.sink(e)).not.toThrow()
    sink.close()
  })
})

describe('a dropped connection is a replay, not a hole', () => {
  it('replays every unacknowledged event on reconnect, in order', async () => {
    const { sink, held, socketAt } = make()
    sink.start()
    socketAt(0).open()
    for (const seq of [0, 1, 2, 3]) {
      const e = event(seq)
      held.push(e)
      sink.sink(e)
    }
    socketAt(0).ack(1) // 0 and 1 are durable; 2 and 3 are not
    socketAt(0).drop()

    await new Promise((resolve) => setTimeout(resolve, 40))
    const reconnected = socketAt(1)
    reconnected.open()

    // Exactly the unacknowledged tail, in order. Not everything, and not nothing.
    expect(reconnected.seqs).toEqual([2, 3])
    sink.close()
  })

  it('produces a gapless log across a drop, which is C4 done-condition', async () => {
    const { sink, held, socketAt } = make()
    sink.start()
    socketAt(0).open()

    // Emit across the drop, as a real run does: the stage engine does not pause because a
    // socket went away.
    for (const seq of [0, 1] as const) {
      const e = event(seq)
      held.push(e)
      sink.sink(e)
    }
    socketAt(0).ack(0)
    socketAt(0).drop()
    for (const seq of [2, 3] as const) {
      const e = event(seq)
      held.push(e)
      sink.sink(e) // silently dropped: no socket
    }

    await new Promise((resolve) => setTimeout(resolve, 40))
    socketAt(1).open()

    const delivered = [...socketAt(0).seqs, ...socketAt(1).seqs]
    // Union of both sockets covers 0..3 with no missing seq. Duplicates are fine — the
    // control plane drops them — but a gap could never be filled in later.
    expect([...new Set(delivered)].sort((a, b) => a - b)).toEqual([0, 1, 2, 3])
    sink.close()
  })

  it('keeps reconnecting across repeated failures', async () => {
    const { sink, socketAt } = make()
    sink.start()
    socketAt(0).open()
    socketAt(0).drop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    socketAt(1).drop()
    await new Promise((resolve) => setTimeout(resolve, 60))
    // A reconciler that gives up is indistinguishable from one with nothing to do.
    expect(FakeSocket.instances.length).toBeGreaterThanOrEqual(3)
    sink.close()
  })

  it('stops reconnecting once closed', async () => {
    const { sink, socketAt } = make()
    sink.start()
    socketAt(0).open()
    sink.close()
    socketAt(0).drop()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(FakeSocket.instances).toHaveLength(1)
  })
})

describe('acks', () => {
  it('ignores a stale ack rather than moving backwards', () => {
    const { sink, held, socketAt } = make()
    sink.start()
    socketAt(0).open()
    for (const seq of [0, 1, 2]) {
      const e = event(seq)
      held.push(e)
      sink.sink(e)
    }
    socketAt(0).ack(2)
    socketAt(0).ack(0)
    expect(sink.acknowledged).toBe(2)
    sink.close()
  })

  it('ignores frames that are not acks', () => {
    const { sink, socketAt } = make()
    sink.start()
    socketAt(0).open()
    socketAt(0).onmessage?.({ data: 'not json' })
    socketAt(0).onmessage?.({ data: JSON.stringify({ type: 'hello' }) })
    expect(sink.acknowledged).toBe(-1)
    sink.close()
  })
})
