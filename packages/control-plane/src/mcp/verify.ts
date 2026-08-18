import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { namespacedToolName } from '@intellidev/adapter/gateway/registry'
import type { McpHealth, McpServerRecord } from './types.js'

/**
 * Connect to a server and list its tools.
 *
 * This is what makes "connected" mean something in the UI. Without it a server with a bad
 * token looks identical to a working one until a run is half an hour in, which is exactly the
 * failure the connect-once design exists to prevent.
 *
 * Tool names are reported the way the *agent* will see them, via the gateway's own
 * `namespacedToolName`, so the list in the UI matches the list in the run log rather than
 * being a second, subtly different rendering of the same thing.
 */
export async function verifyServer(
  server: McpServerRecord,
  accessToken: string | undefined,
): Promise<{ health: McpHealth; tools?: string[]; error?: string }> {
  const headers: Record<string, string> = {}
  if (accessToken) headers['authorization'] = `Bearer ${accessToken}`

  const client = new Client({ name: 'intellidev-control-plane', version: '0.0.0' })
  try {
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } }),
    )
    const listed = await client.listTools()
    return {
      health: 'ok',
      tools: listed.tools.map((tool) => namespacedToolName(server.id, tool.name)),
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    // 401 is separated from every other failure because the remedy is different: reconnect,
    // rather than check the URL or the network.
    const unauthorized = /\b401\b|unauthorized|invalid_token/i.test(message)
    return { health: unauthorized ? 'unauthorized' : 'error', error: message }
  } finally {
    await client.close().catch(() => undefined)
  }
}
