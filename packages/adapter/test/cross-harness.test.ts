import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { EventBodyInput, EventType } from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import { CLAUDE_CODE_CAPABILITIES, ClaudeCodeDriver } from '../src/driver/claude-code/driver.js'
import { ClaudeCodeMapper } from '../src/driver/claude-code/mapper.js'
import { CODEX_CAPABILITIES, CodexDriver } from '../src/driver/codex/driver.js'
import { CodexMapper } from '../src/driver/codex/mapper.js'
import { NdjsonBuffer } from '../src/driver/ndjson.js'
import type { RawMapper } from '../src/driver/types.js'

/**
 * The whole point of building the second driver before anything sits on top of the
 * abstraction: both harnesses were given the same task, and downstream code must
 * not be able to tell which one ran it.
 *
 * Both fixtures are the same instruction — read `version.ts`, report the version —
 * recorded from claude-code 2.1.228 and codex-cli 0.147.0.
 */

function replay(mapper: RawMapper, path: string): EventBodyInput[] {
  const buffer = new NdjsonBuffer()
  const events: EventBodyInput[] = []
  for (const raw of buffer.push(readFileSync(path, 'utf8'))) events.push(...mapper.push(raw))
  for (const raw of buffer.flush()) events.push(...mapper.push(raw))
  return events
}

const claude = (() => {
  const mapper = new ClaudeCodeMapper()
  const events = replay(
    mapper,
    join(import.meta.dirname, 'fixtures', 'claude-code', 'tool-use.ndjson'),
  )
  return { mapper, events, types: new Set(events.map((e) => e.type)) }
})()

const codex = (() => {
  const mapper = new CodexMapper()
  const events = replay(mapper, join(import.meta.dirname, 'fixtures', 'codex', 'read-tool.jsonl'))
  return { mapper, events, types: new Set(events.map((e) => e.type)) }
})()

describe('same task, both harnesses', () => {
  /** The shape a consumer relies on regardless of harness. */
  const REQUIRED: EventType[] = [
    'tool.call',
    'tool.result',
    'assistant.message',
    'usage.updated',
    'turn.boundary',
  ]

  it.each(REQUIRED)('both produce %s', (type) => {
    expect(claude.types.has(type), `claude-code missing ${type}`).toBe(true)
    expect(codex.types.has(type), `codex missing ${type}`).toBe(true)
  })

  it('neither emits an event type the other cannot', () => {
    // Differences are allowed, but only ones the capability record explains.
    const explained = new Set<EventType>(['assistant.delta', 'thinking.started', 'rate_limited'])
    const onlyClaude = [...claude.types].filter((t) => !codex.types.has(t) && !explained.has(t))
    const onlyCodex = [...codex.types].filter((t) => !claude.types.has(t) && !explained.has(t))
    expect({ onlyClaude, onlyCodex }).toEqual({ onlyClaude: [], onlyCodex: [] })
  })

  it('both resolve a real tool name, never a placeholder', () => {
    for (const source of [claude, codex]) {
      const results = source.events.filter((e) => e.type === 'tool.result')
      expect(results.length).toBeGreaterThan(0)
      for (const result of results) {
        if (result.type === 'tool.result') expect(result.data.name).not.toBe('unknown')
      }
    }
  })

  it('both end on a turn boundary, so steering has a defined injection point', () => {
    expect(claude.events.at(-1)?.type).toBe('turn.boundary')
    expect(codex.events.at(-1)?.type).toBe('turn.boundary')
  })

  it('both surface a resume token, so a crashed stage continues', () => {
    expect(claude.mapper.resumeToken).toBeTruthy()
    expect(codex.mapper.resumeToken).toBeTruthy()
  })

  it('both report tokens as harness-reported rather than inferred', () => {
    for (const source of [claude, codex]) {
      const usage = source.events.findLast((e) => e.type === 'usage.updated')
      if (usage?.type === 'usage.updated') expect(usage.data.estimate).toBe(false)
    }
  })

  it('recognises everything both CLIs emitted', () => {
    expect(claude.mapper.unmapped).toEqual([])
    expect(codex.mapper.unmapped).toEqual([])
  })
})

describe('capability differences are declared, not hidden', () => {
  it('disagrees on steering, deltas, structured output, window and cost', () => {
    // If this table ever matches, one of the drivers is lying about a harness.
    expect(CLAUDE_CODE_CAPABILITIES).not.toEqual(CODEX_CAPABILITIES)
    expect({
      steering: [CLAUDE_CODE_CAPABILITIES.midRunSteering, CODEX_CAPABILITIES.midRunSteering],
      deltas: [CLAUDE_CODE_CAPABILITIES.streamingDeltas, CODEX_CAPABILITIES.streamingDeltas],
      schema: [
        CLAUDE_CODE_CAPABILITIES.nativeStructuredOutput,
        CODEX_CAPABILITIES.nativeStructuredOutput,
      ],
      window: [CLAUDE_CODE_CAPABILITIES.reportsWindowState, CODEX_CAPABILITIES.reportsWindowState],
      cost: [CLAUDE_CODE_CAPABILITIES.reportsCost, CODEX_CAPABILITIES.reportsCost],
    }).toEqual({
      steering: [true, false],
      deltas: [true, false],
      schema: [false, true],
      window: [true, false],
      cost: [true, false],
    })
  })

  it('only the delta-capable harness produced deltas', () => {
    expect(claude.types.has('assistant.delta')).toBe(false) // this fixture has none
    expect(codex.types.has('assistant.delta')).toBe(false)
    // The partial fixture is where claude's deltas show up; codex has no equivalent.
    const mapper = new ClaudeCodeMapper()
    const partial = replay(
      mapper,
      join(import.meta.dirname, 'fixtures', 'claude-code', 'partial-deltas.ndjson'),
    )
    expect(partial.some((e) => e.type === 'assistant.delta')).toBe(true)
  })

  it('exposes capabilities on the driver, where the stage engine can plan on them', () => {
    expect(new ClaudeCodeDriver().capabilities.midRunSteering).toBe(true)
    expect(new CodexDriver().capabilities.midRunSteering).toBe(false)
  })

  it('both drivers satisfy one id union', () => {
    expect([new ClaudeCodeDriver().id, new CodexDriver().id].sort()).toEqual([
      'claude-code',
      'codex',
    ])
  })
})
