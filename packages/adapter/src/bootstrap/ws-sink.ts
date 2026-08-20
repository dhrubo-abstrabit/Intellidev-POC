import type { AgentEvent } from '@intellidev/shared'
import type { EventSink } from './sinks.js'

/**
 * Ships events to the control plane over a WebSocket the run dials **out**.
 *
 * Outbound is the whole design: nothing reaches into a running container, which is what
 * lets Docker and Fargate share one runner interface and why no NAT gateway or inbound
 * security-group rule is needed. On Fargate there is no shared filesystem to tail, so this
 * replaces the JSONL file as the way a run is watched.
 *
 * **The guarantee is a gapless log, not a delivered packet.** The bus holds every event
 * until the control plane acknowledges its `seq`, so a dropped socket is a replay rather
 * than a hole. That is why this takes `replayFrom` and `ack` instead of just a send
 * function: on every reconnect it re-sends everything not yet acknowledged, in order,
 * before anything new.
 */

export interface WebSocketSinkOptions {
  /** `wss://host/internal/runs/<runId>/events` */
  readonly url: string
  /** The run's own token. The only credential a run holds. */
  readonly token: string
  readonly runId: string
  /** Everything the control plane has not yet acknowledged, in order. */
  readonly replayFrom: (seq: number) => AgentEvent[]
  /** Told what the control plane has durably stored, so the bus can drop it. */
  readonly onAck: (seq: number) => void
  /** Injected in tests. Node 22+ provides a global `WebSocket`. */
  readonly connect?: (url: string) => WebSocketLike
  readonly onDiagnostic?: (message: string) => void
  readonly maxBackoffMs?: number
  readonly now?: () => number
}

/** The slice of the WebSocket API this uses, so a test can supply a double. */
export interface WebSocketLike {
  send(data: string): void
  close(code?: number, reason?: string): void
  onopen: ((event: unknown) => void) | null
  onmessage: ((event: { data: unknown }) => void) | null
  onclose: ((event: unknown) => void) | null
  onerror: ((event: unknown) => void) | null
  readyState: number
}

const OPEN = 1

export class WebSocketEventSink {
  private socket: WebSocketLike | undefined
  private closed = false
  private attempt = 0
  private ackedThrough = -1
  private reconnectTimer: NodeJS.Timeout | undefined
  private readonly diag: (message: string) => void

  constructor(private readonly opts: WebSocketSinkOptions) {
    this.diag = opts.onDiagnostic ?? (() => {})
  }

  /**
   * The `EventSink` the bus writes to.
   *
   * Synchronous and non-throwing by contract: an event is a fact that already happened, and
   * failing to ship it must never fail the run that produced it. When the socket is down
   * this deliberately does nothing — the bus is still holding the event, and the next
   * successful connect replays it.
   */
  get sink(): EventSink {
    return (event: AgentEvent) => {
      if (this.closed) return
      if (this.socket?.readyState !== OPEN) return
      try {
        this.socket.send(JSON.stringify({ type: 'event', event }))
      } catch (error) {
        // A send that throws means the socket is already gone; the close handler will
        // reconnect and replay. Swallowing here is correct, not lazy.
        this.diag(`event socket send failed: ${describe(error)}`)
      }
    }
  }

  start(): void {
    this.open()
  }

  /**
   * Waits, briefly, for what has not been acknowledged — then closes regardless.
   *
   * An earlier version closed immediately, reasoning that C5's reconciler would settle the
   * run anyway. That was wrong for the case that actually happens: a **short** run whose
   * first connect attempt failed. The reconnect is still in backoff when the run ends, so
   * closing at once discards the entire event log rather than the tail of it — observed on a
   * real Fargate run, which streamed nothing at all while a warm one streamed everything.
   *
   * Bounded, so it cannot hang: after `graceMs` it closes and says how much it lost, because
   * a silent loss is the thing worth avoiding rather than the loss itself.
   */
  async close(graceMs = 5_000): Promise<void> {
    const deadline = (this.opts.now ?? Date.now)() + graceMs

    while (this.pendingCount() > 0 && (this.opts.now ?? Date.now)() < deadline) {
      // Deliberately does not set `closed` yet: the reconnect loop is what will deliver
      // these, and disabling it here would guarantee the loss this method exists to prevent.
      await new Promise((resolve) => setTimeout(resolve, 100))
    }

    const unflushed = this.pendingCount()
    if (unflushed > 0) {
      this.diag(
        `event socket closing with ${unflushed} event(s) never acknowledged after ${graceMs}ms; ` +
          'the run will be settled by the reconciler from its ECS stop reason',
      )
    }

    this.closed = true
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    try {
      this.socket?.close(1000, 'run finished')
    } catch {
      // Already gone. Nothing to do, and nothing worth reporting.
    }
  }

  /** How many events the control plane has confirmed. Exposed for assertions. */
  get acknowledged(): number {
    return this.ackedThrough
  }

  private open(): void {
    if (this.closed) return

    const connect = this.opts.connect ?? ((url: string) => new WebSocket(url) as WebSocketLike)
    // The token travels as a query parameter rather than a header because the WebSocket
    // API offers no way to set one on the handshake from a browser-shaped client. It is
    // scoped to one run and short-lived, and the control plane never logs the query string.
    const url = `${this.opts.url}?token=${encodeURIComponent(this.opts.token)}`

    let socket: WebSocketLike
    try {
      socket = connect(url)
    } catch (error) {
      this.diag(`event socket could not be created: ${describe(error)}`)
      this.scheduleReconnect()
      return
    }
    this.socket = socket

    socket.onopen = () => {
      this.attempt = 0
      // Replay before anything new. Ordering is the point: the control plane drops
      // out-of-order and duplicate seqs, so a replay is idempotent, but a *gap* is
      // permanent — nothing later can fill it in.
      const pending = this.opts.replayFrom(this.ackedThrough)
      if (pending.length > 0) {
        this.diag(`event socket open; replaying ${pending.length} unacknowledged event(s)`)
        for (const event of pending) {
          try {
            socket.send(JSON.stringify({ type: 'event', event }))
          } catch (error) {
            this.diag(`replay interrupted at seq ${event.seq}: ${describe(error)}`)
            break
          }
        }
      } else {
        this.diag('event socket open')
      }
    }

    socket.onmessage = (message) => {
      const ack = parseAck(message.data)
      if (ack === undefined) return
      if (ack <= this.ackedThrough) return
      this.ackedThrough = ack
      // Letting the bus drop acknowledged events is what keeps a long run's memory bounded.
      this.opts.onAck(ack)
    }

    socket.onerror = () => {
      // Deliberately quiet: an error is always followed by a close, and reporting both
      // makes a single blip look like two failures in the log.
    }

    socket.onclose = () => {
      this.socket = undefined
      if (this.closed) return
      this.diag(`event socket closed with ${this.pendingCount()} event(s) unacknowledged`)
      this.scheduleReconnect()
    }
  }

  private pendingCount(): number {
    return this.opts.replayFrom(this.ackedThrough).length
  }

  private scheduleReconnect(): void {
    if (this.closed) return
    this.attempt += 1
    // Exponential with a ceiling. Unbounded backoff would mean a long stage finishing with
    // an hour of events still buffered; the ceiling keeps the worst case bounded.
    const base = Math.min(500 * 2 ** (this.attempt - 1), this.opts.maxBackoffMs ?? 15_000)
    // Jittered, so many runs losing a control plane together do not reconnect in lockstep
    // and knock it over again as it comes back.
    const delay = base / 2 + Math.random() * (base / 2)
    this.reconnectTimer = setTimeout(() => this.open(), delay)
  }
}

/** Acks are `{"type":"ack","seq":n}`. Anything else is ignored rather than fatal. */
function parseAck(data: unknown): number | undefined {
  if (typeof data !== 'string') return undefined
  try {
    const parsed = JSON.parse(data) as { type?: string; seq?: unknown }
    if (parsed.type !== 'ack') return undefined
    return typeof parsed.seq === 'number' ? parsed.seq : undefined
  } catch {
    return undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
