import {
  createServer,
  type IncomingMessage,
  type Server as HttpServer,
  type ServerResponse,
} from 'node:http'
import { randomBytes } from 'node:crypto'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import type { Gateway } from './gateway.js'

/**
 * Hosts the gateway over loopback HTTP.
 *
 * Why not stdio: with stdio the *harness* spawns the gateway, which puts it in a different
 * process from the adapter — and then every built-in tool (`stage_state`, `stage_advance`,
 * `run_check`) needs a second IPC hop back for state it could otherwise just read. Running
 * in-process on 127.0.0.1 removes that hop entirely. All three harnesses support remote
 * MCP, so nothing is given up.
 *
 * Stateless: a fresh `Server` and transport per request. Construction is cheap because the
 * handlers close over one shared `Gateway`, and it avoids session bookkeeping that would
 * otherwise have to survive a harness restart mid-stage.
 */
export interface GatewayHttpOptions {
  gateway: Gateway
  /** 0 asks the OS for a free port, which is what a container should do. */
  port?: number
  path?: string
  /** Generated when absent. Harness config carries it; nothing else should. */
  token?: string
  name?: string
  version?: string
}

export class GatewayHttpServer {
  readonly token: string
  private readonly path: string
  private http: HttpServer | null = null
  private boundPort = 0

  constructor(private readonly opts: GatewayHttpOptions) {
    this.token = opts.token ?? randomBytes(24).toString('base64url')
    this.path = opts.path ?? '/mcp'
  }

  /** The URL to put in harness config. Only valid once started. */
  get url(): string {
    return `http://127.0.0.1:${this.boundPort}${this.path}`
  }

  get port(): number {
    return this.boundPort
  }

  async start(): Promise<string> {
    this.http = createServer((req, res) => {
      void this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ error: 'gateway failure' }))
      })
    })

    await new Promise<void>((resolve, reject) => {
      this.http?.once('error', reject)
      // Loopback only. A gateway reachable from outside the container would be a way in.
      this.http?.listen(this.opts.port ?? 0, '127.0.0.1', resolve)
    })

    const address = this.http?.address()
    this.boundPort = typeof address === 'object' && address ? address.port : 0
    return this.url
  }

  async stop(): Promise<void> {
    const http = this.http
    if (!http) return
    await new Promise<void>((resolve) => http.close(() => resolve()))
    this.http = null
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1')
    if (url.pathname !== this.path) {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'not found' }))
      return
    }

    const auth = req.headers['authorization']
    if (auth !== `Bearer ${this.token}`) {
      // Not a boundary against the agent — it holds the token by design — but it stops
      // anything else on the host from driving the run's tools.
      res.writeHead(401, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: 'unauthorized' }))
      return
    }

    const body = await readJson(req)
    const server = this.createServer()
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined })

    res.on('close', () => {
      void transport.close()
      void server.close()
    })

    await server.connect(transport)
    await transport.handleRequest(req, res, body)
  }

  /** One `Server` per request; handlers share the single `Gateway`. */
  private createServer(): Server {
    const server = new Server(
      { name: this.opts.name ?? 'intellidev', version: this.opts.version ?? '0.0.0' },
      { capabilities: { tools: {} } },
    )

    // Computed per request, so a list handed out during `design` is never reused once
    // `code` has started.
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: this.opts.gateway.listTools().map((tool) => ({
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema as { type: 'object' },
      })),
    }))

    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const outcome = await this.opts.gateway.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as Record<string, unknown>,
      )
      return {
        content: [{ type: 'text' as const, text: outcome.content }],
        ...(outcome.ok ? {} : { isError: true }),
      }
    })

    return server
  }
}

function readJson(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve) => {
    if (req.method === 'GET' || req.method === 'DELETE') {
      resolve(undefined)
      return
    }
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : undefined)
      } catch {
        // Let the transport report a protocol error rather than guessing at intent.
        resolve(undefined)
      }
    })
  })
}
