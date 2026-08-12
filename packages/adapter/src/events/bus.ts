import {
  AgentEvent,
  noopRedactor,
  redactDeep,
  type EventBodyInput,
  type Redactor,
  type StageId,
} from '@intellidev/shared'

/**
 * The one thing allowed to number the stream.
 *
 * `seq` is per-run and monotonic with no gaps, which is what lets a reconnecting
 * consumer replay instead of guessing. Drivers emit bodies; this stamps them and
 * keeps them until the control plane acknowledges receipt.
 */
export class EventBus {
  private seq = 0
  private stage: StageId | null = null
  private readonly buffer: AgentEvent[] = []
  private ackedThrough = -1

  constructor(
    private readonly runId: string,
    private readonly sink: (event: AgentEvent) => void,
    private readonly now: () => Date = () => new Date(),
    /**
     * Applied to every payload before it is numbered. Redacting here rather than at
     * call sites is deliberate: one forgotten call site is a permanent leak, because
     * this log outlives the run.
     */
    private readonly redactor: Redactor = noopRedactor,
  ) {}

  /** Bootstrap events carry a null stage; everything after is stamped. */
  enterStage(stage: StageId | null): void {
    this.stage = stage
  }

  emit(body: EventBodyInput): AgentEvent {
    const event = AgentEvent.parse({
      seq: this.seq++,
      runId: this.runId,
      ts: this.now().toISOString(),
      stage: this.stage,
      ...redactDeep(body, this.redactor),
    })
    this.buffer.push(event)
    this.sink(event)
    return event
  }

  /**
   * Drop everything the control plane has confirmed. Until it does, we hold the
   * events so a dropped socket replays rather than loses.
   */
  ack(seq: number): void {
    if (seq <= this.ackedThrough) return
    this.ackedThrough = seq
    while (this.buffer.length > 0) {
      const head = this.buffer[0]
      if (!head || head.seq > seq) break
      this.buffer.shift()
    }
  }

  /** Everything not yet acknowledged, in order. */
  replayFrom(seq: number): AgentEvent[] {
    return this.buffer.filter((event) => event.seq > seq)
  }

  get pending(): number {
    return this.buffer.length
  }

  get nextSeq(): number {
    return this.seq
  }
}
