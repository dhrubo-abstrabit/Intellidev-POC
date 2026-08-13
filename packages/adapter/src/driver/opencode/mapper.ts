import { preview, type EventBodyInput } from '@intellidev/shared'
import { isGatewayToolName } from '../../gateway/naming.js'
import type { RawMapper, SessionInfo, UsageSnapshot } from '../types.js'
import {
  IGNORED_PARTS,
  OC_PART,
  OcEnvelope,
  OcTokens,
  STEP_FINISH_STOP,
  WRITE_TOOLS,
} from './messages.js'

/**
 * Maps raw opencode output to the canonical vocabulary.
 *
 * A third wire format again — neither content blocks (Claude Code) nor typed items
 * (Codex), but message *parts* in a `{type, part}` envelope.
 *
 * Three behaviours that a capture revealed and a schema would not have:
 *
 *  - `text` parts arrive **complete**, not as deltas. `run --format json` has no
 *    token stream at all, so `streamingDeltas` is false for this path even though
 *    the server's SSE stream does have deltas.
 *  - A `tool` part is normally emitted **once, already completed**, so one raw event
 *    becomes both `tool.call` and `tool.result`.
 *  - There is **no file-change event**. A write is a tool call, so `file.changed` is
 *    derived from the tool name plus its input path.
 *
 * Discrimination is on `part.type`, not the envelope's `type`, because the latter is
 * a snake_case echo and the part kind is what the schema actually defines.
 */
export class OpencodeMapper implements RawMapper {
  private readonly unmappedSeen = new Set<string>()
  private readonly openCalls = new Map<string, string>()
  private turn = 0
  private sessionId: string | null = null
  private agent: string | undefined
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
    return this.sessionId
  }

  usage(): UsageSnapshot {
    return { ...this.usageSnapshot }
  }

  info(): SessionInfo | null {
    if (!this.sessionId) return null
    return {
      sessionId: this.sessionId,
      harness: 'opencode',
      // The run stream names neither the model nor the tool inventory.
      tools: [],
      mcpServers: [],
      skills: [],
      capabilities: this.agent ? [`agent:${this.agent}`] : [],
    }
  }

  push(raw: unknown): EventBodyInput[] {
    const parsed = OcEnvelope.safeParse(raw)
    if (!parsed.success) {
      this.unmappedSeen.add('<unparsed envelope>')
      return []
    }
    const { sessionID, part } = parsed.data
    if (sessionID) this.sessionId = sessionID

    if (!part) {
      // An envelope with no part carries nothing, but a new envelope-only event type
      // is worth surfacing.
      this.unmappedSeen.add(`envelope:${parsed.data.type}`)
      return []
    }

    const props = part as Record<string, unknown>
    const kind = String(props['type'])

    switch (kind) {
      case OC_PART.text: {
        // Synthetic and ignored parts are opencode's own bookkeeping, not model output.
        if (props['synthetic'] === true || props['ignored'] === true) return []
        const text = props['text']
        if (typeof text !== 'string' || !text) return []
        const p = preview(text)
        return [{ type: 'assistant.message', data: { text: p.text, truncated: p.truncated } }]
      }

      case OC_PART.reasoning:
        return [{ type: 'thinking.started', data: {} }]

      case OC_PART.tool:
        return this.onTool(props)

      case OC_PART.stepFinish:
        return this.onStepFinish(props)

      case OC_PART.patch:
        return this.onPatch(props)

      case OC_PART.retry: {
        const attempt = props['attempt']
        return [
          {
            type: 'error',
            data: {
              code: 'harness_retry',
              message: preview(props['error'] ?? `retry ${String(attempt ?? '')}`).text,
              retryable: true,
            },
          },
        ]
      }

      default:
        if (!IGNORED_PARTS.has(kind)) this.unmappedSeen.add(`part:${kind}`)
        return []
    }
  }

  private onTool(props: Record<string, unknown>): EventBodyInput[] {
    const callID = typeof props['callID'] === 'string' ? props['callID'] : null
    if (!callID) return []
    const name = typeof props['tool'] === 'string' ? props['tool'] : 'unknown'
    // The gateway already logged this call under its own name; emitting it again would
    // double-count every gateway tool in the log and in the PR body.
    if (isGatewayToolName(name)) return []
    const state = (props['state'] ?? {}) as Record<string, unknown>
    const status = String(state['status'] ?? 'completed')

    const out: EventBodyInput[] = []
    // A tool part usually arrives already completed, so the call has to be
    // synthesised or the UI would show a result with nothing to attach it to.
    if (!this.openCalls.has(callID)) {
      this.openCalls.set(callID, name)
      out.push({
        type: 'tool.call',
        data: { id: callID, name, inputPreview: preview(state['input']).text },
      })
    }

    if (status === 'pending' || status === 'running') return out

    const ok = status === 'completed'
    if (!ok && status !== 'error') this.unmappedSeen.add(`tool_status:${status}`)
    const payload = ok ? state['output'] : state['error']
    const p = preview(payload)
    out.push({
      type: 'tool.result',
      data: { id: callID, name, ok, resultPreview: p.text, truncated: p.truncated },
    })
    this.openCalls.delete(callID)

    if (ok && WRITE_TOOLS.has(name)) {
      const path = filePathOf(state['input'])
      if (path) out.push({ type: 'file.changed', data: { path, change: 'modified' } })
    }
    return out
  }

  private onStepFinish(props: Record<string, unknown>): EventBodyInput[] {
    const tokens = OcTokens.safeParse(props['tokens'] ?? {})
    if (tokens.success) {
      // A prompt can run several steps, so these accumulate rather than replace.
      const t = tokens.data
      this.usageSnapshot.tokensIn += t.input
      this.usageSnapshot.tokensOut += t.output + t.reasoning
      this.usageSnapshot.tokensCacheRead += t.cache.read
      this.usageSnapshot.tokensCacheWrite += t.cache.write
    }
    const cost = props['cost']
    if (typeof cost === 'number') {
      // Present on every step, but 0 on free models — a real field with a real zero,
      // not a missing one.
      this.usageSnapshot.usdEst = (this.usageSnapshot.usdEst ?? 0) + cost
    }

    const out: EventBodyInput[] = [
      {
        type: 'usage.updated',
        data: {
          tokensIn: this.usageSnapshot.tokensIn,
          tokensOut: this.usageSnapshot.tokensOut,
          tokensCacheRead: this.usageSnapshot.tokensCacheRead,
          tokensCacheWrite: this.usageSnapshot.tokensCacheWrite,
          ...(this.usageSnapshot.usdEst !== undefined ? { usdEst: this.usageSnapshot.usdEst } : {}),
          estimate: false,
        },
      },
    ]

    // `tool-calls` means another step follows. Only `stop` ends the turn, and only
    // there can a steer safely land.
    if (String(props['reason'] ?? '') === STEP_FINISH_STOP) {
      out.push({ type: 'turn.boundary', data: { turn: this.turn++ } })
    }
    return out
  }

  private onPatch(props: Record<string, unknown>): EventBodyInput[] {
    const files = props['files']
    if (!Array.isArray(files)) return []
    const out: EventBodyInput[] = []
    for (const file of files) {
      if (typeof file === 'string' && file) {
        out.push({ type: 'file.changed', data: { path: file, change: 'modified' } })
      }
    }
    return out
  }
}

function filePathOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  for (const key of ['filePath', 'file_path', 'path']) {
    if (key in input) {
      const value = (input as Record<string, unknown>)[key]
      if (typeof value === 'string' && value) return value
    }
  }
  return null
}
