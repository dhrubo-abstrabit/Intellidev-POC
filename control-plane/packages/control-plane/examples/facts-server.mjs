/**
 * A fixture MCP server, for validating the gateway and the credential path locally.
 *
 * It exists to answer one question that no unit test can: does a harness inside the
 * container reach a real MCP server through the adapter's gateway, with a token the agent
 * never sees? So it does two things deliberately:
 *
 *  - **Rejects any request without the right bearer token** with 401. If the broker path
 *    is broken the run fails loudly at connect time rather than quietly listing no tools.
 *  - **Returns a value that appears nowhere else** — no model could produce
 *    `fly-io-sydney-42` by guessing. Finding that string in the committed diff is proof the
 *    whole chain ran, rather than proof that a tool was merely listed.
 *
 * Run it on the host. The container reaches it at `host.docker.internal`.
 */
import { createServer } from 'node:http'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const PORT = Number(process.env.PORT ?? 4100)
const TOKEN = process.env.FACTS_TOKEN ?? 's3cret-fixture-token'
const SECRET_FACT = 'fly-io-sydney-42'

const TOOLS = [
  {
    name: 'deployment_target',
    description:
      'The deployment target for this project. Call this rather than guessing; the value is not in the repo.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]

function buildServer() {
  const server = new Server(
    { name: 'facts-fixture', version: '0.0.0' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== 'deployment_target') {
      throw new Error(`no such tool: ${request.params.name}`)
    }
    console.log(`[facts] tools/call deployment_target -> ${SECRET_FACT}`)
    return { content: [{ type: 'text', text: SECRET_FACT }] }
  })
  return server
}

const http = createServer(async (req, res) => {
  if (!req.url?.startsWith('/mcp')) {
    res.writeHead(404).end('not found')
    return
  }

  // Checked before anything else: an unauthenticated caller should learn nothing about the
  // tools, which is the property the gateway is supposed to preserve on the agent's behalf.
  if (req.headers.authorization !== `Bearer ${TOKEN}`) {
    console.log(`[facts] 401 — authorization was ${req.headers.authorization ?? '(absent)'}`)
    res.writeHead(401, { 'content-type': 'application/json' }).end(
      JSON.stringify({ error: 'bad or missing bearer token' }),
    )
    return
  }

  // Stateless: a fresh server per request, so there is no session to keep alive and no
  // state to get stale between runs.
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })
  res.on('close', () => void transport.close())
  await buildServer().connect(transport)

  let body = ''
  for await (const chunk of req) body += chunk
  await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined)
})

http.listen(PORT, '0.0.0.0', () => {
  console.log(`[facts] MCP fixture on http://0.0.0.0:${PORT}/mcp`)
  console.log(`[facts] token: ${TOKEN}`)
  console.log(`[facts] the fact only this server knows: ${SECRET_FACT}`)
})
