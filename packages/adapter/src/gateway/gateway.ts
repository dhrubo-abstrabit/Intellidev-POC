import { preview, type EventBodyInput, type StageId, type ToolPolicy } from '@intellidev/shared'
import type { BuiltinTool } from './builtins.js'
import { ToolRegistry, type RegisteredTool, type Resolution } from './registry.js'

/**
 * The dispatch half of the gateway: what happens when a harness calls a tool.
 *
 * Kept separate from the MCP transport wiring so the behaviour that matters — filtering,
 * refusal, event emission, routing upstream — is testable without a protocol handshake.
 *
 * Every call passes through here, which is the point: it means `tool.call` and
 * `tool.result` events exist for all three harnesses regardless of how faithfully each
 * one reports its own tool use, and a refused call is recorded rather than silent.
 */

export interface UpstreamCaller {
  call(serverId: string, remoteName: string, input: Record<string, unknown>): Promise<string>
}

export interface GatewayOptions {
  registry: ToolRegistry
  builtins: readonly BuiltinTool[]
  upstream: UpstreamCaller
  stage: () => StageId
  policy: () => ToolPolicy
  emit: (event: EventBodyInput) => void
  /** Monotonic ids so a call and its result can be paired in the log. */
  nextCallId?: () => string
}

export interface ToolCallOutcome {
  ok: boolean
  content: string
}

export class Gateway {
  private readonly byName = new Map<string, BuiltinTool>()
  private counter = 0

  constructor(private readonly opts: GatewayOptions) {
    for (const tool of opts.builtins) {
      this.byName.set(tool.name, tool)
      opts.registry.registerBuiltin({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
        stages: tool.stages,
      })
    }
  }

  /** What the current stage may see. Recomputed per call, since the stage moves. */
  listTools(): RegisteredTool[] {
    return this.opts.registry.visibleTo(this.opts.stage(), this.opts.policy())
  }

  private id(): string {
    return this.opts.nextCallId?.() ?? `gw_${++this.counter}`
  }

  async callTool(name: string, input: Record<string, unknown>): Promise<ToolCallOutcome> {
    const stage = this.opts.stage()
    const resolution: Resolution = this.opts.registry.resolve(name, stage, this.opts.policy())
    const callId = this.id()

    if (!resolution.allowed) {
      // Refused calls are logged, not swallowed. A silently-missing tool is one of the
      // hardest things to debug from a transcript.
      this.opts.emit({
        type: 'tool.denied',
        data: { id: callId, name, reason: resolution.reason, detail: resolution.detail },
      })
      return { ok: false, content: `denied: ${resolution.detail}` }
    }

    const tool = resolution.tool
    const server = tool.origin.kind === 'upstream' ? tool.origin.serverId : undefined
    this.opts.emit({
      type: 'tool.call',
      data: {
        id: callId,
        name,
        ...(server ? { server } : {}),
        inputPreview: preview(input).text,
      },
    })

    const startedAt = Date.now()
    try {
      const content =
        tool.origin.kind === 'builtin'
          ? await this.callBuiltin(tool.name, input)
          : await this.opts.upstream.call(tool.origin.serverId, tool.origin.remoteName, input)

      const p = preview(content)
      this.opts.emit({
        type: 'tool.result',
        data: {
          id: callId,
          name,
          ok: true,
          durationMs: Date.now() - startedAt,
          resultPreview: p.text,
          truncated: p.truncated,
        },
      })
      return { ok: true, content }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.opts.emit({
        type: 'tool.result',
        data: {
          id: callId,
          name,
          ok: false,
          durationMs: Date.now() - startedAt,
          resultPreview: preview(message).text,
        },
      })
      // Returned as content rather than thrown: an MCP error aborts the turn, while a
      // failure message lets the agent read it and try something else.
      return { ok: false, content: `error: ${message}` }
    }
  }

  private async callBuiltin(name: string, input: Record<string, unknown>): Promise<string> {
    const tool = this.byName.get(name)
    if (!tool) throw new Error(`builtin "${name}" is registered but has no handler`)
    return tool.handler(input)
  }
}
