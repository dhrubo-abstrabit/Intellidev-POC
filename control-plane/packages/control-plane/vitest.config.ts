import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    /**
     * Test files run one at a time in this package.
     *
     * Two suites here talk to the same real database, and each empties it between tests.
     * Run in parallel they truncate each other's rows mid-insert, which surfaces as
     * foreign-key violations and empty result sets — failures that look like store bugs and
     * are not. There is no isolation to be had short of a schema per worker, and the suite
     * is small enough that correctness is the better trade.
     *
     * Everything else — the adapter's 381 tests, shared's 59 — still runs in parallel,
     * because nothing there touches a shared resource.
     */
    fileParallelism: false,
    // The fan-out tests wait on real notifications over an ~85 ms link, so the 5 s default
    // is too tight to distinguish "slow" from "broken".
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
})
