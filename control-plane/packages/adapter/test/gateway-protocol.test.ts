import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { ToolPolicy, type EventBodyInput, type StageId } from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Gateway } from '../src/gateway/gateway.js'
import { GatewayServer } from '../src/gateway/server.js'
import { ToolRegistry } from '../src/gateway/registry.js'

/**
 * Drives the gateway over the **real MCP protocol** using the SDK's in-memory transport.
 *
 * Everything else in the gateway tests exercises the logic directly; this proves the
 * transport wiring — that a client actually sees the filtered list, that JSON Schema
 * survives the round trip unchanged, and that a stale list cannot be used as a bypass.
 */

/**
 * Read the text blocks out of a tool result.
 *
 * Asserting on `JSON.stringify(result.content)` would compare against *escaped* quotes,
 * so a test looking for `"severity":"error"` fails even when the value arrived intact —
 * passing or failing for the wrong reason either way.
 *
 * Typed as `unknown` because the SDK's result is a wide union; narrowing it here would
 * couple the test to the SDK's internal shape.
 */
function text(result: unknown): string {
  const blocks = ((result as { content?: unknown }).content ?? []) as Array<{
    type: string
    text?: string
  }>
  return blocks.map((b) => b.text ?? '').join('')
}

describe('gateway over MCP', () => {
  let stage: StageId = 'code'
  let events: EventBodyInput[]
  let server: GatewayServer
  let client: Client

  // A schema with a nested shape, so passthrough is provable rather than assumed.
  const upstreamSchema = {
    type: 'object',
    required: ['query'],
    properties: {
      query: { type: 'string', description: 'Search text' },
      filters: {
        type: 'object',
        properties: { severity: { enum: ['error', 'warning'] } },
      },
    },
  }

  beforeEach(async () => {
    stage = 'code'
    events = []

    const registry = new ToolRegistry()
    registry.registerUpstream(
      'sentry',
      [{ name: 'search', description: 'Search issues', inputSchema: upstreamSchema }],
      { enabledTools: [], stages: ['code', 'test'] },
    )

    const gateway = new Gateway({
      registry,
      builtins: [
        {
          name: 'task_context',
          description: 'The task being worked on',
          inputSchema: { type: 'object', properties: {} },
          stages: [],
          handler: async () => '{"title":"Add login"}',
        },
      ],
      upstream: { call: async (_s, name, input) => `called ${name} with ${JSON.stringify(input)}` },
      stage: () => stage,
      policy: () => ToolPolicy.parse({ mode: 'full' }),
      emit: (event) => events.push(event),
    })

    server = new GatewayServer({ gateway, name: 'intellidev-test', version: '1.0.0' })
    client = new Client({ name: 'harness-under-test', version: '1.0.0' })

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    await Promise.all([
      // Reaching into the private server is acceptable here: the alternative is a real
      // stdio subprocess, which would test the OS more than the gateway.
      (server as unknown as { server: { connect(t: unknown): Promise<void> } }).server.connect(
        serverTransport,
      ),
      client.connect(clientTransport),
    ])
  })

  afterEach(async () => {
    await client.close().catch(() => undefined)
    await server.close().catch(() => undefined)
  })

  it('advertises the merged list as one server, built-ins and upstream together', async () => {
    const { tools } = await client.listTools()
    // The whole point of "connect once": a harness sees one endpoint, not N.
    expect(tools.map((t) => t.name).sort()).toEqual(['sentry__search', 'task_context'])
  })

  it('forwards an upstream JSON Schema unchanged, nesting included', async () => {
    const { tools } = await client.listTools()
    const search = tools.find((t) => t.name === 'sentry__search')
    // A schema mangled in transit is the one thing an agent cannot recover from.
    expect(search?.inputSchema).toEqual(upstreamSchema)
    expect(search?.description).toBe('Search issues')
  })

  it('calls a built-in through the protocol', async () => {
    const result = await client.callTool({ name: 'task_context', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(text(result)).toContain('Add login')
  })

  it('routes an upstream call and passes arguments through', async () => {
    const result = await client.callTool({
      name: 'sentry__search',
      arguments: { query: 'timeout', filters: { severity: 'error' } },
    })
    expect(text(result)).toContain('"severity":"error"')
    expect(events.filter((e) => e.type === 'tool.call')).toHaveLength(1)
  })

  it('drops a tool from the list once the stage no longer allows it', async () => {
    expect((await client.listTools()).tools.map((t) => t.name)).toContain('sentry__search')
    stage = 'design'
    // T7 acceptance: genuinely absent, not merely undocumented.
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(['task_context'])
  })

  it('refuses a call from a stale list rather than trusting it', async () => {
    // Simulates a harness that listed during `code` and called during `design`.
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toContain('sentry__search')

    stage = 'design'
    const result = await client.callTool({ name: 'sentry__search', arguments: { query: 'x' } })
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('not in scope')

    const denied = events.find((e) => e.type === 'tool.denied')
    if (denied?.type === 'tool.denied') expect(denied.data.reason).toBe('stage_scope')
  })

  it('reports a tool failure as content, so the turn is not aborted', async () => {
    const result = await client.callTool({ name: 'no_such_tool', arguments: {} })
    // An MCP-level error would end the turn; a message lets the agent recover.
    expect(result.isError).toBe(true)
    expect(text(result)).toContain('no such tool')
  })

  it('notifies the client when the stage changes its tool list', async () => {
    let notifications = 0
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      notifications++
    })
    server.notifyToolsChanged()
    await new Promise((resolve) => setTimeout(resolve, 50))
    // A harness that cached the previous stage's tools has to be told to re-list, or it
    // keeps offering tools the new stage removed.
    expect(notifications).toBe(1)
  })
})
