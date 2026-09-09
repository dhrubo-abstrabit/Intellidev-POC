import { chmod, mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildClaudeArgs, ClaudeCodeDriver } from '../src/driver/claude-code/driver.js'
import { codexSandboxFor } from '../src/driver/codex/driver.js'

/**
 * A stand-in for the CLI that reproduces the behaviour that mattered: it emits a turn's worth of
 * stream-json, then **keeps running and waits for more input**, exactly as `claude` does when its
 * stdin is a stream. A fake that exited on its own would pass whether or not the driver closed
 * stdin, which is the whole thing under test.
 */
async function fakeClaude(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'intellidev-fake-claude-'))
  const path = join(dir, 'claude')
  await writeFile(
    path,
    [
      '#!/usr/bin/env node',
      // Announce a session, then a result — the terminal message for one turn.
      `process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's1', tools: [], mcp_servers: [] }) + '\\n')`,
      `process.stdout.write(JSON.stringify({ type: 'assistant', message: { id: 'm1', role: 'assistant', model: 'test', content: [{ type: 'text', text: 'a plan' }], stop_reason: 'end_turn', usage: { input_tokens: 1, output_tokens: 1 } } }) + '\\n')`,
      `process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, duration_ms: 1, num_turns: 1, session_id: 's1', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')`,
      // Then behave like the real CLI: stay alive until stdin closes.
      `process.stdin.resume()`,
      `process.stdin.on('end', () => process.exit(0))`,
    ].join('\n'),
    'utf8',
  )
  await chmod(path, 0o755)
  return path
}

describe('claude-code driver lifecycle', () => {
  /**
   * REGRESSION. Streaming stdin is what makes mid-run steering possible, but it also means the
   * CLI waits for another message after a turn rather than exiting. Nothing closed stdin, so the
   * process never exited, the event queue never closed with it, and a stage hung until its
   * timeout with a finished plan already sitting in the log.
   */
  it('closes stdin when the turn ends, so the stage can finish', async () => {
    const driver = new ClaudeCodeDriver({ binary: await fakeClaude() })
    const session = await driver.start({
      stage: 'design',
      prompt: 'plan it',
      cwd: process.cwd(),
    })

    const seen: string[] = []
    // If stdin were left open this loop would never end, so the test would time out rather than
    // fail — which is itself the signal.
    for await (const event of session.events) seen.push(event.type)
    const exit = await session.done()

    expect(seen).toContain('assistant.message')
    expect(seen).toContain('turn.boundary')
    expect(exit.exitCode).toBe(0)
  }, 20_000)

  it('reports the session id so a later stage can resume', async () => {
    const driver = new ClaudeCodeDriver({ binary: await fakeClaude() })
    const session = await driver.start({ stage: 'design', prompt: 'plan it', cwd: process.cwd() })
    for await (const _event of session.events) {
      // drain
    }
    await session.done()
    expect(session.resumeToken).toBe('s1')
  }, 20_000)
})

describe('the stage policy reaches the harness', () => {
  /**
   * REGRESSION. Nothing passed a permission mode, so the CLI used its `default` mode: every write
   * needed a human to approve it, and a headless run has none. The `code` stage spent twenty
   * thousand output tokens proving the directory was writable while the permission prompt was the
   * thing refusing it.
   */
  it('asks for acceptEdits when the stage may edit', () => {
    const args = buildClaudeArgs({
      stage: 'code',
      prompt: 'do it',
      cwd: '/work/x',
      toolsMode: 'full',
    })
    expect(args).toContain('--permission-mode')
    expect(args[args.indexOf('--permission-mode') + 1]).toBe('acceptEdits')
  })

  it('uses plan mode for a read-only stage, so a plan cannot edit', () => {
    for (const mode of ['read_only', 'none', undefined] as const) {
      const args = buildClaudeArgs({
        stage: 'design',
        prompt: 'plan it',
        cwd: '/work/x',
        ...(mode ? { toolsMode: mode } : {}),
      })
      expect(args[args.indexOf('--permission-mode') + 1], `mode ${mode}`).toBe('plan')
    }
  })

  it('maps the same policy onto codex sandboxing', () => {
    expect(codexSandboxFor('full')).toBe('workspace-write')
    expect(codexSandboxFor('read_only')).toBe('read-only')
    expect(codexSandboxFor(undefined)).toBe('read-only')
  })
})
