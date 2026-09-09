import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ToolServer } from '@intellidev/shared'
import type { UpstreamCaller } from './gateway.js'

/**
 * Connections to the real MCP servers a project has attached.
 *
 * One connection set per run, held by the adapter — never by a harness. That is what
 * keeps upstream credentials out of the agent's reach: the token is used here, and the
 * agent only ever sees a tool result.
 *
 * `connect` is deliberately tolerant. A project can attach several servers, and one being
 * unreachable should degrade that server rather than fail the run — unless the attachment
 * is marked `required`, which dispatch checks before we ever get here.
 */
export interface UpstreamConnectResult {
  serverId: string
  ok: boolean
  tools: Array<{ name: string; description?: string; inputSchema?: Record<string, unknown> }>
  error?: string
}

export interface UpstreamOptions {
  /** Fetched per server from the broker, so nothing long-lived is held here. */
  token?: (serverId: string) => Promise<string>
  clientName?: string
  clientVersion?: string
}

export class UpstreamPool implements UpstreamCaller {
  private readonly clients = new Map<string, Client>()

  constructor(private readonly opts: UpstreamOptions = {}) {}

  async connect(server: ToolServer): Promise<UpstreamConnectResult> {
    try {
      const client = new Client({
        name: this.opts.clientName ?? 'intellidev-gateway',
        version: this.opts.clientVersion ?? '0.0.0',
      })

      if (server.kind === 'builtin_stdio') {
        if (!server.command) throw new Error('builtin_stdio server has no command')
        await client.connect(
          new StdioClientTransport({ command: server.command, args: [...server.args] }),
        )
      } else {
        if (!server.url) throw new Error(`${server.kind} server has no url`)
        const headers: Record<string, string> = {}
        if (server.auth !== 'none' && this.opts.token) {
          // Pulled at connect time rather than held in config, so a rotated token is
          // picked up on the next run without touching the manifest.
          headers['authorization'] = `Bearer ${await this.opts.token(server.id)}`
        }
        await client.connect(
          new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
        )
      }

      this.clients.set(server.id, client)
      const listed = await client.listTools()
      return {
        serverId: server.id,
        ok: true,
        tools: listed.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          ...(tool.inputSchema ? { inputSchema: tool.inputSchema as Record<string, unknown> } : {}),
        })),
      }
    } catch (error) {
      return {
        serverId: server.id,
        ok: false,
        tools: [],
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  async call(
    serverId: string,
    remoteName: string,
    input: Record<string, unknown>,
  ): Promise<string> {
    const client = this.clients.get(serverId)
    if (!client) throw new Error(`upstream server "${serverId}" is not connected`)

    const result = await client.callTool({ name: remoteName, arguments: input })
    return flattenContent(result.content)
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.clients.values()].map((client) => client.close().catch(() => undefined)),
    )
    this.clients.clear()
  }
}

/**
 * MCP results are a content array; harnesses want text.
 *
 * Non-text blocks are described rather than dropped, so an image or resource shows up as
 * something the agent can reason about instead of vanishing.
 */
export function flattenContent(content: unknown): string {
  if (!Array.isArray(content))
    return typeof content === 'string' ? content : JSON.stringify(content)
  const parts: string[] = []
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const record = block as Record<string, unknown>
    if (record['type'] === 'text' && typeof record['text'] === 'string') {
      parts.push(record['text'])
    } else if (record['type'] === 'resource' || record['type'] === 'resource_link') {
      const uri =
        (record['resource'] as Record<string, unknown> | undefined)?.['uri'] ?? record['uri']
      parts.push(`[resource ${String(uri ?? 'unknown')}]`)
    } else {
      parts.push(`[${String(record['type'] ?? 'unknown')} content]`)
    }
  }
  return parts.join('\n')
}
