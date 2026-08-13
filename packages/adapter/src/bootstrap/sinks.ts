import { appendFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { AgentEvent } from '@intellidev/shared'

/**
 * Where numbered events go.
 *
 * In production this is the outbound WebSocket. Locally it is a file and a human-readable
 * console line, which is enough to watch a whole run and to diff two runs afterwards.
 *
 * Note what is **not** here: stdout. In a real run stdout belongs to the MCP gateway's
 * stdio transport, so writing an event there would corrupt the protocol. Local logging
 * goes to stderr for exactly that reason.
 */
export type EventSink = (event: AgentEvent) => void

/** Append every event as JSONL. The file is the run's audit trail locally. */
export function fileSink(path: string): EventSink {
  let chain: Promise<unknown> = mkdir(dirname(path), { recursive: true })
  return (event) => {
    // Serialised through one promise chain so lines cannot interleave.
    chain = chain.then(() => appendFile(path, `${JSON.stringify(event)}\n`)).catch(() => undefined)
  }
}

/** One readable line per event, on stderr. */
export function consoleSink(opts: { verbose?: boolean } = {}): EventSink {
  return (event) => {
    const line = describe(event)
    if (line === null && !opts.verbose) return
    process.stderr.write(
      `${String(event.seq).padStart(4, '0')} ${event.stage ?? '·'} ${line ?? event.type}\n`,
    )
  }
}

export function multiSink(...sinks: EventSink[]): EventSink {
  return (event) => {
    for (const sink of sinks) sink(event)
  }
}

/**
 * A one-line summary per event type.
 *
 * Returns null for the high-volume ones — deltas would drown the console, and they are in
 * the JSONL file if anyone wants them.
 */
function describe(event: AgentEvent): string | null {
  switch (event.type) {
    case 'assistant.delta':
      return null
    case 'run.provisioning':
      return 'provisioning'
    case 'cache.restored':
      return `cache ${event.data.hit ? 'hit' : 'miss'} (${event.data.durationMs}ms)`
    case 'worktree.ready':
      return `worktree on ${event.data.branch} from ${event.data.baseSha.slice(0, 8)}`
    case 'run.started':
      return `started with ${event.data.harness}`
    case 'stage.entered':
      return `── stage attempt ${event.data.attempt}`
    case 'stage.exited':
      return `   ${event.data.outcome} (${Math.round(event.data.durationMs / 1000)}s)`
    case 'assistant.message':
      return `say: ${firstLine(event.data.text)}`
    case 'thinking.started':
      return 'thinking'
    case 'tool.call':
      return `→ ${event.data.name}${event.data.server ? ` @${event.data.server}` : ''} ${firstLine(event.data.inputPreview ?? '')}`
    case 'tool.result':
      return `← ${event.data.name} ${event.data.ok ? 'ok' : 'FAILED'}`
    case 'tool.denied':
      return `⊘ ${event.data.name} denied: ${event.data.reason}`
    case 'file.changed':
      return `${event.data.change} ${event.data.path}`
    case 'diff.produced':
      return `diff: ${event.data.filesChanged} files +${event.data.insertions}/-${event.data.deletions}`
    case 'command.output':
      return null
    case 'gate.evaluated':
      return `gate ${event.data.passed ? 'PASS' : 'FAIL'} ${event.data.label ?? event.data.kind}`
    case 'gate.blocked':
      return `blocked (${event.data.attemptsUsed}/${event.data.attemptsAllowed}) → ${event.data.nextStage ?? 'fail'}`
    case 'git.branch_created':
      return `branch ${event.data.branch}`
    case 'git.committed':
      return `commit ${event.data.sha.slice(0, 8)} (${event.data.filesChanged} files)`
    case 'git.pushed':
      return `pushed ${event.data.branch}`
    case 'pr.opened':
      return `PR #${event.data.number} ${event.data.url}`
    case 'usage.updated':
      return `usage ${event.data.tokensIn} in / ${event.data.tokensOut} out${
        event.data.usdEst !== undefined ? ` ~$${event.data.usdEst.toFixed(4)}` : ''
      }`
    case 'error':
      return `ERROR ${event.data.code}: ${firstLine(event.data.message)}`
    case 'harness.crashed':
      return `harness crashed (${event.data.exitCode ?? event.data.signal})`
    case 'rate_limited':
      return `rate limited, retry after ${event.data.retryAfterSec ?? '?'}s`
    case 'run.finished':
      return `── ${event.data.outcome}${event.data.reason ? `: ${event.data.reason}` : ''}`
    default:
      return null
  }
}

function firstLine(text: string, max = 100): string {
  const line = text.split('\n')[0] ?? ''
  return line.length > max ? `${line.slice(0, max)}…` : line
}
