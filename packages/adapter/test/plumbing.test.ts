import { describe, expect, it } from 'vitest'
import { NdjsonBuffer } from '../src/driver/ndjson.js'
import { AsyncQueue } from '../src/driver/queue.js'
import { EventBus } from '../src/events/bus.js'

describe('NdjsonBuffer', () => {
  it('reassembles objects split across chunk boundaries', () => {
    const buffer = new NdjsonBuffer()
    expect(buffer.push('{"type":"a","v":')).toEqual([])
    expect(buffer.push('1}\n')).toEqual([{ type: 'a', v: 1 }])
  })

  it('returns several objects from one chunk', () => {
    const buffer = new NdjsonBuffer()
    expect(buffer.push('{"n":1}\n{"n":2}\n')).toEqual([{ n: 1 }, { n: 2 }])
  })

  it('survives a multibyte character split across chunks', () => {
    const buffer = new NdjsonBuffer()
    const bytes = Buffer.from('{"t":"né"}\n', 'utf8')
    // Split inside the two-byte é.
    const cut = bytes.indexOf(0xc3) + 1
    expect(buffer.push(bytes.subarray(0, cut))).toEqual([])
    expect(buffer.push(bytes.subarray(cut))).toEqual([{ t: 'né' }])
  })

  it('parses a trailing line with no newline on flush', () => {
    const buffer = new NdjsonBuffer()
    expect(buffer.push('{"n":1}')).toEqual([])
    expect(buffer.flush()).toEqual([{ n: 1 }])
  })

  it('records malformed lines instead of dropping them silently', () => {
    const buffer = new NdjsonBuffer()
    expect(buffer.push('not json\n{"n":1}\n')).toEqual([{ n: 1 }])
    expect(buffer.malformed).toEqual(['not json'])
  })

  it('skips blank lines', () => {
    const buffer = new NdjsonBuffer()
    expect(buffer.push('\n\n{"n":1}\n\n')).toEqual([{ n: 1 }])
    expect(buffer.malformed).toEqual([])
  })
})

describe('AsyncQueue', () => {
  it('buffers items pushed before anyone consumes them', async () => {
    const queue = new AsyncQueue<number>()
    queue.push(1)
    queue.push(2)
    queue.close()
    const seen: number[] = []
    for await (const item of queue) seen.push(item)
    expect(seen).toEqual([1, 2])
  })

  it('hands a waiting consumer the next item as it arrives', async () => {
    const queue = new AsyncQueue<string>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.push('later')
    expect(await pending).toEqual({ value: 'later', done: false })
  })

  it('ends iteration on close', async () => {
    const queue = new AsyncQueue<string>()
    const iterator = queue[Symbol.asyncIterator]()
    const pending = iterator.next()
    queue.close()
    expect(await pending).toEqual({ value: undefined, done: true })
  })

  it('ignores pushes after close rather than leaking events', () => {
    const queue = new AsyncQueue<number>()
    queue.close()
    queue.push(1)
    expect(queue.size).toBe(0)
  })
})

describe('EventBus', () => {
  const clock = () => new Date('2026-08-12T09:00:00.000Z')

  it('numbers events from zero, monotonically and without gaps', () => {
    const seen: number[] = []
    const bus = new EventBus('run_1', (e) => seen.push(e.seq), clock)
    bus.emit({ type: 'thinking.started', data: {} })
    bus.emit({ type: 'turn.boundary', data: { turn: 0 } })
    bus.emit({ type: 'thinking.started', data: {} })
    expect(seen).toEqual([0, 1, 2])
  })

  it('stamps the current stage, and null before any stage is entered', () => {
    const bus = new EventBus('run_1', () => {}, clock)
    expect(bus.emit({ type: 'run.provisioning', data: {} }).stage).toBeNull()
    bus.enterStage('code')
    expect(bus.emit({ type: 'thinking.started', data: {} }).stage).toBe('code')
  })

  it('validates against the canonical schema, so a bad body cannot reach the log', () => {
    const bus = new EventBus('run_1', () => {}, clock)
    expect(() =>
      // @ts-expect-error deliberately wrong payload for this event type
      bus.emit({ type: 'pr.opened', data: { nope: true } }),
    ).toThrow()
  })

  it('holds events until they are acknowledged', () => {
    const bus = new EventBus('run_1', () => {}, clock)
    bus.emit({ type: 'thinking.started', data: {} })
    bus.emit({ type: 'thinking.started', data: {} })
    expect(bus.pending).toBe(2)
    bus.ack(0)
    expect(bus.pending).toBe(1)
  })

  it('replays only what a reconnecting consumer has not seen', () => {
    const bus = new EventBus('run_1', () => {}, clock)
    bus.emit({ type: 'turn.boundary', data: { turn: 0 } })
    bus.emit({ type: 'turn.boundary', data: { turn: 1 } })
    bus.emit({ type: 'turn.boundary', data: { turn: 2 } })
    expect(bus.replayFrom(0).map((e) => e.seq)).toEqual([1, 2])
  })

  it('ignores a stale ack', () => {
    const bus = new EventBus('run_1', () => {}, clock)
    bus.emit({ type: 'thinking.started', data: {} })
    bus.emit({ type: 'thinking.started', data: {} })
    bus.ack(1)
    bus.ack(0)
    expect(bus.pending).toBe(0)
  })
})
