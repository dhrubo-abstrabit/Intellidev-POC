/**
 * The seam that keeps the runtime swappable.
 *
 * Conceptually this belongs to the control plane's orchestrator, not the adapter — it
 * launches adapters rather than being one. It lives here only until there is a
 * control-plane package, and it is deliberately small so moving it is a file rename.
 *
 * Two implementations matter: Docker for local validation, and Fargate for deployment.
 * The whole point of writing the interface before either is that the adapter already dials
 * *out* for events and pulls credentials over a socket, so neither implementation needs to
 * reach into a running container.
 */
export interface RunLaunchSpec {
  runId: string
  /** Golden image reference, pinned by tag or digest. */
  image: string
  /** Argv for the adapter entrypoint. */
  args: readonly string[]
  env?: Record<string, string>
  /** Host paths or named volumes to make visible inside the container. */
  mounts?: Array<{ source: string; target: string; readOnly?: boolean }>
  /** Named volume for the project cache, so it survives the run. */
  cacheVolume?: { name: string; target: string }
  cpus?: number
  memoryMb?: number
  /** Wall-clock ceiling. A hung run bills for as long as it is allowed to live. */
  timeoutSec?: number
  /** Streamed as the run produces it, rather than collected at the end. */
  onOutput?: (stream: 'stdout' | 'stderr', chunk: string) => void
  /** The exact argv, so a failing launch can be logged and reproduced by hand. */
  onArgv?: (argv: readonly string[]) => void
}

export interface RunLaunchResult {
  runId: string
  exitCode: number
  /** Set when the run was killed for exceeding its wall clock. */
  timedOut: boolean
  /** Runtime-specific handle: container id, task ARN. Recorded on the run row. */
  handle: string
}

export interface Runner {
  readonly kind: 'docker' | 'fargate'
  launch(spec: RunLaunchSpec): Promise<RunLaunchResult>
  /** Best-effort stop, for cancellation. */
  stop(handle: string): Promise<void>
}
