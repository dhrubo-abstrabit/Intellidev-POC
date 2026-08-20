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
  /**
   * The argv, so a failing launch can be logged and reproduced by hand.
   *
   * **Secret values are replaced before this is called.** The argv carries `--env` pairs
   * including the run token, and this is written to the control plane's log — so printing it
   * verbatim would put a live credential in plaintext wherever those logs go. The names are
   * kept, because knowing *which* variables were set is most of the debugging value.
   */
  onArgv?: (argv: readonly string[]) => void
}

/**
 * How a run ended.
 *
 * `exitCode` is `null` when the runtime never reported one — a Fargate task killed for
 * exceeding its memory limit, or one whose image pull failed, has a stop reason but no
 * exit code. Collapsing that to `-1` would make "the container returned failure" and "the
 * container never ran" indistinguishable, which is exactly the distinction a human needs.
 */
export interface RunOutcome {
  runId: string
  exitCode: number | null
  /** Set when the run was stopped for exceeding its wall clock. */
  timedOut: boolean
  /** Runtime-supplied explanation, e.g. an ECS stopped reason. Surfaced to the run row. */
  reason?: string
}

/**
 * A started run.
 *
 * `handle` is available immediately — that is the whole reason this type exists. The
 * previous shape returned only when the container exited, which meant the task ARN could
 * not be recorded until the run was already over: precisely when it is no longer useful
 * for cancelling, and precisely when a control-plane restart would lose it.
 */
export interface RunHandle {
  runId: string
  /** Runtime-specific handle: container name, task ARN. Record this before awaiting. */
  handle: string
  /**
   * Resolves when the run reaches a terminal state.
   *
   * For Docker that is the child process exiting. For Fargate it is currently a poll of
   * `DescribeTasks` — deliberately the weakest part of this implementation, and what C5
   * replaces with `run.finished` plus an EventBridge rule. Until then, a control-plane
   * restart loses the observer and the run needs the C5 reconciler to settle.
   */
  outcome: Promise<RunOutcome>
}

export interface Runner {
  readonly kind: 'docker' | 'fargate'
  /**
   * Launches the run and returns as soon as it has a handle.
   *
   * Split from the outcome because `RunTask` returns a task ARN immediately while
   * `docker run` blocks until exit. Making the Docker shape the interface would have
   * forced Fargate to pretend it was synchronous, and the ARN — the only thing that can
   * cancel or reconcile a run — would have arrived too late to store.
   */
  start(spec: RunLaunchSpec): Promise<RunHandle>
  /** Best-effort stop, for cancellation. */
  stop(handle: string): Promise<void>
}
