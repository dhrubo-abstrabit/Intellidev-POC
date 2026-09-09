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
 * Asserted against the real `tmpdir()`, because the limit applies to the absolute path and
 * macOS's temp directory is itself ~50 characters. A hard-coded prefix would prove nothing
 * about the machine the code runs on.
 */
describe('inline broker socket path', () => {
  // `mkdtemp` appends six random characters, which count toward the limit.
  const MKDTEMP_SUFFIX = 6
  const SOCKET_FILE = '/broker.sock'

  it('fits within the unix socket path limit for a uuid run id', () => {
    const path =
      join(tmpdir(), runtimeDirPrefix(randomUUID())) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(path.length).toBeLessThan(UNIX_SOCKET_PATH_LIMIT)
  })

  it('would not fit if the whole run id were used, which is the bug it guards', () => {
    // Documents the regression rather than trusting the fix to stay obvious: if someone
    // "tidies" the prefix back to the full id, the test above fails and this explains why.
    const naive =
      join(tmpdir(), `intellidev-${randomUUID()}-`) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(naive.length).toBeGreaterThan(UNIX_SOCKET_PATH_LIMIT)
  })

  it('leaves headroom for a longer temp directory than this machine has', () => {
    // CI and containers have shorter temp paths than macOS, but a developer's machine is the
    // tight case. 20 characters of headroom keeps this from being true only here.
    const path =
      join(tmpdir(), runtimeDirPrefix(randomUUID())) + 'X'.repeat(MKDTEMP_SUFFIX) + SOCKET_FILE
    expect(UNIX_SOCKET_PATH_LIMIT - path.length).toBeGreaterThan(20)
  })
})
