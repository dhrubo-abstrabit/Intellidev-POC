import { describe, expect, it } from 'vitest'
import { DeliveryCursor } from '../src/store/delivery.js'

/**
 * Regression tests for events vanishing from a live stream.
 *
 * A Fargate run delivered seqs 0,1,2,3,5,8,9,10,11,13 to a watching client while the database
 * held all fourteen. The drops were non-contiguous, which ruled out a truncated stream and
 * pointed at the per-subscription watermark: it can say "everything through 7" but not
 * "7, 6 and 5 but not 4", so a batch that arrived late was skipped permanently.
 *
 * The cause is that `appendEvents` awaits between its insert and its fan-out, so two batches for
 * one run interleave and the later one advances the watermark past the earlier one.
 */
describe('DeliveryCursor', () => {
  it('delivers an out-of-order straggler instead of swallowing it', () => {
    const cursor = new DeliveryCursor(-1)
    // The interleaving, in the order it actually happened.
    expect(cursor.record(5)).toBe(true)
    expect(cursor.record(6)).toBe(true)
    expect(cursor.record(7)).toBe(true)
    // A watermark would be at 7 by now and would refuse this.
    expect(cursor.record(4)).toBe(true)
  })

  it('still refuses a genuine duplicate', () => {
    const cursor = new DeliveryCursor(-1)
    expect(cursor.record(0)).toBe(true)
    expect(cursor.record(0)).toBe(false)
  })

  it('honours `since`, so a reconnect does not replay what the client has', () => {
    const cursor = new DeliveryCursor(4)
    expect(cursor.record(3)).toBe(false)
    expect(cursor.record(4)).toBe(false)
    expect(cursor.record(5)).toBe(true)
  })

  it('resumes from the last gapless point, not the highest seen', () => {
    const cursor = new DeliveryCursor(-1)
    for (const seq of [0, 1, 3, 4]) cursor.record(seq)
    // 2 is missing, so resuming from 4 would skip it for ever.
    expect(cursor.resumeFrom).toBe(1)
    cursor.record(2)
    expect(cursor.resumeFrom).toBe(4)
  })

  it('holds only the gap, so memory does not grow with the run', () => {
    const cursor = new DeliveryCursor(-1)
    for (let seq = 0; seq < 500; seq++) cursor.record(seq)
    expect(cursor.pendingGapCount).toBe(0)
    expect(cursor.resumeFrom).toBe(499)
  })

  it('drains the whole backlog when the missing seq finally arrives', () => {
    const cursor = new DeliveryCursor(-1)
    for (const seq of [1, 2, 3, 4, 5]) cursor.record(seq)
    expect(cursor.pendingGapCount).toBe(5)
    cursor.record(0)
    expect(cursor.pendingGapCount).toBe(0)
    expect(cursor.resumeFrom).toBe(5)
  })
})
