#!/usr/bin/env node
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runAdapter } from '../bootstrap/run.js'
// Static, so the bundler includes it: a dynamic relative import is not guaranteed to survive
// bundling, and that failure would only ever appear inside the image.
import { runLoginAgent } from '../login/agent.js'
import {
  LocalCredentialProvider,
  LocalSpecProvider,
  UrlSpecProvider,
} from '../bootstrap/providers.js'
import { ControlPlaneProvider } from '../credentials/control-plane.js'
import { materialiseBundle } from '../bootstrap/bundle.js'
import { WebSocketEventSink } from '../bootstrap/ws-sink.js'
import type { EventReplaySource } from '../bootstrap/run.js'
import { consoleSink, fileSink, multiSink } from '../bootstrap/sinks.js'

/**
 * `intellidev-adapter run --spec <file>`
 *
 * The local entry point: runs one task end to end without a control plane, Postgres or
 * Docker. Everything that would come from the control plane comes from a file and the
 * environment instead, so the interesting parts — harness, stages, gates, git, gateway —
 * can be exercised on a workstation.
 */
export interface CliIo {
  stdout: (text: string) => void
  stderr: (text: string) => void
  env: Record<string, string | undefined>
}

export async function runAdapterCli(argv: readonly string[], io: CliIo): Promise<number> {
  const args = parseArgs(argv)

  /**
   * `login` drives a harness's own sign-in from inside this container.
   *
   * Configured entirely through the environment rather than flags: the control plane sets it
   * when it starts the task, and a bearer token on a command line is visible in
   * `ecs describe-tasks` output and in the console.
   */
  if (args.command === 'login' && !args.help) {
    const missing = [
      'INTELLIDEV_CONTROL_URL',
      'INTELLIDEV_LOGIN_ID',
      'INTELLIDEV_LOGIN_TOKEN',
    ].filter((key) => !io.env[key])
    if (missing.length > 0) {
      io.stderr(`error: login needs ${missing.join(', ')} in the environment\n`)
      return 2
    }
    return runLoginAgent({
      baseUrl: io.env['INTELLIDEV_CONTROL_URL']!,
      loginId: io.env['INTELLIDEV_LOGIN_ID']!,
      token: io.env['INTELLIDEV_LOGIN_TOKEN']!,
      argv: JSON.parse(io.env['INTELLIDEV_LOGIN_ARGV'] ?? '[]') as string[],
      capture: JSON.parse(io.env['INTELLIDEV_LOGIN_CAPTURE'] ?? '[]') as string[],
      ...(io.env['INTELLIDEV_LOGIN_CALLBACK_PORT']
        ? { callbackPort: Number(io.env['INTELLIDEV_LOGIN_CALLBACK_PORT']) }
        : {}),
    })
  }

  if (args.command !== 'run' || args.help) {
    io.stdout(USAGE)
    return args.command === 'run' ? 0 : 2
  }
  if (!args.spec) {
    io.stderr('error: --spec <file|url> is required\n\n' + USAGE)
    return 2
  }

  // A URL means a Fargate dispatch: the control plane wrote the spec to S3 and presigned a
  // GET for that one object, so the run holds no S3 permission of its own.
  const spec = /^https?:\/\//.test(args.spec)
    ? await new UrlSpecProvider({ url: args.spec }).load()
    : await new LocalSpecProvider(args.spec).load()

  // Sockets live in a temp dir locally: `/run` is not writable on a workstation, and
  // failing there would be a confusing first error.
  const runtimeDir = await mkdtemp(join(tmpdir(), `intellidev-${spec.runId}-`))
  const eventLog = args.events ?? join(runtimeDir, 'events.jsonl')

  io.stderr(`run ${spec.runId} · ${spec.harness} · ${spec.task.title}\n`)
  io.stderr(`events → ${eventLog}\n`)

  /**
   * Where the bundle comes from.
   *
   * `--bundle` names a directory that already exists, which is the local Docker path and
   * stays exactly as it was. Without it the bundle is materialised from `spec.bundle` and
   * **verified against its digest before extraction** — the difference between a read-only
   * mount the host controls and an object fetched over the network.
   */
  const bundle = args.bundle
    ? { root: args.bundle, source: 'flag' as const }
    : await materialiseBundle({
        ref: spec.bundle,
        destDir: join(runtimeDir, 'bundle'),
        onProgress: (message) => io.stderr(`${message}\n`),
      })
  io.stderr(`bundle → ${bundle.root} (${bundle.source})\n\n`)

  /**
   * The outbound event socket, when the control plane told us where to dial.
   *
   * Absent locally, where the JSONL file and the console are enough to watch a run. On
   * Fargate there is no shared filesystem, so this is the only way events leave the
   * container — and the run token is the one credential a run legitimately holds.
   */
  const eventsUrl = io.env['INTELLIDEV_EVENTS_URL']
  const runToken = io.env['INTELLIDEV_RUN_TOKEN']
  // Held so the socket can be flushed and closed after the run, rather than left to the
  // process exiting and dropping whatever was still unacknowledged.
  let liveSink: WebSocketEventSink | undefined

  /**
   * Where credentials come from.
   *
   * With a run token, the control plane's broker — which is the point of B3: the container
   * holds one bearer scoped to this run and *asks* for the rest, instead of carrying the
   * GitHub token, every MCP token and the harness seat material in its environment where
   * model-authored code can read them.
   *
   * Without one, the local provider, which reads the developer's own environment. Kept as a
   * separate class rather than a flag so nothing about it can be reached by accident in a
   * deployed run.
   */
  const credentials =
    runToken && spec.controlPlaneUrl
      ? new ControlPlaneProvider({
          baseUrl: spec.controlPlaneUrl,
          runId: spec.runId,
          runAuth: runToken,
        })
      : new LocalCredentialProvider({
          ...(io.env['INTELLIDEV_GITHUB_TOKEN']
            ? { githubToken: io.env['INTELLIDEV_GITHUB_TOKEN'] }
            : {}),
        })
  io.stderr(
    `credentials → ${runToken && spec.controlPlaneUrl ? 'control-plane broker' : 'local environment'}\n`,
  )

  const result = await runAdapter({
    spec,
    credentials,
    sink: multiSink(
      consoleSink({ ...(args.verbose ? { verbose: true } : {}) }),
      fileSink(eventLog),
    ),
    // Constructed inside the hook, because it can only exist once the bus does.
    ...(eventsUrl && runToken
      ? {
          bindSink: (source: EventReplaySource) => {
            const bound = new WebSocketEventSink({
              url: eventsUrl,
              token: runToken,
              runId: spec.runId,
              replayFrom: (seq) => source.replayFrom(seq),
              onAck: (seq) => source.ack(seq),
              onDiagnostic: (message) => io.stderr(`${message}\n`),
            })
            bound.start()
            liveSink = bound
            return bound.sink
          },
        }
      : {}),
    paths: {
      brokerSocket: join(runtimeDir, 'broker.sock'),
      statePath: join(runtimeDir, 'state.json'),
      bundleRoot: bundle.root,
      home: join(runtimeDir, 'home'),
    },
    ...(args.dryRun ? { dryRun: true } : {}),
  })

  // Awaited, so a short run whose first connect attempt failed still gets its events out.
  // Bounded inside `close`, so a dead control plane cannot hold the container open.
  await liveSink?.close()

  io.stderr('\n')
  io.stdout(
    `${result.outcome.toUpperCase()}  stages=${result.records.length}  ` +
      `events=${result.events.length}  credentials=${result.credentialRequests}\n`,
  )
  if (result.prUrl) io.stdout(`PR: ${result.prUrl}\n`)
  if (result.questions.length > 0) {
    // Surfaced deliberately: an unattended run's open questions are the thing a reviewer
    // most needs to see, and they would otherwise be buried in the event log.
    io.stdout(`\nQuestions the agent could not get answered:\n`)
    for (const question of result.questions) io.stdout(`  - ${question}\n`)
  }

  return result.outcome === 'succeeded' ? 0 : 1
}

interface Args {
  command: string
  spec?: string
  bundle?: string
  events?: string
  dryRun?: boolean
  verbose?: boolean
  help?: boolean
}

export function parseArgs(argv: readonly string[]): Args {
  const args: Args = { command: argv[0] ?? '' }
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]
    const next = () => argv[++i]
    switch (flag) {
      case '--spec':
        args.spec = next()
        break
      case '--bundle':
        args.bundle = next()
        break
      case '--events':
        args.events = next()
        break
      case '--dry-run':
        args.dryRun = true
        break
      case '-v':
      case '--verbose':
        args.verbose = true
        break
      case '-h':
      case '--help':
        args.help = true
        break
      default:
        break
    }
  }
  return args
}

export const USAGE = `intellidev-adapter run --spec <file|url> [options]
       intellidev-adapter login   (configured through the environment)

Run one task end to end from a run spec.

Options:
  --spec <file|url>  Run spec JSON, or an https URL to fetch it from (required)
  --bundle <dir>     Project bundle directory: prompts/, skills/, context/
                     Omit it and the bundle is downloaded from the spec and verified
                     against its digest before being extracted.
  --events <file>    Where to append the JSONL event log
  --dry-run          Wire everything up and stop before running a model
  -v, --verbose      Include every event on the console, deltas included

Environment:
  INTELLIDEV_GITHUB_TOKEN   Needed to push and open a PR
`

/* c8 ignore start -- process wiring */
if (process.argv[1]?.includes('adapter')) {
  runAdapterCli(process.argv.slice(2), {
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
    env: process.env,
  })
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(`\nfatal: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    })
}
/* c8 ignore stop */
