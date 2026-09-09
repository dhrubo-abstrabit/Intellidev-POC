/**
 * What one subscriber has already been given.
 *
 * Replaces a bare `deliveredThrough` watermark, which silently dropped events. A watermark can
 * only say "everything up to N"; it cannot represent "5, 6 and 7 but not 4", which is exactly
 * the state a subscriber reaches when batches arrive out of order.
 *
 * That happened for real. `appendEvents` awaits between its insert and its fan-out, so two
 * batches for one run interleave:
 *
 *   batch [4]      inserts … awaits
 *   batch [5,6,7]  inserts, awaits, fans out → watermark 7
 *   batch [4]      resumes, fans out → 4 <= 7 → skipped for ever
 *
 * A Fargate run dropped seqs 4, 6, 7 and 12 from a live stream this way while the database held
 * all fourteen. The events were not lost — a reconnect backfills them — but anyone watching saw
 * a timeline with holes and no indication of it.
 *
 * The shape here is a contiguous prefix plus a set of the stragglers above it. Memory is
 * proportional to the size of the *gaps*, not the length of the run: a run delivering in order
 * holds an empty set, and the set drains as soon as the missing seq arrives.
 */
export class DeliveryCursor {
  /** Everything at or below this has been delivered. `-1` because seq 0 is a real event. */
  private contiguousThrough: number
  /** Delivered seqs above the prefix, held only until the prefix catches up to them. */
  private readonly ahead = new Set<number>()

  constructor(since = -1) {
    this.contiguousThrough = since
  }

  /** Where a reconnecting caller should resume from: the last gapless point. */
  get resumeFrom(): number {
    return this.contiguousThrough
  }

  /** True if this seq has already been handed to the subscriber. */
  has(seq: number): boolean {
    return seq <= this.contiguousThrough || this.ahead.has(seq)
  }

  /**
   * Records a delivery, returning false if it was a duplicate.
   *
   * Advancing the prefix after each insert is what keeps `ahead` small: the moment the missing
   * seq arrives, every straggler it was blocking is absorbed and forgotten.
   */
  record(seq: number): boolean {
    if (this.has(seq)) return false
    this.ahead.add(seq)
    while (this.ahead.delete(this.contiguousThrough + 1)) {
      this.contiguousThrough += 1
    }
    return true
  }

  /** How many out-of-order seqs are currently held. Exposed for tests and diagnostics. */
  get pendingGapCount(): number {
    return this.ahead.size
  }
}
