import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEvent, type EventBodyInput } from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import { OPENCODE_CAPABILITIES, buildOpencodeArgs } from '../src/driver/opencode/driver.js'
import { OpencodeMapper } from '../src/driver/opencode/mapper.js'
import { NdjsonBuffer } from '../src/driver/ndjson.js'

/**
 * Replays real `opencode 1.18.16` output, captured via
 * `opencode run --format json --auto --model opencode/<free-model>`.
 *
 * The capture corrected an earlier version of this driver that had been written from
 * opencode's server-side OpenAPI schema: the server's SSE stream and the `run`
 * stream are different formats. Two of these tests exist specifically to pin the
 * differences the capture revealed.
 */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'opencode')

function replay(fixture: string): { events: EventBodyInput[]; mapper: OpencodeMapper } {
  const mapper = new OpencodeMapper()
  const buffer = new NdjsonBuffer()
  const events: EventBodyInput[] = []
  for (const raw of buffer.push(readFileSync(join(FIXTURES, fixture), 'utf8'))) {
    events.push(...mapper.push(raw))
  }
  for (const raw of buffer.flush()) events.push(...mapper.push(raw))
  expect(buffer.malformed).toEqual([])
  return { events, mapper }
}

describe('opencode fixture: read tool', () => {
  const { events, mapper } = replay('run-read-tool.jsonl')

  it('recognises every part the CLI emitted', () => {
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
      expect(parsed.success, `${body.type}: ${JSON.stringify(parsed.error?.issues)}`).toBe(true)
    }
  })

  it('emits no deltas, because run sends complete text parts', () => {
    // This is the correction. The server stream has deltas; this one does not.
    expect(events.some((e) => e.type === 'assistant.delta')).toBe(false)
    expect(events.some((e) => e.type === 'assistant.message')).toBe(true)
    expect(OPENCODE_CAPABILITIES.streamingDeltas).toBe(false)
  })

  it('synthesises the call from an already-completed tool part', () => {
    // opencode emits one tool part with status completed, so a single raw event has
    // to become both halves or the UI shows an orphaned result.
    const calls = events.filter((e) => e.type === 'tool.call')
    const results = events.filter((e) => e.type === 'tool.result')
    expect(calls).toHaveLength(1)
    expect(results).toHaveLength(1)
    if (calls[0]?.type === 'tool.call') expect(calls[0].data.name).toBe('read')
    if (results[0]?.type === 'tool.result') {
      expect(results[0].data.name).toBe('read')
      expect(results[0].data.ok).toBe(true)
      expect(results[0].data.resultPreview).toContain('1.2.3')
    }
    expect(events.indexOf(calls[0]!)).toBeLessThan(events.indexOf(results[0]!))
  })

  it('accumulates tokens across steps and reports cost as a real field', () => {
    const usage = events.findLast((e) => e.type === 'usage.updated')
    if (usage?.type === 'usage.updated') {
      // Two step-finish parts in this fixture: 8352 + 8583 input.
      expect(usage.data.tokensIn).toBe(16935)
      expect(usage.data.estimate).toBe(false)
      // Free model, so a real zero rather than a missing figure.
      expect(usage.data.usdEst).toBe(0)
      expect(usage.data.window).toBeUndefined()
    }
  })

  it('ends the turn only on reason=stop, not on every step', () => {
    // The first step finishes with reason `tool-calls` and must not end the turn.
    const boundaries = events.filter((e) => e.type === 'turn.boundary')
    expect(boundaries).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('turn.boundary')
  })

  it('captures the session id as the resume token', () => {
    expect(mapper.resumeToken).toBe('ses_00000000000000000000000001')
  })
})

describe('opencode fixture: file write', () => {
  const { events, mapper } = replay('run-file-write.jsonl')

  it('recognises every part the CLI emitted', () => {
    expect(mapper.unmapped).toEqual([])
  })

  it('derives file.changed from the write tool, since there is no file event', () => {
    const changed = events.filter((e) => e.type === 'file.changed')
    expect(changed).toHaveLength(1)
    if (changed[0]?.type === 'file.changed') {
      expect(changed[0].data.path).toContain('bump2.ts')
    }
  })

  it('does not claim a file changed for a read', () => {
    const reads = events.filter((e) => e.type === 'tool.result' && e.data.name === 'read')
    expect(reads.length).toBeGreaterThan(0)
    expect(events.filter((e) => e.type === 'file.changed')).toHaveLength(1)
  })
})

describe('opencode part kinds not present in the fixtures', () => {
  // Mapped from the spec's twelve-member Part union so a real one is handled rather
  // than reported as drift. Not capture-verified.
  const wrap = (part: Record<string, unknown>) => ({
    type: 'x',
    sessionID: 'ses_1',
    part: { ...part },
  })

  it('treats a reasoning part as thinking', () => {
    const mapper = new OpencodeMapper()
    expect(mapper.push(wrap({ type: 'reasoning', text: 'hmm' })).map((e) => e.type)).toEqual([
      'thinking.started',
    ])
  })

  it('maps a patch part to one file.changed per file', () => {
    const mapper = new OpencodeMapper()
    const out = mapper.push(wrap({ type: 'patch', hash: 'abc', files: ['/a.ts', '/b.ts'] }))
    expect(out).toHaveLength(2)
    expect(mapper.unmapped).toEqual([])
  })

  it('reports a retry as a retryable error', () => {
    const mapper = new OpencodeMapper()
    const out = mapper.push(wrap({ type: 'retry', attempt: 2, error: { message: 'overloaded' } }))
    const error = out.find((e) => e.type === 'error')
    if (error?.type === 'error') expect(error.data.retryable).toBe(true)
  })

  it('ignores bookkeeping parts without calling them drift', () => {
    const mapper = new OpencodeMapper()
    for (const type of ['step-start', 'snapshot', 'file', 'agent', 'subtask', 'compaction']) {
      expect(mapper.push(wrap({ type }))).toEqual([])
    }
    expect(mapper.unmapped).toEqual([])
  })

  it('skips synthetic text, which is opencode bookkeeping not model output', () => {
    const mapper = new OpencodeMapper()
    expect(mapper.push(wrap({ type: 'text', text: 'x', synthetic: true }))).toEqual([])
    expect(mapper.push(wrap({ type: 'text', text: 'x', ignored: true }))).toEqual([])
  })
})

describe('opencode drift detection', () => {
  it('reports a thirteenth part kind', () => {
    const mapper = new OpencodeMapper()
    mapper.push({ type: 'x', part: { type: 'hologram' } })
    expect(mapper.unmapped).toContain('part:hologram')
  })

  it('reports an envelope with no part', () => {
    const mapper = new OpencodeMapper()
    mapper.push({ type: 'session_summary' })
    expect(mapper.unmapped).toContain('envelope:session_summary')
  })

  it('reports an unknown tool status rather than guessing success', () => {
    const mapper = new OpencodeMapper()
    const out = mapper.push({
      type: 'tool_use',
      part: { type: 'tool', callID: 'c1', tool: 'bash', state: { status: 'cancelled' } },
    })
    const result = out.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') expect(result.data.ok).toBe(false)
    expect(mapper.unmapped).toContain('tool_status:cancelled')
  })

  it('marks an errored tool as not ok', () => {
    const mapper = new OpencodeMapper()
    const out = mapper.push({
      type: 'tool_use',
      part: {
        type: 'tool',
        callID: 'c1',
        tool: 'write',
        state: { status: 'error', error: 'denied', input: { filePath: '/a.ts' } },
      },
    })
    const result = out.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') expect(result.data.ok).toBe(false)
    // A failed write did not change a file.
    expect(out.some((e) => e.type === 'file.changed')).toBe(false)
  })

  it('tolerates unknown extra fields', () => {
    const mapper = new OpencodeMapper()
    mapper.push({ type: 'text', brand_new: 1, part: { type: 'text', text: 'hi', extra: true } })
    expect(mapper.unmapped).toEqual([])
  })
})

describe('opencode invocation', () => {
  const base = { stage: 'code' as const, prompt: 'do the thing', cwd: '/work/run-1' }

  it('runs with json output in the worktree', () => {
    const args = buildOpencodeArgs(base)
    expect(args.slice(0, 3)).toEqual(['run', '--format', 'json'])
    expect(args.join(' ')).toContain('--dir /work/run-1')
    expect(args.at(-1)).toBe('do the thing')
  })

  it('auto-approves permissions, because nothing can answer a prompt unattended', () => {
    expect(buildOpencodeArgs(base)).toContain('--auto')
    expect(buildOpencodeArgs(base, { auto: false })).not.toContain('--auto')
  })

  it('resumes by session flag, unlike codex which uses a subcommand', () => {
    expect(buildOpencodeArgs({ ...base, resume: 'ses_9' }).join(' ')).toContain('--session ses_9')
  })

  it('passes provider-qualified model, agent and variant', () => {
    const line = buildOpencodeArgs(
      { ...base, model: 'anthropic/claude-opus-5' },
      { agent: 'build', variant: 'high' },
    ).join(' ')
    expect(line).toContain('--model anthropic/claude-opus-5')
    expect(line).toContain('--agent build')
    expect(line).toContain('--variant high')
  })

  it('prefixes a system append, since run has no system-prompt flag', () => {
    expect(buildOpencodeArgs({ ...base, systemAppend: 'You are reviewing.' }).at(-1)).toBe(
      'You are reviewing.\n\ndo the thing',
    )
  })
})

describe('opencode capabilities', () => {
  it('matches what the capture showed', () => {
    expect(OPENCODE_CAPABILITIES).toEqual({
      midRunSteering: false,
      streamingDeltas: false,
      nativeStructuredOutput: false,
      reportsWindowState: false,
      reportsCost: true,
      nativeSkills: true,
      perToolPermissions: true,
    })
  })
})

describe('opencode fatal session errors', () => {
  /**
   * REGRESSION, from a real run. A denied tool call makes `opencode run` exit 1 with an EMPTY
   * stderr and report the reason as a top-level envelope on stdout. That envelope carries no
   * `part`, so it was treated as "carries nothing" and dropped — leaving a `harness.crashed`
   * event whose `stderrPreview` was empty and a run nobody could diagnose.
   */
  it('maps a top-level error envelope instead of dropping it', () => {
    const mapper = new OpencodeMapper()
    const events = mapper.push({
      type: 'error',
      timestamp: 1787048916953,
      sessionID: 'ses_feb958b31ffe1VqaH87mn3l0X3',
      error: {
        name: 'UnknownError',
        data: { message: 'Unexpected server error. Check server logs for details.' },
      },
    })

    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      type: 'error',
      data: { code: 'harness_error', retryable: false },
    })
    const [event] = events
    if (event?.type !== 'error') throw new Error('expected an error event')
    expect(event.data.message).toContain('UnknownError')
    expect(event.data.message).toContain('Unexpected server error')
  })

  it('does not report it as an unmapped envelope', () => {
    const mapper = new OpencodeMapper()
    mapper.push({ type: 'error', error: { name: 'UnknownError' } })
    expect(mapper.unmapped).not.toContain('envelope:error')
  })
})
