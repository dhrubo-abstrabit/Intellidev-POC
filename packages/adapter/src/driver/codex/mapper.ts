import { preview, type EventBodyInput } from '@intellidev/shared'
import type { RawMapper, SessionInfo, UsageSnapshot } from '../types.js'
import {
  COMMAND_TOOL_NAME,
  CxItemEvent,
  CxThreadStarted,
  CxTurnCompleted,
  CxTurnFailed,
  FILE_CHANGE_KINDS,
  IGNORED_ITEM_TYPES,
  IGNORED_TYPES,
} from './messages.js'

/**
 * Maps raw Codex output to the canonical vocabulary.
 *
 * Same contract as the Claude Code mapper and deliberately no shared base class:
 * the two wire formats have nothing in common structurally, and an abstraction
 * over two dissimilar shapes would cost more than it saves. What they share is the
 * *output* type, which is the only thing anything downstream depends on.
 */
export class CodexMapper implements RawMapper {
  private readonly unmappedSeen = new Set<string>()
  /** Commands seen at item.started, so item.completed can be paired with one. */
  private readonly openItems = new Map<string, { name: string; input: string }>()
  private turn = 0
  private threadId: string | null = null
  private usageSnapshot: UsageSnapshot = {
    tokensIn: 0,
    tokensOut: 0,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
  }

  get unmapped(): readonly string[] {
    return [...this.unmappedSeen]
  }

  get resumeToken(): string | null {
    return this.threadId
  }

  usage(): UsageSnapshot {
    return { ...this.usageSnapshot }
  }

  info(): SessionInfo | null {
    if (!this.threadId) return null
    // Codex reports far less about itself than Claude Code does: no tool list, no
    // MCP server statuses, no version in the stream. Left empty rather than faked.
    return {
      sessionId: this.threadId,
      harness: 'codex',
      tools: [],
      mcpServers: [],
      skills: [],
      capabilities: [],
    }
  }

  push(raw: unknown): EventBodyInput[] {
    if (typeof raw !== 'object' || raw === null || !('type' in raw)) {
      this.unmappedSeen.add('<no type field>')
      return []
    }
    const type = String((raw as { type: unknown }).type)

    switch (type) {
      case 'thread.started': {
        const parsed = CxThreadStarted.safeParse(raw)
        if (parsed.success) this.threadId = parsed.data.thread_id
        return []
      }
      case 'item.started':
      case 'item.completed':
        return this.onItem(raw, type === 'item.completed')
      case 'turn.completed':
        return this.onTurnCompleted(raw)
      case 'turn.failed':
        return this.onTurnFailed(raw)
      default:
        if (!IGNORED_TYPES.has(type)) this.unmappedSeen.add(type)
        return []
    }
  }

  private onItem(raw: unknown, completed: boolean): EventBodyInput[] {
    const parsed = CxItemEvent.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('item<unparsed>')
      return []
    }
    const item = parsed.data.item as Record<string, unknown>
    const itemType = String(item['type'])
    const id = typeof item['id'] === 'string' ? item['id'] : `item_${this.openItems.size}`

    switch (itemType) {
      case 'command_execution': {
        const command = String(item['command'] ?? '')
        if (!completed) {
          this.openItems.set(id, { name: COMMAND_TOOL_NAME, input: command })
          return [
            {
              type: 'tool.call',
              data: { id, name: COMMAND_TOOL_NAME, inputPreview: preview(command).text },
            },
          ]
        }
        // Codex can complete an item we never saw start; synthesise the call so a
        // result is never orphaned in the UI.
        const out: EventBodyInput[] = []
        if (!this.openItems.has(id)) {
          out.push({
            type: 'tool.call',
            data: { id, name: COMMAND_TOOL_NAME, inputPreview: preview(command).text },
          })
        }
        this.openItems.delete(id)
        const exitCode = item['exit_code']
        const output = String(item['aggregated_output'] ?? '')
        const p = preview(output)
        out.push({
          type: 'tool.result',
          data: {
            id,
            name: COMMAND_TOOL_NAME,
            ok: exitCode === 0,
            resultPreview: p.text,
            truncated: p.truncated,
          },
        })
        return out
      }

      case 'agent_message': {
        // Only the completed item carries text.
        if (!completed) return []
        const text = String(item['text'] ?? '')
        if (!text) return []
        const p = preview(text)
        return [{ type: 'assistant.message', data: { text: p.text, truncated: p.truncated } }]
      }

      case 'file_change': {
        if (!completed) return []
        const changes = Array.isArray(item['changes']) ? item['changes'] : []
        const out: EventBodyInput[] = []
        for (const change of changes) {
          if (typeof change !== 'object' || change === null) continue
          const record = change as Record<string, unknown>
          const path = typeof record['path'] === 'string' ? record['path'] : null
          if (!path) continue
          const kind = String(record['kind'] ?? '')
          const mapped = FILE_CHANGE_KINDS[kind]
          if (!mapped) {
            this.unmappedSeen.add(`file_change_kind:${kind}`)
            continue
          }
          out.push({ type: 'file.changed', data: { path, change: mapped } })
        }
        return out
      }

      case 'reasoning':
        return completed ? [] : [{ type: 'thinking.started', data: {} }]

      case 'mcp_tool_call': {
        const server = typeof item['server'] === 'string' ? item['server'] : undefined
        const name = typeof item['tool'] === 'string' ? item['tool'] : 'mcp_tool'
        if (!completed) {
          this.openItems.set(id, { name, input: '' })
          return [
            {
              type: 'tool.call',
              data: {
                id,
                name,
                ...(server ? { server } : {}),
                inputPreview: preview(item['arguments']).text,
              },
            },
          ]
        }
        this.openItems.delete(id)
        const failed = item['error'] !== undefined && item['error'] !== null
        const p = preview(item['result'])
        return [
          {
            type: 'tool.result',
            data: { id, name, ok: !failed, resultPreview: p.text, truncated: p.truncated },
          },
        ]
      }

      default:
        if (!IGNORED_ITEM_TYPES.has(itemType)) this.unmappedSeen.add(`item:${itemType}`)
        return []
    }
  }

  private onTurnCompleted(raw: unknown): EventBodyInput[] {
    const parsed = CxTurnCompleted.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('turn.completed<unparsed>')
      return []
    }
    const out: EventBodyInput[] = []
    const usage = parsed.data.usage
    if (usage) {
      this.usageSnapshot = {
        tokensIn: usage.input_tokens,
        tokensOut: usage.output_tokens,
        tokensCacheRead: usage.cached_input_tokens,
        tokensCacheWrite: usage.cache_write_input_tokens,
      }
      out.push({
        type: 'usage.updated',
        data: {
          ...this.usageSnapshot,
          // Tokens are reported. Cost is not — Codex publishes no currency figure,
          // so `usdEst` stays absent rather than being invented from a rate card.
          estimate: false,
        },
      })
    }
    out.push({ type: 'turn.boundary', data: { turn: this.turn++ } })
    return out
  }

  private onTurnFailed(raw: unknown): EventBodyInput[] {
    const parsed = CxTurnFailed.safeParse(raw)
    const detail = parsed.success ? preview(parsed.data.error).text : 'turn failed'
    return [
      { type: 'error', data: { code: 'turn_failed', message: detail, retryable: true } },
      { type: 'turn.boundary', data: { turn: this.turn++ } },
    ]
  }
}
