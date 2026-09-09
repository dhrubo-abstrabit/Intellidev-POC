import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { AgentEvent, type EventBodyInput } from '@intellidev/shared'
import { describe, expect, it } from 'vitest'
import {
  CODEX_CAPABILITIES,
  buildCodexArgs,
  sandboxForToolMode,
} from '../src/driver/codex/driver.js'
import { CodexMapper } from '../src/driver/codex/mapper.js'
import { NdjsonBuffer } from '../src/driver/ndjson.js'

/** Replays real `codex-cli 0.147.0` output. No subprocess, no quota. */

const FIXTURES = join(import.meta.dirname, 'fixtures', 'codex')

function replay(fixture: string): { events: EventBodyInput[]; mapper: CodexMapper } {
  const mapper = new CodexMapper()
  const buffer = new NdjsonBuffer()
  const events: EventBodyInput[] = []
  for (const parsed of buffer.push(readFileSync(join(FIXTURES, fixture), 'utf8'))) {
    events.push(...mapper.push(parsed))
  }
  for (const parsed of buffer.flush()) events.push(...mapper.push(parsed))
  expect(buffer.malformed).toEqual([])
  return { events, mapper }
}

describe('codex fixture: shell tool use', () => {
  const { events, mapper } = replay('read-tool.jsonl')

  it('recognises every event the CLI emitted', () => {
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

  it('maps command_execution onto the same tool.call shape as a Bash call', () => {
    const call = events.find((e) => e.type === 'tool.call')
    expect(call?.type).toBe('tool.call')
    if (call?.type === 'tool.call') {
      // One UI renders both harnesses only because the names agree.
      expect(call.data.name).toBe('Bash')
      expect(call.data.inputPreview).toContain('version.ts')
    }
  })

  it('reports command success from the exit code', () => {
    const result = events.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') {
      expect(result.data.ok).toBe(true)
      expect(result.data.resultPreview).toContain('1.2.3')
    }
  })

  it('pairs each result with a preceding call of the same id', () => {
    const results = events.filter((e) => e.type === 'tool.result')
    expect(results.length).toBeGreaterThan(0)
    for (const [i, event] of events.entries()) {
      if (event.type !== 'tool.result') continue
      const callIndex = events.findIndex(
        (e) => e.type === 'tool.call' && e.data.id === event.data.id,
      )
      expect(callIndex).toBeGreaterThanOrEqual(0)
      expect(callIndex).toBeLessThan(i)
    }
  })

  it('captures the thread id as the resume token', () => {
    expect(mapper.resumeToken).toBe('019ff6c8-0000-7000-8000-000000000001')
  })

  it('reports tokens but no cost, because Codex publishes none', () => {
    const usage = events.findLast((e) => e.type === 'usage.updated')
    expect(usage?.type).toBe('usage.updated')
    if (usage?.type === 'usage.updated') {
      expect(usage.data.tokensIn).toBeGreaterThan(0)
      expect(usage.data.tokensCacheRead).toBeGreaterThan(0)
      expect(usage.data.estimate).toBe(false)
      // Inventing a figure from a rate card would be worse than having none.
      expect(usage.data.usdEst).toBeUndefined()
      expect(usage.data.window).toBeUndefined()
    }
  })

  it('ends with a single turn boundary', () => {
    expect(events.filter((e) => e.type === 'turn.boundary')).toHaveLength(1)
    expect(events.at(-1)?.type).toBe('turn.boundary')
  })

  it('reports far less about itself than Claude Code, and does not fake it', () => {
    const info = mapper.info()
    expect(info?.harness).toBe('codex')
    expect(info?.tools).toEqual([])
    expect(info?.mcpServers).toEqual([])
  })
})

describe('codex fixture: file write', () => {
  const { events, mapper } = replay('file-write.jsonl')

  it('recognises every event the CLI emitted', () => {
    expect(mapper.unmapped).toEqual([])
  })

  it('turns a file_change item into file.changed with a mapped kind', () => {
    const changed = events.filter((e) => e.type === 'file.changed')
    expect(changed).toHaveLength(1)
    if (changed[0]?.type === 'file.changed') {
      expect(changed[0].data.change).toBe('added')
      expect(changed[0].data.path).toContain('bump.ts')
    }
  })

  it('emits file.changed once, on completion, not on start', () => {
    // The item appears twice in the stream; a doubled event would double-count in
    // the diff summary the PR body is built from.
    expect(events.filter((e) => e.type === 'file.changed')).toHaveLength(1)
  })
})

describe('codex drift detection', () => {
  it('reports an unknown top-level type', () => {
    const mapper = new CodexMapper()
    expect(mapper.push({ type: 'thread.forked' })).toEqual([])
    expect(mapper.unmapped).toContain('thread.forked')
  })

  it('reports an unknown item type', () => {
    const mapper = new CodexMapper()
    mapper.push({ type: 'item.completed', item: { id: 'i1', type: 'brand_new_item' } })
    expect(mapper.unmapped).toContain('item:brand_new_item')
  })

  it('reports an unknown file change kind rather than guessing', () => {
    const mapper = new CodexMapper()
    const out = mapper.push({
      type: 'item.completed',
      item: { id: 'i1', type: 'file_change', changes: [{ path: '/a.ts', kind: 'teleported' }] },
    })
    expect(out).toEqual([])
    expect(mapper.unmapped).toContain('file_change_kind:teleported')
  })

  it('synthesises a call when only the completion is seen', () => {
    const mapper = new CodexMapper()
    const out = mapper.push({
      type: 'item.completed',
      item: { id: 'orphan', type: 'command_execution', command: 'ls', exit_code: 0 },
    })
    expect(out.map((e) => e.type)).toEqual(['tool.call', 'tool.result'])
  })

  it('marks a non-zero exit as a failed tool result', () => {
    const mapper = new CodexMapper()
    const out = mapper.push({
      type: 'item.completed',
      item: { id: 'i1', type: 'command_execution', command: 'false', exit_code: 1 },
    })
    const result = out.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') expect(result.data.ok).toBe(false)
  })

  it('turns a failed turn into an error plus a boundary', () => {
    const mapper = new CodexMapper()
    const out = mapper.push({ type: 'turn.failed', error: { message: 'model unavailable' } })
    expect(out.map((e) => e.type)).toEqual(['error', 'turn.boundary'])
  })

  it('tolerates unknown extra fields on known events', () => {
    const mapper = new CodexMapper()
    mapper.push({ type: 'thread.started', thread_id: 't1', brand_new: true })
    expect(mapper.unmapped).toEqual([])
    expect(mapper.resumeToken).toBe('t1')
  })
})

describe('codex invocation', () => {
  const base = { stage: 'code' as const, prompt: 'do the thing', cwd: '/work/run-1' }

  it('runs exec with json output in the worktree', () => {
    const args = buildCodexArgs(base)
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args.join(' ')).toContain('-C /work/run-1')
    // Not every worktree is a git repo at the moment codex starts.
    expect(args).toContain('--skip-git-repo-check')
    expect(args.at(-1)).toBe('do the thing')
  })

  it('sandboxes by stage when it is the only sandbox there is', () => {
    // On a developer's own machine this is what stands between a model and their home
    // directory, so it stays exactly as it was.
    expect(buildCodexArgs({ ...base, toolsMode: 'full' })).toContain('workspace-write')
    expect(buildCodexArgs({ ...base, toolsMode: 'read_only' })).toContain('read-only')
  })

  it('asks for no sandbox when the container is already one', () => {
    /**
     * FOUND BY RUNNING IT ON FARGATE. Codex sandboxes shell commands with Linux namespaces, and
     * Fargate's kernel has unprivileged user namespaces disabled — so every command failed with
     * "the shell sandbox can't start", the model gave up, and the run reached the pr stage
     * having changed nothing at all.
     *
     * The container is the boundary: ephemeral, no host mounts, its own network rules. Codex's
     * own help says the bypass flag is for "environments that are externally sandboxed".
     */
    const args = buildCodexArgs({ ...base, toolsMode: 'full' }, { externallySandboxed: true })
    expect(args).toContain('--dangerously-bypass-approvals-and-sandbox')
    // And not both: passing a sandbox mode alongside it is contradictory.
    expect(args).not.toContain('-s')

    // An explicit sandbox still wins, because a caller setting one means it.
    const explicit = buildCodexArgs(base, {
      externallySandboxed: true,
      sandbox: 'read-only',
    })
    expect(explicit).toContain('read-only')
    expect(explicit).not.toContain('--dangerously-bypass-approvals-and-sandbox')
  })

  it('puts resume as a subcommand, not a flag', () => {
    const args = buildCodexArgs({ ...base, resume: 'thread_9' })
    expect(args.slice(0, 4)).toEqual(['exec', 'resume', 'thread_9', '--json'])
  })

  it('prefixes a system append onto the prompt, since there is nowhere else', () => {
    const args = buildCodexArgs({ ...base, systemAppend: 'You are reviewing.' })
    expect(args.at(-1)).toBe('You are reviewing.\n\ndo the thing')
  })

  it('translates our tool policy into a sandbox mode', () => {
    expect(sandboxForToolMode('none')).toBe('read-only')
    expect(sandboxForToolMode('read_only')).toBe('read-only')
    expect(sandboxForToolMode('full')).toBe('workspace-write')
    expect(buildCodexArgs(base, { sandbox: 'read-only' }).join(' ')).toContain('-s read-only')
  })

  it('passes an output schema when a predicate gate needs structured output', () => {
    const args = buildCodexArgs(base, { outputSchemaPath: '/opt/project/review.schema.json' })
    expect(args.join(' ')).toContain('--output-schema /opt/project/review.schema.json')
  })
})

describe('codex capabilities', () => {
  it('declares no mid-run steering, because exec has no stdin channel', () => {
    expect(CODEX_CAPABILITIES.midRunSteering).toBe(false)
    expect(CODEX_CAPABILITIES.streamingDeltas).toBe(false)
  })

  it('declares the things it has that Claude Code does not', () => {
    expect(CODEX_CAPABILITIES.nativeStructuredOutput).toBe(true)
  })

  it('declares no window or cost reporting', () => {
    expect(CODEX_CAPABILITIES.reportsWindowState).toBe(false)
    expect(CODEX_CAPABILITIES.reportsCost).toBe(false)
  })
})
