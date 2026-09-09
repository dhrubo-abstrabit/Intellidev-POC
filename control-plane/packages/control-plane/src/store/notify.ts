import pg from 'pg'

/**
 * Postgres `LISTEN`/`NOTIFY`, so an event delivered to one control-plane instance reaches a
 * browser attached to another.
 *
 * The problem: with an ALB in front of two instances, the adapter's WebSocket lands on
 * whichever instance the balancer chose and the browser's SSE lands on whichever *it*
 * chose. Those are often different. Instance A holds the events; instance B is serving the
 * browser and has nothing — so the UI shows a stalled run that is in fact progressing.
 *
 * **A dedicated connection, not one from the pool.** A `LISTEN` registration lives on a
 * session, and a pooled connection is handed to someone else between statements. This is
 * measured rather than assumed: with a long-lived listener on one connection and a notifier
 * on another, the session-mode pooler delivered 3 of 3 notifications and transaction mode
 * delivered 0 of 3.
 *
 * **The payload is a run id, never an event.** `NOTIFY` caps payloads at 8000 bytes and an
 * event can carry a 2000-character preview, so shipping events through the channel would
 * work until a large one silently did not. Instead a notification is a hint — "run X has
 * something new" — and the listener reads the rows. That also makes it self-healing: a
 * notification lost while the connection was down is recovered by the same query, because
 * it asks for everything after what it has already delivered rather than for one event.
 */

/** One channel with a run-id payload, rather than a channel per run: Postgres caps how many
 *  channels a session may listen on, and filtering locally costs nothing at this scale. */
export const RUN_EVENTS_CHANNEL = 'intellidev_run_events'

export interface NotifyListenerOptions {
  readonly connectionString: string
  /** Called with the run id a notification named. */
  readonly onRunChanged: (runId: string) => void
  /** Called after a reconnect, so missed notifications can be recovered. */
  readonly onReconnected: () => void
  readonly onDiagnostic?: (message: string) => void
  readonly maxBackoffMs?: number
  /** Injected in tests. */
  readonly createClient?: (connectionString: string) => NotifyClient
}

/** The slice of `pg.Client` used, so a test can supply a double. */
export interface NotifyClient {
  connect(): Promise<void>
  query(sql: string): Promise<unknown>
  end(): Promise<void>
  on(
    event: 'notification',
    listener: (message: { channel: string; payload?: string }) => void,
  ): void
  on(event: 'error', listener: (error: Error) => void): void
}

export class NotifyListener {
  private client: NotifyClient | undefined
  private closed = false
  private attempt = 0
  private timer: NodeJS.Timeout | undefined
  private readonly diag: (message: string) => void

  constructor(private readonly opts: NotifyListenerOptions) {
    this.diag = opts.onDiagnostic ?? (() => {})
  }

  async start(): Promise<void> {
    await this.open()
  }

  async close(): Promise<void> {
    this.closed = true
    if (this.timer) clearTimeout(this.timer)
    try {
      await this.client?.end()
    } catch {
      // Already gone. Closing a dead connection is the outcome we wanted.
    }
  }

  private async open(): Promise<void> {
    if (this.closed) return

    const create =
      this.opts.createClient ??
      ((connectionString: string) =>
        new pg.Client({
          connectionString,
          ssl: { rejectUnauthorized: false },
          // A listener that cannot connect in 15 s over an 85 ms link is broken, not slow.
          connectionTimeoutMillis: 15_000,
          // Keepalives matter more here than anywhere else: this connection is idle by
          // design, and a silently dropped idle TCP session is indistinguishable from a
          // quiet system — which is exactly the failure that makes a UI look stalled.
          keepAlive: true,
        }) as unknown as NotifyClient)

    let client: NotifyClient
    try {
      client = create(this.opts.connectionString)
      client.on('error', (error: Error) => {
        // Never throw from here: an idle-connection error must not become an unhandled
        // rejection that takes the control plane down.
        this.diag(`notify listener error: ${error.message}`)
        this.scheduleReconnect()
      })
      await client.connect()
      await client.query(`listen ${RUN_EVENTS_CHANNEL}`)
    } catch (error) {
      this.diag(`notify listener could not start: ${describe(error)}`)
      this.scheduleReconnect()
      return
    }

    client.on('notification', (message: { channel: string; payload?: string }) => {
      if (message.channel !== RUN_EVENTS_CHANNEL) return
      if (message.payload) this.opts.onRunChanged(message.payload)
    })

    this.client = client
    const reconnected = this.attempt > 0
    this.attempt = 0
    this.diag(`notify listener ${reconnected ? 're' : ''}connected on ${RUN_EVENTS_CHANNEL}`)
    // Recovery, not decoration: anything that happened while the connection was down was
    // never delivered, and only a re-read can close that gap.
    if (reconnected) this.opts.onReconnected()
  }

  private scheduleReconnect(): void {
    if (this.closed || this.timer) return
    this.attempt += 1
    const ceiling = this.opts.maxBackoffMs ?? 15_000
    const base = Math.min(500 * 2 ** (this.attempt - 1), ceiling)
    // Jittered so many instances losing the database together do not reconnect in lockstep
    // and knock it over as it comes back.
    const delay = base / 2 + Math.random() * (base / 2)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.open()
    }, delay)
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
