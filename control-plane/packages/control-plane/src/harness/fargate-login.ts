import type { LoginTaskLauncher } from './login.js'
import type { FargateRunner } from '../runner/fargate.js'

/**
 * Harness logins as short-lived Fargate tasks.
 *
 * The hosted control plane cannot sign in to anything itself: its image carries no harness CLI
 * and no docker, and Fargate cannot run a container inside a container. The runner image already
 * has all three CLIs, so the login runs there — driven exactly like a run, with the container
 * dialling out and nothing reaching in.
 *
 * **One task per login, discarded afterwards.** Nothing is reused between connections: a fresh
 * task, a fresh token, a fresh HOME. That is not only tidiness — a container that had already
 * signed in to one harness would carry that CLI's session into the next login, and "connect
 * codex" could quietly capture a credential belonging to the previous attempt.
 */
export class FargateLoginLauncher implements LoginTaskLauncher {
  /** Task ARNs by login id, so a cancelled login can actually be stopped. */
  private readonly running = new Map<string, string>()

  constructor(
    private readonly runner: Pick<FargateRunner, 'start' | 'stop'>,
    /** How the container reaches this control plane. Its own public URL. */
    private readonly controlUrl: string,
    /** The runner image, which is where the harness CLIs actually live. */
    private readonly image: string,
  ) {}

  async start(spec: {
    loginId: string
    token: string
    argv: readonly string[]
    capture: readonly string[]
    callbackPort?: number
  }): Promise<void> {
    const handle = await this.runner.start({
      // The launch spec is keyed by run id; a login has none, so its own id stands in. It is a
      // uuid either way, and it is what the task's tags will carry.
      runId: spec.loginId,
      image: this.image,
      args: ['login'],
      /**
       * A ceiling, because a login nobody finishes would otherwise bill until the platform's
       * own limit. Ten minutes is longer than any sign-in takes and short enough to forget.
       */
      timeoutSec: 600,
      env: {
        INTELLIDEV_CONTROL_URL: this.controlUrl,
        INTELLIDEV_LOGIN_ID: spec.loginId,
        INTELLIDEV_LOGIN_TOKEN: spec.token,
        INTELLIDEV_LOGIN_ARGV: JSON.stringify(spec.argv),
        INTELLIDEV_LOGIN_CAPTURE: JSON.stringify(spec.capture),
        ...(spec.callbackPort ? { INTELLIDEV_LOGIN_CALLBACK_PORT: String(spec.callbackPort) } : {}),
      },
    })
    this.running.set(spec.loginId, handle.handle)
  }

  async stop(loginId: string): Promise<void> {
    const handle = this.running.get(loginId)
    if (!handle) return
    this.running.delete(loginId)
    await this.runner.stop(handle)
  }
}
