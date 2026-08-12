import { preview, type EventBodyInput } from '@intellidev/shared'
import type { RawMapper, SessionInfo, UsageSnapshot } from '../types.js'
import { OC_EVENT, OcEnvelope, OcTokens, isIgnored } from './messages.js'

/**
 * Maps raw opencode events to the canonical vocabulary.
 *
 * Structurally a third thing again: neither content blocks (Claude Code) nor typed
 * items (Codex), but a flat event stream with a dotted `type` and a `properties`
 * payload — closest in spirit to our own event log.
 *
 * Two consequences worth knowing:
 *
 *  - A "step" is one model turn and there may be several per prompt, so cost and
 *    tokens accumulate across steps. `session.idle` is the only real end-of-turn,
 *    and therefore the only safe steering injection point.
 *  - opencode reports **cost** per step, which Codex does not. It reports no
 *    provider window state, because it is provider-agnostic by design.
 */
export class OpencodeMapper implements RawMapper {
  private readonly unmappedSeen = new Set<string>()
  private readonly openCalls = new Map<string, string>()
  private turn = 0
  private sessionId: string | null = null
  private model: string | undefined
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
      ...(this.model ? { model: this.model } : {}),
      // opencode does not enumerate its tools or MCP servers in the run stream.
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
    const { type, properties } = parsed.data
    const props = properties as Record<string, unknown>

    // Every event carries its session, so the resume token is available from the
    // first one rather than only from session.created.
    const sessionID = props['sessionID']
    if (typeof sessionID === 'string' && sessionID) this.sessionId = sessionID

    switch (type) {
      case OC_EVENT.sessionCreated:
        return []

      case OC_EVENT.textDelta: {
        const delta = props['delta']
        return typeof delta === 'string' && delta
          ? [{ type: 'assistant.delta', data: { text: delta } }]
          : []
      }

      case OC_EVENT.textEnded: {
        const text = props['text']
        if (typeof text !== 'string' || !text) return []
        const p = preview(text)
        return [{ type: 'assistant.message', data: { text: p.text, truncated: p.truncated } }]
      }

      case OC_EVENT.reasoningStarted:
        return [{ type: 'thinking.started', data: {} }]

      case OC_EVENT.toolCalled: {
        const callID = String(props['callID'] ?? '')
        const tool = String(props['tool'] ?? 'unknown')
        if (!callID) return []
        this.openCalls.set(callID, tool)
        return [
          {
            type: 'tool.call',
            data: { id: callID, name: tool, inputPreview: preview(props['input']).text },
          },
        ]
      }

      case OC_EVENT.toolSuccess:
      case OC_EVENT.toolFailed: {
        const callID = String(props['callID'] ?? '')
        if (!callID) return []
        const ok = type === OC_EVENT.toolSuccess
        const name = this.openCalls.get(callID) ?? 'unknown'
        this.openCalls.delete(callID)
        const payload = ok ? (props['structured'] ?? props['content']) : props['error']
        const p = preview(payload)
        return [
          {
            type: 'tool.result',
            data: { id: callID, name, ok, resultPreview: p.text, truncated: p.truncated },
          },
        ]
      }

      case OC_EVENT.stepStarted: {
        const model = props['model']
        if (typeof model === 'object' && model !== null) {
          const ref = model as Record<string, unknown>
          const id = ref['modelID'] ?? ref['model'] ?? ref['id']
          if (typeof id === 'string') this.model = id
        }
        if (typeof props['agent'] === 'string') this.agent = props['agent']
        return []
      }

      case OC_EVENT.stepEnded:
        return this.onStepEnded(props)

      case OC_EVENT.stepFailed:
      case OC_EVENT.sessionError: {
        const detail = preview(props['error']).text
        return [
          {
            type: 'error',
            data: { code: type, message: detail || 'session error', retryable: true },
          },
        ]
      }

      case OC_EVENT.sessionIdle:
        // The prompt is finished and the session is waiting. Several steps may have
        // run; this is the only point at which a steer can safely land.
        return [{ type: 'turn.boundary', data: { turn: this.turn++ } }]

      case OC_EVENT.fileEdited: {
        const file = props['file']
        return typeof file === 'string' && file
          ? [{ type: 'file.changed', data: { path: file, change: 'modified' } }]
          : []
      }

      default:
        if (!isIgnored(type)) this.unmappedSeen.add(type)
        return []
    }
  }

  private onStepEnded(props: Record<string, unknown>): EventBodyInput[] {
    const tokens = OcTokens.safeParse(props['tokens'] ?? {})
    if (tokens.success) {
      // Steps accumulate within one prompt, so add rather than replace.
      const t = tokens.data
      this.usageSnapshot = {
        tokensIn: this.usageSnapshot.tokensIn + t.input,
        tokensOut: this.usageSnapshot.tokensOut + t.output + t.reasoning,
        tokensCacheRead: this.usageSnapshot.tokensCacheRead + t.cache.read,
        tokensCacheWrite: this.usageSnapshot.tokensCacheWrite + t.cache.write,
        ...(this.usageSnapshot.usdEst !== undefined ? { usdEst: this.usageSnapshot.usdEst } : {}),
      }
    }
    const cost = props['cost']
    if (typeof cost === 'number') {
      this.usageSnapshot.usdEst = (this.usageSnapshot.usdEst ?? 0) + cost
    }

    return [
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
  }
}
