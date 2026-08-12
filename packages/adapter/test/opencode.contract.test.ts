import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEvent, type EventBodyInput } from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import { OPENCODE_CAPABILITIES, buildOpencodeArgs } from '../src/driver/opencode/driver.js'
import { OpencodeMapper } from '../src/driver/opencode/mapper.js'
import { NdjsonBuffer } from '../src/driver/ndjson.js'

/**
 * PROVENANCE — this fixture is **spec-derived, not runtime-recorded**.
 *
 * Every event shape here comes from opencode 1.18.16's own OpenAPI document
 * (`opencode serve` → `GET /doc`), which is authoritative for the server's event
 * stream. It is not a capture of `opencode run --format json`, because this machine
 * has no provider credentials (`opencode providers list` → 0 credentials).
 *
 * That is a weaker guarantee than the Claude Code and Codex fixtures, which are
 * real captures. Re-record this against a live run once a provider is authenticated;
 * the drift assertions below are what will surface any difference.
 */

const FIXTURE = join(import.meta.dirname, 'fixtures', 'opencode', 'spec-derived-run.jsonl')

function replay(): { events: EventBodyInput[]; mapper: OpencodeMapper } {
  const mapper = new OpencodeMapper()
  const buffer = new NdjsonBuffer()
  const events: EventBodyInput[] = []
  for (const raw of buffer.push(readFileSync(FIXTURE, 'utf8'))) events.push(...mapper.push(raw))
  for (const raw of buffer.flush()) events.push(...mapper.push(raw))
  expect(buffer.malformed).toEqual([])
  return { events, mapper }
}

describe('opencode spec-derived stream', () => {
  const { events, mapper } = replay()

  it('recognises every event, including the ones it deliberately ignores', () => {
    expect(mapper.unmapped).toEqual([])
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

  it('streams text deltas and then the settled message', () => {
    const deltas = events.filter((e) => e.type === 'assistant.delta')
    expect(deltas.map((e) => (e.type === 'assistant.delta' ? e.data.text : '')).join('')).toBe(
      '1.2.3',
    )
    expect(events.some((e) => e.type === 'assistant.message')).toBe(true)
  })

  it('pairs a tool call with a named result', () => {
    const call = events.find((e) => e.type === 'tool.call')
    const result = events.find((e) => e.type === 'tool.result')
    if (call?.type === 'tool.call') expect(call.data.name).toBe('read')
    if (result?.type === 'tool.result') {
      // The result event carries only a callID; the mapper resolves the name.
      expect(result.data.name).toBe('read')
      expect(result.data.ok).toBe(true)
    }
  })

  it('reports both tokens and cost, which Codex cannot', () => {
    const usage = events.findLast((e) => e.type === 'usage.updated')
    if (usage?.type === 'usage.updated') {
      expect(usage.data.tokensIn).toBe(812)
      // reasoning tokens fold into output, since the canonical schema has no
      // separate bucket for them.
      expect(usage.data.tokensOut).toBe(42)
      expect(usage.data.tokensCacheRead).toBe(19165)
      expect(usage.data.usdEst).toBeCloseTo(0.0142)
      expect(usage.data.estimate).toBe(false)
      // Provider-agnostic, so no single rolling window exists to report.
      expect(usage.data.window).toBeUndefined()
    }
  })

  it('treats session.idle as the turn boundary, not step.ended', () => {
    // Several steps can run per prompt, so a step ending is not a safe injection
    // point. Only idle is.
    const boundaries = events.filter((e) => e.type === 'turn.boundary')
    expect(boundaries).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('turn.boundary')
  })

  it('maps file.edited to file.changed', () => {
    const changed = events.find((e) => e.type === 'file.changed')
    if (changed?.type === 'file.changed') expect(changed.data.path).toContain('version.ts')
  })

  it('captures the session id as the resume token', () => {
    expect(mapper.resumeToken).toBe('ses_0000000000000001')
  })

  it('records the model and agent it ran with', () => {
    const info = mapper.info()
    expect(info?.harness).toBe('opencode')
    expect(info?.model).toBe('claude-opus-5')
    expect(info?.capabilities).toContain('agent:build')
  })
})

describe('opencode noise handling', () => {
  it('ignores TUI, LSP and installer chatter without calling it drift', () => {
    const mapper = new OpencodeMapper()
    for (const type of [
      'tui.toast.show',
      'lsp.updated',
      'pty.created',
      'installation.updated',
      'permission.asked',
      'message.part.delta',
    ]) {
      expect(mapper.push({ id: 'e', type, properties: {} })).toEqual([])
    }
    expect(mapper.unmapped).toEqual([])
  })

  it('reports a genuinely unknown event as drift', () => {
    const mapper = new OpencodeMapper()
    mapper.push({ id: 'e', type: 'session.next.hologram.rendered', properties: {} })
    expect(mapper.unmapped).toContain('session.next.hologram.rendered')
  })

  it('turns a failed step into a retryable error', () => {
    const mapper = new OpencodeMapper()
    const out = mapper.push({
      id: 'e',
      type: 'session.next.step.failed',
      properties: { sessionID: 's', assistantMessageID: 'm', error: { name: 'APIError' } },
    })
    const error = out.find((e) => e.type === 'error')
    if (error?.type === 'error') expect(error.data.retryable).toBe(true)
  })

  it('marks a failed tool result as not ok', () => {
    const mapper = new OpencodeMapper()
    mapper.push({
      id: 'e',
      type: 'session.next.tool.called',
      properties: { callID: 'c1', tool: 'bash', input: {} },
    })
    const out = mapper.push({
      id: 'e',
      type: 'session.next.tool.failed',
      properties: { callID: 'c1', error: { message: 'nope' } },
    })
    const result = out.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') {
      expect(result.data.ok).toBe(false)
      expect(result.data.name).toBe('bash')
    }
  })

  it('accumulates cost and tokens across multiple steps in one prompt', () => {
    const mapper = new OpencodeMapper()
    const step = (cost: number) => ({
      id: 'e',
      type: 'session.next.step.ended',
      properties: {
        cost,
        tokens: { input: 10, output: 5, reasoning: 0, cache: { read: 1, write: 2 } },
      },
    })
    mapper.push(step(0.01))
    mapper.push(step(0.02))
    const usage = mapper.usage()
    expect(usage.tokensIn).toBe(20)
    expect(usage.usdEst).toBeCloseTo(0.03)
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
    const args = buildOpencodeArgs({ ...base, resume: 'ses_9' })
    expect(args.join(' ')).toContain('--session ses_9')
  })

  it('passes provider-qualified model, agent and variant', () => {
    const args = buildOpencodeArgs(
      { ...base, model: 'anthropic/claude-opus-5' },
      {
        agent: 'build',
        variant: 'high',
      },
    )
    const line = args.join(' ')
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
  it('has deltas and cost but no mid-run steering or window state', () => {
    expect(OPENCODE_CAPABILITIES).toEqual({
      midRunSteering: false,
      streamingDeltas: true,
      nativeStructuredOutput: false,
      reportsWindowState: false,
      reportsCost: true,
    })
  })
})
