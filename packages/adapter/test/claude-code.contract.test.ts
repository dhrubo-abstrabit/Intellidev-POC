import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEvent, type EventBody } from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import { ClaudeCodeMapper } from '../src/driver/claude-code/mapper.js'
import { buildClaudeArgs, encodeUserMessage } from '../src/driver/claude-code/driver.js'
import { NdjsonBuffer } from '../src/driver/ndjson.js'

/**
 * Replays real `claude-code 2.1.228` output recorded into
 * `test/fixtures/claude-code/`. No subprocess, no quota, deterministic.
 *
 * If a future CLI version changes shape, re-record the fixture and this test tells
 * you exactly what moved — which is the point of pinning the version in the image.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'claude-code')

function replay(fixture: string): { events: EventBody[]; mapper: ClaudeCodeMapper } {
  const mapper = new ClaudeCodeMapper()
  const buffer = new NdjsonBuffer()
  const events: EventBody[] = []
  const raw = readFileSync(join(FIXTURES, fixture), 'utf8')
  for (const parsed of buffer.push(raw)) events.push(...mapper.push(parsed))
  for (const parsed of buffer.flush()) events.push(...mapper.push(parsed))
  expect(buffer.malformed, 'fixture should be valid NDJSON').toEqual([])
  return { events, mapper }
}

describe('claude-code fixture: tool use', () => {
  const { events, mapper } = replay('tool-use.ndjson')
  const types = events.map((e) => e.type)

  it('recognises every message the CLI emitted', () => {
    expect(mapper.unmapped, 'unmapped output means the CLI shape drifted').toEqual([])
  })

  it('produces only events the canonical schema accepts', () => {
    for (const [i, body] of events.entries()) {
      const parsed = AgentEvent.safeParse({
        seq: i,
        runId: 'run_test',
        ts: '2026-08-12T00:00:00.000Z',
        stage: 'code',
        ...body,
      })
      expect(parsed.success, `${body.type} failed: ${JSON.stringify(parsed.error?.issues)}`).toBe(
        true,
      )
    }
  })

  it('pairs every tool.call with a tool.result carrying the tool name', () => {
    const calls = events.filter((e) => e.type === 'tool.call')
    const results = events.filter((e) => e.type === 'tool.result')
    expect(calls.length).toBeGreaterThan(0)
    expect(results).toHaveLength(calls.length)
    for (const result of results) {
      if (result.type !== 'tool.result') continue
      // The wire format gives results an id but no name; the mapper resolves it.
      expect(result.data.name).not.toBe('unknown')
      expect(calls.some((c) => c.type === 'tool.call' && c.data.id === result.data.id)).toBe(true)
    }
  })

  it('emits results after their call, never before', () => {
    for (const [i, event] of events.entries()) {
      if (event.type !== 'tool.result') continue
      const callIndex = events.findIndex(
        (e) => e.type === 'tool.call' && e.data.id === event.data.id,
      )
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(callIndex).toBeLessThan(i)
    }
  })

  it('ends the turn exactly once, at the end', () => {
    const boundaries = types.filter((t) => t === 'turn.boundary')
    expect(boundaries).toHaveLength(1)
    expect(types.at(-1)).toBe('turn.boundary')
  })

  it('captures the session id as a resume token', () => {
    expect(mapper.resumeToken).toBe('00000000-0000-4000-8000-000000000001')
  })

  it('records what the harness ran with', () => {
    const info = mapper.info()
    expect(info?.harness).toBe('claude-code')
    expect(info?.harnessVersion).toBe('2.1.228')
    expect(info?.tools).toContain('Read')
    // MCP server status comes free from the CLI — useful for connection health.
    expect(info?.mcpServers.every((s) => typeof s.status === 'string')).toBe(true)
  })

  it('reports token usage as harness-reported, not estimated', () => {
    // The first usage.updated rides in on rate_limit_event, before any tokens are
    // spent — the settled totals arrive with the result message.
    const usages = events.filter((e) => e.type === 'usage.updated')
    expect(usages.length).toBeGreaterThanOrEqual(2)

    const settled = usages.at(-1)
    expect(settled?.type).toBe('usage.updated')
    if (settled?.type === 'usage.updated') {
      expect(settled.data.estimate).toBe(false)
      expect(settled.data.tokensOut).toBeGreaterThan(0)
      expect(settled.data.tokensCacheRead).toBeGreaterThan(0)
      // Window state learned earlier must still be attached, so a consumer only
      // ever needs the latest usage event to know both numbers and window.
      expect(settled.data.window?.type).toBe('five_hour')
    }
    expect(mapper.usage().usdEst).toBeGreaterThan(0)
  })

  it('starts with zero tokens rather than inventing them', () => {
    const first = events.find((e) => e.type === 'usage.updated')
    if (first?.type === 'usage.updated') {
      expect(first.data.tokensOut).toBe(0)
      expect(first.data.window).toBeDefined()
    }
  })

  it('surfaces the authoritative seat window from rate_limit_event', () => {
    const withWindow = events.find((e) => e.type === 'usage.updated' && e.data.window !== undefined)
    expect(withWindow, 'expected window state from rate_limit_event').toBeDefined()
    if (withWindow?.type === 'usage.updated' && withWindow.data.window) {
      expect(withWindow.data.window.type).toBe('five_hour')
      expect(withWindow.data.window.status).toBe('allowed')
      // Unix seconds converted to ISO, because the canonical schema is ISO-only.
      expect(withWindow.data.window.resetsAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    }
  })

  it('does not invent a rate_limited event while the window is allowed', () => {
    expect(types).not.toContain('rate_limited')
  })
})

describe('claude-code fixture: partial message deltas', () => {
  const { events, mapper } = replay('partial-deltas.ndjson')

  it('recognises every message the CLI emitted', () => {
    expect(mapper.unmapped).toEqual([])
  })

  it('turns text deltas into assistant.delta', () => {
    const deltas = events.filter((e) => e.type === 'assistant.delta')
    expect(deltas.length).toBeGreaterThan(0)
    const text = deltas.map((e) => (e.type === 'assistant.delta' ? e.data.text : '')).join('')
    expect(text).toContain('ok')
  })

  it('still emits the settled assistant.message alongside the deltas', () => {
    // Deltas drive the live feed; the settled message is what the log keeps.
    expect(events.some((e) => e.type === 'assistant.message')).toBe(true)
  })

  it('ignores stream bookkeeping without reporting it as drift', () => {
    expect(mapper.unmapped).toEqual([])
    expect(events.every((e) => e.type !== 'error')).toBe(true)
  })
})

describe('drift detection', () => {
  it('reports an unknown top-level type', () => {
    const mapper = new ClaudeCodeMapper()
    expect(mapper.push({ type: 'brand_new_thing', payload: 1 })).toEqual([])
    expect(mapper.unmapped).toContain('brand_new_thing')
  })

  it('reports an unknown content_block_delta kind', () => {
    const mapper = new ClaudeCodeMapper()
    mapper.push({
      type: 'stream_event',
      event: { type: 'content_block_delta', delta: { type: 'audio_delta' } },
    })
    expect(mapper.unmapped).toContain('content_block_delta:audio_delta')
  })

  it('reports an unknown rate limit status rather than guessing', () => {
    const mapper = new ClaudeCodeMapper()
    const out = mapper.push({
      type: 'rate_limit_event',
      rate_limit_info: { status: 'mystery', resetsAt: 1786566600, rateLimitType: 'five_hour' },
    })
    expect(out).toEqual([])
    expect(mapper.unmapped).toContain('rate_limit_status:mystery')
  })

  it('emits rate_limited when the window is actually rejected', () => {
    const mapper = new ClaudeCodeMapper()
    const out = mapper.push({
      type: 'rate_limit_event',
      rate_limit_info: {
        status: 'rejected',
        resetsAt: Math.floor(Date.now() / 1000) + 600,
        rateLimitType: 'five_hour',
        isUsingOverage: false,
      },
    })
    const limited = out.find((e) => e.type === 'rate_limited')
    expect(limited).toBeDefined()
    if (limited?.type === 'rate_limited') {
      expect(limited.data.scope).toBe('seat')
      expect(limited.data.retryAfterSec).toBeGreaterThan(0)
    }
  })

  it('tolerates unknown extra fields on known messages', () => {
    const mapper = new ClaudeCodeMapper()
    const out = mapper.push({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'hi' }], brand_new_field: true },
      another_new_field: 1,
    })
    expect(out.map((e) => e.type)).toEqual(['assistant.message'])
    expect(mapper.unmapped).toEqual([])
  })
})

describe('invocation', () => {
  it('enables streaming stdin so steering is possible at all', () => {
    const args = buildClaudeArgs({ stage: 'code', prompt: 'go', cwd: '/work' })
    expect(args).toEqual(
      expect.arrayContaining(['-p', '--output-format', 'stream-json', '--input-format']),
    )
    expect(args.join(' ')).toContain('--input-format stream-json')
  })

  it('passes the gateway config, model, resume token and turn cap', () => {
    const args = buildClaudeArgs({
      stage: 'review',
      prompt: 'review',
      cwd: '/work',
      mcpConfigPath: '/work/.mcp.json',
      model: 'claude-opus-5',
      resume: 'sess_1',
      maxTurns: 12,
    })
    const line = args.join(' ')
    expect(line).toContain('--mcp-config /work/.mcp.json')
    expect(line).toContain('--model claude-opus-5')
    expect(line).toContain('--resume sess_1')
    expect(line).toContain('--max-turns 12')
  })

  it('encodes a steer as one NDJSON user message', () => {
    const encoded = encodeUserMessage('also check auth')
    expect(encoded.endsWith('\n')).toBe(true)
    expect(JSON.parse(encoded)).toEqual({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'also check auth' }] },
    })
  })
})
