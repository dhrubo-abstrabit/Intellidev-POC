import { DescribeTasksCommand, ECSClient } from '@aws-sdk/client-ecs'
import { DeleteMessageCommand, ReceiveMessageCommand, SQSClient } from '@aws-sdk/client-sqs'
import type { Store } from '../store.js'
import { settle } from '../dispatch.js'

/**
 * Makes sure every run reaches a terminal state, including the ones nothing reported.
 *
 * The problem this exists for: on Fargate nothing tells the control plane a run ended. A
 * task killed for exceeding its memory limit, one whose image pull failed, or one
 * interrupted on Spot capacity simply stops, and the run sits `running` for ever — holding
 * a seat and hiding cost, with the ECS task row as the only evidence.
 *
 * Two independent mechanisms, because each covers what the other misses:
 *
 *  - **The queue** carries ECS task-state-change events and is the fast path: a stopped
 *    task usually settles within seconds, with the reason ECS gave.
 *  - **The sweep** re-reads ECS for every run still marked running. It catches what the
 *    queue cannot: an event lost before the rule matched, a message that exhausted its
 *    redeliveries into the DLQ, and — the common one — a control-plane restart, which
 *    destroys the in-process observer C1's runner relies on.
 *
 * Deliberately redundant, and `settle` is idempotent so the redundancy is safe.
 */

/** Terminal ECS states we act on. Anything else is still in flight. */
const STOPPED = 'STOPPED'

export interface ReconcilerOptions {
  readonly store: Store
  readonly clusterName: string
  readonly queueUrl: string
  readonly region: string
  readonly ecs?: Pick<ECSClient, 'send'>
  readonly sqs?: Pick<SQSClient, 'send'>
  /** How often the sweep runs. The queue is the fast path; this is the safety net. */
  readonly sweepIntervalMs?: number
  readonly log?: (message: string) => void
  /** Revoked when a run settles here, exactly as on the dispatch path. */
  readonly tokens?: { revoke(runId: string): Promise<void> }
}

export interface SettledRun {
  readonly runId: string
  readonly reason: string
  readonly via: 'queue' | 'sweep'
}

export class LifecycleReconciler {
  private readonly ecs: Pick<ECSClient, 'send'>
  private readonly sqs: Pick<SQSClient, 'send'>
  private readonly log: (message: string) => void
  private timer: NodeJS.Timeout | undefined
  private stopped = false

  constructor(private readonly opts: ReconcilerOptions) {
    this.ecs = opts.ecs ?? new ECSClient({ region: opts.region })
    this.sqs = opts.sqs ?? new SQSClient({ region: opts.region })
    this.log = opts.log ?? (() => {})
  }

  /** Starts both mechanisms. Safe to call once; `stop()` unwinds it. */
  start(): void {
    // `.catch` on every scheduled call, not `void`. `void` on a rejecting promise is an
    // unhandled rejection, which Node treats as fatal — so one failed background task took
    // the entire control plane with it. Defence in depth: each body also catches its own.
    this.consumeForever().catch((error: unknown) => {
      this.log(`reconciler: consumer stopped unexpectedly (${describe(error)})`)
    })
    const interval = this.opts.sweepIntervalMs ?? 60_000
    this.timer = setInterval(() => {
      this.sweep().catch((error: unknown) => {
        this.log(`reconciler: sweep failed (${describe(error)})`)
      })
    }, interval)
    // Sweeping immediately matters most right after a restart, which is precisely when
    // orphaned runs exist: the process that was observing them is gone.
    this.sweep().catch((error: unknown) => {
      this.log(`reconciler: first sweep failed (${describe(error)})`)
    })
    this.log(
      `reconciler: watching ${this.opts.queueUrl.split('/').pop()}, sweeping every ${interval}ms`,
    )
  }

  stop(): void {
    this.stopped = true
    if (this.timer) clearInterval(this.timer)
  }

  /**
   * Long-polls the queue and settles what it finds.
   *
   * A message is deleted only after the run is settled *or* found to be none of our
   * business. Deleting first would lose the event if settling threw, which is the one
   * outcome this whole mechanism exists to prevent.
   */
  private async consumeForever(): Promise<void> {
    while (!this.stopped) {
      try {
        const received = await this.sqs.send(
          new ReceiveMessageCommand({
            QueueUrl: this.opts.queueUrl,
            MaxNumberOfMessages: 10,
            // Long poll: one request per 20 idle seconds rather than a spin, which is both
            // cheaper and faster to react than short polling on an interval.
            WaitTimeSeconds: 20,
          }),
        )
        for (const message of received.Messages ?? []) {
          const handled = await this.handleMessage(message.Body ?? '')
          if (handled && message.ReceiptHandle) {
            await this.sqs.send(
              new DeleteMessageCommand({
                QueueUrl: this.opts.queueUrl,
                ReceiptHandle: message.ReceiptHandle,
              }),
            )
          }
        }
      } catch (error) {
        // Never let a transient SQS error end the loop: a reconciler that has quietly died
        // is indistinguishable from one with nothing to do.
        this.log(`reconciler: receive failed (${describe(error)}); retrying`)
        await sleep(5_000)
      }
    }
  }

  /** Returns true when the message can be deleted. Exposed for tests. */
  async handleMessage(body: string): Promise<boolean> {
    let detail: TaskStateDetail | undefined
    try {
      detail = (JSON.parse(body) as { detail?: TaskStateDetail }).detail
    } catch {
      // Unparseable is not retryable. Delete it rather than let it cycle to the DLQ three
      // redeliveries later.
      this.log('reconciler: dropping a message that is not JSON')
      return true
    }

    const arn = detail?.taskArn
    if (!arn || detail?.lastStatus !== STOPPED) return true

    const run = await this.opts.store.findRunByHandle(arn)
    if (!run) {
      // A task in our cluster that is not one of our runs — the egress probe, or the pull
      // probe. Not an error, and nothing to settle.
      return true
    }

    const reason = stoppedReason(detail)
    const settled = await settle(
      this.opts.store,
      run.id,
      run.taskId,
      exitedCleanly(detail) ? 'succeeded' : 'failed',
      [],
      undefined,
      reason,
      this.opts.tokens,
      // The container this message is about. Found by that ARN, so it matches today — passed
      // anyway, because a run whose handle has since moved on must not be settled from it.
      arn,
    )
    if (settled) this.log(`reconciler: settled ${run.id} from the queue — ${reason}`)
    return true
  }

  /**
   * Re-reads ECS for every run still marked running.
   *
   * Returns what it settled, so a caller — or a test — can assert on it rather than
   * inferring from logs.
   */
  async sweep(): Promise<SettledRun[]> {
    let candidates
    try {
      /**
       * Only runs that name a live container.
       *
       * A run with no handle is one whose container is gone and which has already said what
       * happened — a parked run awaiting approval, or one between an approval and its next
       * container. Describing a stale ARN there settled the run from the *previous*
       * container's exit and revoked the token the new one was about to use.
       */
      candidates = (await this.opts.store.listUnsettledRuns()).filter((run) =>
        run.handle?.startsWith('arn:aws:ecs:'),
      )
    } catch (error) {
      // A store read failing is transient and expected — a DNS blip reaching the database
      // was enough to take the whole control plane down before this, because the rejection
      // escaped into `setInterval`. The next sweep retries; nothing is lost by skipping one.
      this.log(`reconciler: could not list unsettled runs (${describe(error)}); will retry`)
      return []
    }
    if (candidates.length === 0) return []

    const settledRuns: SettledRun[] = []
    // DescribeTasks takes at most 100 ARNs per call.
    for (let i = 0; i < candidates.length; i += 100) {
      const batch = candidates.slice(i, i + 100)
      let response
      try {
        response = await this.ecs.send(
          new DescribeTasksCommand({
            cluster: this.opts.clusterName,
            tasks: batch.map((run) => run.handle!),
          }),
        )
      } catch (error) {
        this.log(`reconciler: sweep failed (${describe(error)})`)
        continue
      }

      const seen = new Map((response.tasks ?? []).map((task) => [task.taskArn, task]))

      for (const run of batch) {
        const task = seen.get(run.handle!)

        if (!task) {
          // ECS keeps a stopped task queryable for about an hour, then forgets it. A run
          // whose task is unknown has therefore been over for a while, and no reason will
          // ever be available for it. Saying so is more useful than leaving it running.
          const reason = 'task no longer known to ECS; it stopped more than an hour ago'
          if (
            await settle(
              this.opts.store,
              run.id,
              run.taskId,
              'failed',
              [],
              undefined,
              reason,
              this.opts.tokens,
              run.handle!,
            )
          ) {
            settledRuns.push({ runId: run.id, reason, via: 'sweep' })
          }
          continue
        }

        if (task.lastStatus !== STOPPED) continue

        const detail: TaskStateDetail = {
          taskArn: task.taskArn,
          lastStatus: task.lastStatus,
          ...(task.stoppedReason ? { stoppedReason: task.stoppedReason } : {}),
          ...(task.stopCode ? { stopCode: task.stopCode } : {}),
          containers: (task.containers ?? []).map((container) => ({
            name: container.name,
            ...(container.exitCode === undefined ? {} : { exitCode: container.exitCode }),
            ...(container.reason ? { reason: container.reason } : {}),
          })),
        }
        const reason = stoppedReason(detail)
        if (
          await settle(
            this.opts.store,
            run.id,
            run.taskId,
            exitedCleanly(detail) ? 'succeeded' : 'failed',
            [],
            undefined,
            reason,
            this.opts.tokens,
            // The container observed, not the run. A sweep between a container exiting and the
            // next one starting would otherwise settle the run from the old one's exit code.
            run.handle!,
          )
        ) {
          settledRuns.push({ runId: run.id, reason, via: 'sweep' })
          this.log(`reconciler: settled ${run.id} by sweep — ${reason}`)
        }
      }
    }
    return settledRuns
  }
}

export interface TaskStateDetail {
  taskArn?: string
  lastStatus?: string
  stoppedReason?: string
  stopCode?: string
  containers?: Array<{ name?: string; exitCode?: number; reason?: string }>
}

/** A run succeeded only if a container reported exit 0. Silence is not success. */
function exitedCleanly(detail: TaskStateDetail): boolean {
  const codes = (detail.containers ?? []).map((container) => container.exitCode)
  return codes.length > 0 && codes.every((code) => code === 0)
}

/**
 * Turns an ECS stop into something a human can act on.
 *
 * The raw `stoppedReason` is often "Essential container in task exited", which is true and
 * useless. The container's own `reason` is where "OutOfMemoryError" and
 * "CannotPullContainerError" live, and those are the ones worth surfacing first.
 */
export function stoppedReason(detail: TaskStateDetail): string {
  const container = (detail.containers ?? []).find((c) => c.reason) ?? undefined
  const parts: string[] = []
  if (container?.reason) parts.push(container.reason)
  if (detail.stoppedReason) parts.push(detail.stoppedReason)
  if (detail.stopCode) parts.push(`stopCode=${detail.stopCode}`)
  const codes = (detail.containers ?? [])
    .filter((c) => c.exitCode !== undefined)
    .map((c) => `${c.name ?? 'container'} exited ${c.exitCode}`)
  parts.push(...codes)
  return parts.length > 0 ? parts.join(' · ') : 'stopped by ECS with no reason given'
}

/**
 * An error message that includes what actually went wrong.
 *
 * Drizzle wraps a driver failure so that `message` is only `Failed query: <sql>` and the real
 * reason — the Postgres code, the missing column, the closed pool — hangs off `cause`. Logging
 * just `message` produced pages of identical SQL with no diagnosis, which is how a reconciler
 * failing every sixty seconds went unexplained.
 */
function describe(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const causes: string[] = []
  let current: unknown = error.cause
  // Bounded, because a cause chain can be circular and this runs inside a log line.
  for (let depth = 0; current instanceof Error && depth < 4; depth++) {
    const code = (current as { code?: string }).code
    causes.push(code ? `${code} ${current.message}` : current.message)
    current = current.cause
  }
  // The SQL is the least useful part, so it is truncated rather than printed whole.
  const head = error.message.split('\n')[0]?.slice(0, 160) ?? ''
  return causes.length > 0 ? `${head} — caused by: ${causes.join(' <- ')}` : head
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
