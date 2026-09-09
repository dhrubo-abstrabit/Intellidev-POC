import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { runtimeDirPrefix, UNIX_SOCKET_PATH_LIMIT } from '../src/dispatch.js'

/**
 * The inline broker's socket path must fit in `sun_path`.
 *
 * This is a regression test for a real failure: run ids became uuids, the runtime directory was
 * named after the whole id, and the resulting path was 118 characters on macOS. Binding it
 * failed with `listen EINVAL: invalid argument`, which mentions neither a length nor a socket —
 * the run simply died at `provisioning` with an error nobody could act on.
 *
 * Asserted two ways, because the limit applies to the *absolute* path. Against the real
 * `tmpdir()`, which is the only thing that says anything about the machine the code is running
 * on; and against a temp directory of the length macOS actually hands out, because that is the
 * tight case and a Linux runner's `/tmp` is four characters.
 */
describe('inline broker socket path', () => {
  // `mkdtemp` appends six random characters, which count toward the limit.
  const MKDTEMP_SUFFIX = 6
  const SOCKET_FILE = '/broker.sock'

  /**
   * A temp directory of the length the failure happened at.
   *
   * FOUND ON LINUX CI. macOS hands out `/var/folders/<2>/<32>/T` — 48 characters before
   * anything of ours is added — and the two assertions below were written against `tmpdir()`,
   * so on a runner whose temp directory is `/tmp` they stopped describing the bug: the naive
   * path fits in 71 characters there, and the test claiming it does not simply failed.
   */
  const TIGHT_TMPDIR = '/var/folders/_t/34j75cjs1mx9fxws4k6v9hh40000gn/T'

  it('fits within the unix socket path limit for a uuid run id', () => {
    const path =
      join(tmpdir(), runtimeDirPrefix(randomUUID())) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(path.length).toBeLessThan(UNIX_SOCKET_PATH_LIMIT)
  })

  it('would not fit if the whole run id were used, which is the bug it guards', () => {
    // Documents the regression rather than trusting the fix to stay obvious: if someone
    // "tidies" the prefix back to the full id, the test above fails and this explains why.
    const naive =
      join(TIGHT_TMPDIR, `intellidev-${randomUUID()}-`) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(naive.length).toBeGreaterThan(UNIX_SOCKET_PATH_LIMIT)
  })

  it('leaves headroom on a machine with a long temp directory, not only on this one', () => {
    // A container or a Linux runner has a short temp path; a developer's Mac is the tight case,
    // and it is the one that broke. 20 characters of headroom there keeps the fit from being an
    // accident of whichever machine happened to run the suite.
    const path =
      join(TIGHT_TMPDIR, runtimeDirPrefix(randomUUID())) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(UNIX_SOCKET_PATH_LIMIT - path.length).toBeGreaterThan(20)
  })
})
