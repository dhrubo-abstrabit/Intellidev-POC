#!/usr/bin/env node
import { BrokerClient } from '../credentials/client.js'

/**
 * `intellidev-cred` — the git credential helper.
 *
 * Wired up with:
 *
 *   git config credential.helper '!intellidev-cred git'
 *
 * The `!` tells git this is a shell command rather than a `git-credential-<name>`
 * binary, so the name does not have to follow git's convention.
 *
 * git calls this on **every** authenticated operation, so it must be cheap and it must
 * never hang: a helper that blocks turns a push into a silent stall. Hence a short
 * timeout and an empty answer rather than an error when anything goes wrong — git reads
 * empty as "no credential" and reports a normal auth failure, which is diagnosable.
 */
export async function runCredHelper(
  argv: readonly string[],
  io: {
    stdin: () => Promise<string>
    stdout: (text: string) => void
    stderr: (text: string) => void
    socketPath: string
  },
): Promise<number> {
  const [subject, operation] = argv

  if (subject !== 'git') {
    io.stderr(`intellidev-cred: unknown subject "${subject ?? ''}"\n`)
    return 2
  }

  // git only expects output from `get`. `store` and `erase` are accepted and ignored:
  // we hold nothing, and refusing them loudly would print noise on every push.
  if (operation !== 'get') return 0

  const body = await io.stdin()
  const client = new BrokerClient(io.socketPath, 5_000)

  try {
    const response = await client.gitCredential(body)
    if (response.trim()) io.stdout(response)
    return 0
  } catch (error) {
    io.stderr(`intellidev-cred: ${(error as Error).message}\n`)
    // Deliberately 0 with no output. A non-zero exit makes git abort the whole
    // operation with a helper error; empty output lets it report the auth failure it
    // actually hit, which is far easier to debug.
    return 0
  }
}

/* c8 ignore start -- process wiring, exercised by the integration test not unit tests */
if (process.argv[1]?.endsWith('cred.js') || process.argv[1]?.endsWith('intellidev-cred')) {
  const socketPath = process.env['INTELLIDEV_BROKER_SOCKET'] ?? '/run/broker.sock'
  runCredHelper(process.argv.slice(2), {
    stdin: () =>
      new Promise<string>((resolve) => {
        let data = ''
        process.stdin.setEncoding('utf8')
        process.stdin.on('data', (chunk: string) => {
          data += chunk
        })
        process.stdin.on('end', () => resolve(data))
        // git closes stdin after the request block, but never assume it will.
        setTimeout(() => resolve(data), 2_000)
      }),
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    socketPath,
  })
    .then((code) => process.exit(code))
    .catch(() => process.exit(0))
}
/* c8 ignore stop */
