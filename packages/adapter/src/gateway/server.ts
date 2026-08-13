import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Gateway } from './gateway.js'

/**
 * MCP transport wiring — the one entry every harness config points at.
 *
 * Uses the low-level `Server` with raw request handlers rather than the higher-level
 * `McpServer.registerTool`, deliberately: `registerTool` takes a Zod shape, while a
 * **proxy** already holds JSON Schema from each upstream server's own `tools/list`.
 * Converting JSON Schema to Zod and back would lose fidelity in exactly the field an
 * agent relies on to call a tool correctly, so the schemas are forwarded unchanged.
 *
 * Thin on purpose: filtering, refusal and event emission all live in `Gateway`, which is
 * testable without a protocol handshake. This file is what would change if the SDK did.
 */
export interface GatewayServerOptions {
  gateway: Gateway
  name?: string
  version?: string
}

export class GatewayServer {
  private readonly server: Server

  constructor(private readonly opts: GatewayServerOptions) {
    this.server = new Server(
      { name: opts.name ?? 'intellidev', version: opts.version ?? '0.0.0' },
      { capabilities: { tools: { listChanged: true } } },
    )

    // Computed per request, not cached: the stage moves during a run, and a list built
    // for `design` must not still be answering once `code` has started.
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.opts.gateway.listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object' },
      })),
    }))

    this.server.setRequestHandler(CallToolRequestSchema, async (request) => {
      // Re-checked here as well as at list time: a harness may hold a stale list, and a
      // stale list must not become a bypass.
      const outcome = await this.opts.gateway.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      )
      return {
        content: [{ type: 'text' as const, text: outcome.content }],
        ...(outcome.ok ? {} : { isError: true }),
      }
    })
  }

  /**
   * Tell the client its tool list changed.
   *
   * Called when a stage boundary is crossed, so a harness that cached the previous
   * stage's tools re-lists instead of offering ones the new stage removed.
   */
  notifyToolsChanged(): void {
    void this.server.sendToolListChanged()
  }

  async start(): Promise<void> {
    await this.server.connect(new StdioServerTransport())
  }

  async close(): Promise<void> {
    await this.server.close()
  }
}
