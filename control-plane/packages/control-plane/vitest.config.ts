import { defineConfig } from 'vitest/config'

export default defineConfig({
  /**
   * An inline PostCSS config, so Vite does not go looking for one.
   *
   * The search runs *upward*, and as a subdirectory of a Next app's repository it escapes this
   * subtree and finds the app's config, which loads a Tailwind plugin absent from this
   * workspace. This suite has a config already, which stops vitest's own search but not this
   * one.
   */
  css: { postcss: { plugins: [] } },
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
