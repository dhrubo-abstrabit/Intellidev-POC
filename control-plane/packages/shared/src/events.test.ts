import { describe, expect, it } from 'vitest'
import {
  AgentEvent,
  EVENT_GROUPS,
  EventBody,
  EventType,
  PREVIEW_MAX_CHARS,
  isEvent,
  preview,
} from './events.js'

/** Every declared type must exist as a union member, and vice versa. */
function bodyTypes(): string[] {
  return EventBody.options.map((option) => option.shape.type.value as string)
}

describe('event vocabulary', () => {
  it('declares exactly the types the union implements', () => {
    expect([...bodyTypes()].sort()).toEqual([...EventType.options].sort())
  })

  it('assigns every event type to exactly one group', () => {
    const grouped = Object.values(EVENT_GROUPS).flat()
    const counts = new Map<string, number>()
    for (const type of grouped) counts.set(type, (counts.get(type) ?? 0) + 1)

    const duplicated = [...counts].filter(([, n]) => n > 1).map(([t]) => t)
    expect(duplicated, 'event types in more than one group').toEqual([])

    const ungrouped = EventType.options.filter((t) => !counts.has(t))
    expect(ungrouped, 'event types missing from EVENT_GROUPS').toEqual([])
  })
})

describe('AgentEvent', () => {
  const meta = {
    seq: 417,
    runId: 'run_4821',
    ts: '2026-08-12T09:14:03.221Z',
    stage: 'code' as const,
  }

  it('parses a wire event', () => {
    const parsed = AgentEvent.parse({
      ...meta,
      type: 'tool.call',
      data: { id: 'toolu_01A', name: 'Edit', server: 'sentry', inputPreview: '{"path":"a.ts"}' },
    })
    expect(parsed.type).toBe('tool.call')
    if (isEvent(parsed, 'tool.call')) expect(parsed.data.name).toBe('Edit')
  })

  it('allows a null stage for bootstrap events', () => {
    const parsed = AgentEvent.parse({
      ...meta,
      stage: null,
      type: 'cache.restored',
      data: { hit: true, bytes: 1024, durationMs: 4200 },
    })
    expect(parsed.stage).toBeNull()
  })

  it('rejects an unknown event type', () => {
    expect(() => AgentEvent.parse({ ...meta, type: 'nope', data: {} })).toThrow()
  })

  it('rejects a negative sequence number', () => {
    expect(() =>
      AgentEvent.parse({ ...meta, seq: -1, type: 'thinking.started', data: {} }),
    ).toThrow()
  })

  it('rejects data belonging to a different event type', () => {
    expect(() =>
      AgentEvent.parse({ ...meta, type: 'pr.opened', data: { hit: true, bytes: 1 } }),
    ).toThrow()
  })

  it('defaults usage estimates to estimate:true', () => {
    const parsed = AgentEvent.parse({
      ...meta,
      type: 'usage.updated',
      data: { tokensIn: 100, tokensOut: 20 },
    })
    if (isEvent(parsed, 'usage.updated')) {
      expect(parsed.data.estimate).toBe(true)
      expect(parsed.data.tokensCacheRead).toBe(0)
    }
  })

  it('keeps steer.received pending — delivery is a separate event', () => {
    expect(() =>
      AgentEvent.parse({
        ...meta,
        type: 'steer.received',
        data: { messageId: 'm1', text: 'also check auth', status: 'delivered' },
      }),
    ).toThrow()
  })
})

describe('preview', () => {
  it('passes short payloads through untouched', () => {
    expect(preview('hello')).toEqual({ text: 'hello', truncated: false })
  })

  it('truncates and reports oversized payloads', () => {
    const result = preview('x'.repeat(PREVIEW_MAX_CHARS + 500))
    expect(result.truncated).toBe(true)
    expect(result.text).toHaveLength(PREVIEW_MAX_CHARS)
  })

  it('serialises non-strings', () => {
    expect(preview({ a: 1 }).text).toBe('{"a":1}')
  })

  it('rejects oversized previews at the schema boundary', () => {
    expect(() =>
      AgentEvent.parse({
        seq: 1,
        runId: 'r',
        ts: '2026-08-12T09:14:03.221Z',
        stage: null,
        type: 'error',
        data: { code: 'E', message: 'y'.repeat(PREVIEW_MAX_CHARS + 1) },
      }),
    ).toThrow()
  })
})
