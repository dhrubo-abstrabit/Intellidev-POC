import { preview, type EventBodyInput } from '@intellidev/shared'
import type { RawMapper, SessionInfo, UsageSnapshot } from '../types.js'
import {
  CcAssistant,
  CcRateLimitEvent,
  CcResult,
  CcStreamEvent,
  CcSystemInit,
  CcUser,
  IGNORED_STREAM_EVENTS,
  IGNORED_TYPES,
  WRITE_TOOLS,
} from './messages.js'

const WINDOW_STATUSES = new Set(['allowed', 'allowed_warning', 'rejected'])

/**
 * Maps raw Claude Code output to the canonical vocabulary.
 *
 * Deliberately free of I/O so it can be driven from recorded fixtures — the
 * contract test replays real CLI output with no subprocess and no quota spend.
 * Stateful only where the wire format forces it: tool results arrive with an id
 * and no name, so the pending-call table is what lets us report `tool.result`
 * with the tool's name.
 */
export class ClaudeCodeMapper implements RawMapper {
  private readonly pendingTools = new Map<string, { name: string; input: unknown }>()
  private readonly unmappedSeen = new Set<string>()
  private turn = 0
  private sessionInfo: SessionInfo | null = null
  private usageSnapshot: UsageSnapshot = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
  }
  private session: string | null = null

  get unmapped(): readonly string[] {
    return [...this.unmappedSeen]
  }

  get resumeToken(): string | null {
    return this.session
  }

  usage(): UsageSnapshot {
    return { ...this.usageSnapshot }
  }

  info(): SessionInfo | null {
    return this.sessionInfo
  }

  push(raw: unknown): EventBodyInput[] {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      this.unmappedSeen.add('<no type field>')
      return []
    }
    const type = String((raw as { type: unknown }).type)

    switch (type) {
      case 'system':
        return this.onSystem(raw)
      case 'assistant':
        return this.onAssistant(raw)
      case 'user':
        return this.onUser(raw)
      case 'result':
        return this.onResult(raw)
      case 'rate_limit_event':
        return this.onRateLimit(raw)
      case 'stream_event':
        return this.onStreamEvent(raw)
      default:
        if (!IGNORED_TYPES.has(type)) this.unmappedSeen.add(type)
        return []
    }
  }

  private onSystem(raw: unknown): EventBodyInput[] {
    const parsed = CcSystemInit.safeParse(raw)
    // A non-init `system` message carries nothing we consume.
    if (!parsed.success) return []
    const m = parsed.data
    this.session = m.session_id
    this.sessionInfo = {
      sessionId: m.session_id,
      harness: 'claude-code',
      harnessVersion: m.claude_code_version,
      model: m.model,
      tools: m.tools,
      mcpServers: m.mcp_servers.map((s) => ({ name: s.name, status: s.status })),
      skills: m.skills,
      capabilities: m.capabilities,
    }
    return []
  }

  private onAssistant(raw: unknown): EventBodyInput[] {
    const parsed = CcAssistant.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('assistant<unparsed>')
      return []
    }
    const out: EventBodyInput[] = []
    if (parsed.data.session_id) this.session = parsed.data.session_id

    for (const block of parsed.data.message.content) {
      switch (block.type) {
        case 'text': {
          const text = 'text' in block ? String(block.text) : ''
          if (!text) break
          const p = preview(text)
          out.push({ type: 'assistant.message', data: { text: p.text, truncated: p.truncated } })
          break
        }
        case 'thinking':
          out.push({ type: 'thinking.started', data: {} })
          break
        case 'tool_use': {
          if (!('id' in block) || !('name' in block)) break
          const id = String(block.id)
          const name = String(block.name)
          const input = 'input' in block ? block.input : undefined
          this.pendingTools.set(id, { name, input })
          const p = preview(input ?? {})
          out.push({
            type: 'tool.call',
            data: { id, name, inputPreview: p.text },
          })
          break
        }
        default:
          break
      }
    }

    const usage = parsed.data.message.usage
    if (usage) {
      // Per-request counts, not cumulative — accumulate them ourselves.
      this.usageSnapshot = {
        ...this.usageSnapshot,
        tokensIn: this.usageSnapshot.tokensIn + usage.input_tokens,
        tokensOut: this.usageSnapshot.tokensOut + usage.output_tokens,
        tokensCacheRead: this.usageSnapshot.tokensCacheRead + usage.cache_read_input_tokens,
        tokensCacheWrite: this.usageSnapshot.tokensCacheWrite + usage.cache_creation_input_tokens,
      }
    }
    return out
  }

  private onUser(raw: unknown): EventBodyInput[] {
    const parsed = CcUser.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('user<unparsed>')
      return []
    }
    const out: EventBodyInput[] = []
    for (const block of parsed.data.message.content) {
      if (block.type !== 'tool_result' || !('tool_use_id' in block)) continue
      const id = String(block.tool_use_id)
      const pending = this.pendingTools.get(id)
      const name = pending?.name ?? 'unknown'
      const isError = 'is_error' in block ? Boolean(block.is_error) : false
      const p = preview('content' in block ? block.content : undefined)
      out.push({
        type: 'tool.result',
        data: { id, name, ok: !isError, resultPreview: p.text, truncated: p.truncated },
      })

      // A successful write tool is the only reliable signal that a file moved.
      if (!isError && WRITE_TOOLS.has(name)) {
        const path = filePathOf(pending?.input)
        if (path) out.push({ type: 'file.changed', data: { path, change: 'modified' } })
      }
      this.pendingTools.delete(id)
    }
    return out
  }

  private onResult(raw: unknown): EventBodyInput[] {
    const parsed = CcResult.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('result<unparsed>')
      return []
    }
    const m = parsed.data
    if (m.session_id) this.session = m.session_id

    const out: EventBodyInput[] = []
    if (m.usage) {
      // Totals for the whole invocation supersede our running sum.
      this.usageSnapshot = {
        ...this.usageSnapshot,
        tokensIn: m.usage.input_tokens,
        tokensOut: m.usage.output_tokens,
        tokensCacheRead: m.usage.cache_read_input_tokens,
        tokensCacheWrite: m.usage.cache_creation_input_tokens,
        usdEst: m.total_cost_usd ?? this.usageSnapshot.usdEst,
      }
      out.push({
        type: 'usage.updated',
        data: {
          tokensIn: this.usageSnapshot.tokensIn,
          tokensOut: this.usageSnapshot.tokensOut,
          tokensCacheRead: this.usageSnapshot.tokensCacheRead,
          tokensCacheWrite: this.usageSnapshot.tokensCacheWrite,
          usdEst: this.usageSnapshot.usdEst,
          // Reported by the harness, not inferred.
          estimate: false,
          ...(this.usageSnapshot.window ? { window: this.usageSnapshot.window } : {}),
        },
      })
    }

    if (m.is_error) {
      out.push({
        type: 'error',
        data: {
          code: m.subtype ?? 'result_error',
          message: preview(m.stop_reason ?? 'harness reported an error result').text,
          retryable: false,
        },
      })
    }

    // The CLI is now waiting for input, which is the only safe injection point.
    out.push({ type: 'turn.boundary', data: { turn: this.turn++ } })
    return out
  }

  private onRateLimit(raw: unknown): EventBodyInput[] {
    const parsed = CcRateLimitEvent.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('rate_limit_event<unparsed>')
      return []
    }
    const info = parsed.data.rate_limit_info
    if (!WINDOW_STATUSES.has(info.status)) {
      // An unknown status is drift worth surfacing, not a value to guess at.
      this.unmappedSeen.add(`rate_limit_status:${info.status}`)
      return []
    }
    const window = {
      type: info.rateLimitType,
      resetsAt: new Date(info.resetsAt * 1000).toISOString(),
      status: info.status as 'allowed' | 'allowed_warning' | 'rejected',
      usingOverage: info.isUsingOverage,
    }
    this.usageSnapshot = { ...this.usageSnapshot, window }

    const out: EventBodyInput[] = [
      {
        type: 'usage.updated',
        data: {
          tokensIn: this.usageSnapshot.tokensIn,
          tokensOut: this.usageSnapshot.tokensOut,
          tokensCacheRead: this.usageSnapshot.tokensCacheRead,
          tokensCacheWrite: this.usageSnapshot.tokensCacheWrite,
          estimate: false,
          window,
        },
      },
    ]
    if (window.status === 'rejected') {
      const retryAfterSec = Math.max(0, Math.round(info.resetsAt - Date.now() / 1000))
      out.push({ type: 'rate_limited', data: { scope: 'seat', retryAfterSec } })
    }
    return out
  }

  private onStreamEvent(raw: unknown): EventBodyInput[] {
    const parsed = CcStreamEvent.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('stream_event<unparsed>')
      return []
    }
    const event = parsed.data.event as Record<string, unknown>
    const kind = String(event['type'])

    if (kind === 'content_block_delta') {
      const delta = event['delta']
      if (typeof delta === 'object' && delta !== null && 'type' in delta) {
        const deltaType = String((delta as { type: unknown }).type)
        if (deltaType === 'text_delta' && 'text' in delta) {
          const text = String((delta as { text: unknown }).text)
          return text ? [{ type: 'assistant.delta', data: { text } }] : []
        }
        if (deltaType === 'thinking_delta') return []
        this.unmappedSeen.add(`content_block_delta:${deltaType}`)
      }
      return []
    }

    if (kind === 'content_block_start') {
      const block = event['content_block']
      if (typeof block === 'object' && block !== null && 'type' in block) {
        if (String((block as { type: unknown }).type) === 'thinking') {
          return [{ type: 'thinking.started', data: {} }]
        }
      }
      return []
    }

    if (!IGNORED_STREAM_EVENTS.has(kind)) this.unmappedSeen.add(`stream_event:${kind}`)
    return []
  }
}

/** Best-effort file path from a write tool's input. */
function filePathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  for (const key of ['file_path', 'notebook_path', 'path']) {
    if (key in input) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return null
}
