import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { oauthFlowFor, pkce, type OAuthFlow } from './oauth-login.js'
import { mkdir, mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { HarnessId } from '@intellidev/shared'
import type { HarnessAccount } from './accounts.js'
import type { SeatStore, SpaceScope } from './seat-store.js'

/**
 * Sign in to a harness by driving that harness's own login command.
 *
 * The OAuth client belongs to the vendor — the URL Claude Code emits carries Anthropic's client
 * id, Anthropic's PKCE challenge and Anthropic's callback — so this relays their flow rather than
 * reimplementing it. The control plane spawns the CLI, scrapes the URL it prints, hands that to
 * the browser, and passes the resulting code back on stdin.
 *
 * **The login runs inside a container, not on the host.** Two reasons, both load-bearing: on
 * macOS these CLIs keep credentials in the Keychain, so a host login would produce nothing
 * importable *and* could disturb the developer's own session; and a Linux login writes exactly
 * the file layout a run needs, so what is captured is guaranteed to be what the harness reads.
 */
export type LoginStatus =
  'starting' | 'awaiting_code' | 'awaiting_authorization' | 'connected' | 'failed'

export interface LoginState {
  harness: HarnessId
  status: LoginStatus
  /** Where to send the human. */
  authorizationUrl?: string
  /** Device-code flows show a code the human types into that page. */
  userCode?: string
  /** True when the CLI expects the code pasted back on stdin. */
  needsCode: boolean
  /**
   * What the person should paste, when "the code" would be misleading.
   *
   * Codex is the case: run as a task, its callback lands on a page the browser cannot load, and
   * the address of that failed page is what completes the flow.
   */
  inputHint?: string
  error?: string
  /** Tail of the CLI's own output, so a stuck flow can be diagnosed. */
  output?: string
}

interface Recipe {
  /** Argv for the login. */
  argv: string[]
  /**
   * Ports to publish, for a login that completes through a local callback.
   *
   * Codex's normal flow starts a server on 1455 and asks the authorization server to redirect
   * there, so the browser on the host has to be able to reach into the container.
   */
  ports?: string[]
  /** Credential files to capture from the container's HOME afterwards. */
  capture: string[]
  /** Whether the CLI reads the authorization code from stdin. */
  needsCode: boolean
  /** What to tell the person to paste back, when it is not simply "the code". */
  inputHint?: string
  /**
   * Prefer the container even when a direct flow exists.
   *
   * True for codex only, and only because its direct flow ends on a page that says "This site
   * can't be reached". That is the flow working — the redirect targets a server its CLI would run
   * on your machine — but nobody reads it that way, and the device flow has no such step. Where
   * there is no container to run, the direct flow is still the better of what remains.
   */
  preferTask?: boolean
  /**
   * Where this CLI's own callback server listens, when it has one.
   *
   * Only meaningful for a login running as a task: the browser's redirect to that port lands on
   * the person's machine and fails, and the container replays the URL against this port instead.
   */
  callbackPort?: number
}

const LOGIN_RECIPES: Partial<Record<HarnessId, Recipe>> = {
  // Prints an authorize URL, then reads the code from stdin.
  'claude-code': {
    argv: ['claude', 'auth', 'login', '--claudeai'],
    capture: ['.claude/.credentials.json'],
    needsCode: true,
  },
  /**
   * The normal browser flow rather than `--device-auth`.
   *
   * The device flow does exist in the pinned CLI (0.147.0), and it is callback-free — but it is
   * beta and off until someone enables device code login in their ChatGPT security settings, so
   * it cannot be the path a first sign-in takes by default. Worth revisiting if that changes:
   * it would remove the callback dance entirely.
   *
   * `host` because the callback on localhost:1455 has to be the same localhost the browser
   * visits — true when the control plane runs on someone's machine, false when it is hosted.
   * `start` refuses there rather than spawning something that cannot succeed, and points at
   * signing in from a local UI, which writes to the same shared seat store.
   */
  /**
   * Device code, not the browser callback.
   *
   * The callback flow redirects to `localhost:1455` — a server the CLI runs on *your* machine.
   * Hosted there is no such machine, so the browser lands on "This site can't be reached" and
   * the person has to copy an address out of a failed page. That works, and it looks broken.
   *
   * The device flow has none of that: a plain page, a code to type, and the CLI polls until it
   * is approved. Nothing to paste back, and nothing that looks like an error. It costs a
   * container, because the CLI holds the device code and does the polling — worth it to remove
   * the one step in this product that made people ask whether it had failed.
   *
   * Device login has to be enabled once in ChatGPT security settings. It is on for the account
   * this was tested with; when it is off the CLI says so plainly, which is a better failure than
   * a broken-looking page.
   */
  codex: {
    argv: ['codex', 'login', '--device-auth'],
    capture: ['.codex/auth.json'],
    // Nothing comes back to us: the code goes to the vendor's page and the CLI waits.
    needsCode: false,
    preferTask: true,
  },
  // opencode's login is an interactive provider picker with no scriptable form, so it is
  // deliberately absent: importing the file it writes is the honest path there.
}

/** Every URL in the output; which one is the sign-in link is decided in `pickSignInUrl`. */
const URL_PATTERN = /https?:\/\/[^\s'"]+/g
/** A device code, e.g. `ZF8D-ZDTZF`. */
const CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/

/**
 * How a login task is started, when the control plane cannot spawn one itself.
 *
 * Injected rather than imported so this file stays free of ECS: the same driving logic runs
 * against a local child process in development and against a Fargate task when hosted.
 */
/**
 * How a sign-in is performed.
 *
 * `direct` is the default because it needs nothing but this process. `task` exists so a vendor
 * changing their flow is a configuration change rather than an outage — the CLI adapts to its own
 * vendor, which is the one advantage it has.
 */
export type LoginMode = 'direct' | 'task'

export interface LoginTaskLauncher {
  start(spec: {
    loginId: string
    token: string
    argv: readonly string[]
    capture: readonly string[]
    callbackPort?: number
  }): Promise<void>
  stop(loginId: string): Promise<void>
}

/** What the container asks for and what it is told. */
export interface LoginInput {
  kind: 'code' | 'callback' | 'cancel'
  value?: string
}

export function loginSupported(harness: HarnessId): boolean {
  return harness in LOGIN_RECIPES
}

export class HarnessLogin {
  private child?: ChildProcessWithoutNullStreams
  private state?: LoginState
  private home?: string
  private recipe?: Recipe

  constructor(
    private readonly accounts: SeatStore,
    /** The space the seat is connected into. Seats are shared across its projects. */
    private readonly scope: SpaceScope,
    private readonly image: string,
    /**
     * Where the login's throwaway HOME goes.
     *
     * Under the work root, not `os.tmpdir()`: on macOS the temp dir is `/var/folders/...`, which
     * Docker Desktop does not share, so bind-mounting it fails with "bind source path does not
     * exist" even though the path is right there. The same trap as the run exchange directory.
     */
    private readonly workRoot: string,
    /**
     * Present when this control plane cannot spawn a login itself.
     *
     * Hosted, it has neither docker nor the harness CLIs, and Fargate cannot nest containers —
     * so the login runs as a task from the runner image, which has all three. Absent in
     * development, where spawning locally is both possible and faster.
     */
    private readonly launcher?: LoginTaskLauncher,
    /**
     * Which sign-in path to take.
     *
     * `direct` drives the OAuth flow here — two HTTP calls, no container, seconds rather than a
     * minute. `task` drives the harness's own CLI in a container, which is slower but is the
     * vendor's own code deciding what a sign-in looks like.
     *
     * Both are kept and switchable on purpose. The direct flow's parameters were read off a real
     * authorize URL rather than documented, so a vendor changing them would break it — and the
     * remedy should be a setting rather than a deploy of reverted code.
     */
    private readonly mode: LoginMode = 'direct',
  ) {}

  /**
   * Set while a direct OAuth sign-in is in flight.
   *
   * The verifier is the secret half of the PKCE pair and never leaves this process; the code the
   * person pastes is useless without it, which is what lets the whole flow happen here rather
   * than inside a container running the harness's own CLI.
   */
  private direct?: {
    harness: HarnessId
    flow: OAuthFlow
    verifier: string
    state: LoginState
    expectedState: string
  }

  /** Set while a task-driven login is in flight, so its reports can be attributed. */
  private task?: {
    loginId: string
    token: string
    state: LoginState
    recipe: Recipe
    seen: string
    pending?: LoginInput
    settle?: () => void
  }

  current(): LoginState | undefined {
    return this.state
  }

  /**
   * Start a login and resolve once the URL has been scraped.
   *
   * Resolving on the URL rather than on completion is what lets the UI open a window promptly;
   * the rest of the flow is observed through `current()`.
   */
  async start(harness: HarnessId): Promise<LoginState> {
    const recipe = LOGIN_RECIPES[harness]
    if (!recipe) throw new Error(`${harness} has no scriptable login; import its file instead`)

    this.cancel()
    this.recipe = recipe

    /**
     * The direct flow first, wherever there is one.
     *
     * It needs no container and no CLI: two HTTP calls and the code the person pastes. The task
     * path remains for harnesses without one, and as the thing to fall back to if a vendor
     * changes a flow we now drive ourselves.
     */
    /**
     * Which path, and why.
     *
     * `task` mode forces the CLI. Otherwise the direct flow wins — instant, no container —
     * except where a recipe asks for the container *and* there is one to run, which today means
     * codex: its device flow removes a step that looks like a failure, and that is worth a
     * container.
     */
    const preferTask = recipe.preferTask && this.launcher !== undefined
    const flow = this.mode === 'direct' && !preferTask ? oauthFlowFor(harness) : undefined
    if (flow) return this.startDirect(harness, flow)

    if (this.launcher) return this.startTask(harness, recipe)
    await mkdir(join(this.workRoot, 'logins'), { recursive: true })
    this.home = await mkdtemp(join(this.workRoot, 'logins', `${harness}-`))
    const state: LoginState = {
      harness,
      status: 'starting',
      needsCode: recipe.needsCode,
      ...(recipe.inputHint ? { inputHint: recipe.inputHint } : {}),
    }
    this.state = state

    // HOME is redirected either way: in a container so the credential outlives it, and on the
    // host so a re-login cannot clobber the developer's own credential file.
    /**
     * Always a container.
     *
     * A `host` variant existed for codex, whose callback had to land on the same localhost the
     * browser would visit. Its device flow needs no callback at all, so nothing runs on the host
     * any more — and a login that writes to the developer's own HOME was never something to keep
     * for its own sake.
     */
    const child = spawn(
      'docker',
      [
        'run',
        '--rm',
        // Keeps stdin open for the code.
        '-i',
        '--mount',
        `type=bind,source=${this.home},target=/home/adapter`,
        '--entrypoint',
        recipe.argv[0]!,
        this.image,
        ...recipe.argv.slice(1),
      ],
      { stdio: ['pipe', 'pipe', 'pipe'] },
    )
    this.child = child

    let seen = ''
    const settleUrl = new Promise<void>((resolve) => {
      const inspect = (chunk: string) => {
        seen += chunk
        if (applyOutput(state, seen, recipe)) resolve()
      }
      child.stdout.on('data', (buffer: Buffer) => inspect(buffer.toString('utf8')))
      child.stderr.on('data', (buffer: Buffer) => inspect(buffer.toString('utf8')))
      // A CLI that never prints a link should not hang the request for ever.
      setTimeout(resolve, 25_000)
    })

    // The captured state, recipe and home are passed in rather than read back off `this`.
    // FOUND BY RUNNING IT: cancelling one login and starting another had the first child's exit
    // handler write its failure into the second login's state, because `finish` read the
    // instance fields and those had already moved on.
    child.on(
      'close',
      (code) =>
        void this.finish({
          state,
          recipe,
          home: this.home!,
          exitCode: code ?? 1,
          output: stripAnsi(seen),
        }),
    )
    child.on('error', (error) => {
      state.status = 'failed'
      state.error = error.message
    })

    await settleUrl
    if (state.status === 'starting') {
      state.status = 'failed'
      state.error = `no sign-in link appeared; the CLI said: ${
        stripAnsi(seen).slice(-300) || '(nothing)'
      }`
    }
    return state
  }

  /**
   * Sign in with no container and no CLI.
   *
   * Resolves immediately with the authorize URL, because there is nothing to wait for: the URL
   * is built here rather than scraped out of a subprocess's output. That also removes the
   * forty-second timeout the task path needs, and the class of failure where a CLI starts, says
   * nothing useful, and leaves a person looking at a spinner.
   */
  private async startDirect(harness: HarnessId, flow: OAuthFlow): Promise<LoginState> {
    const { verifier, challenge } = pkce()
    // Bound to this attempt, and checked on the way back: a code pasted from a different
    // sign-in would otherwise connect whichever account that was.
    const expectedState = randomBytes(32).toString('base64url')

    const state: LoginState = {
      harness,
      status: 'awaiting_code',
      needsCode: true,
      authorizationUrl: flow.authorizeUrl({ challenge, state: expectedState }),
      inputHint: flow.inputHint,
    }
    this.state = state
    this.direct = { harness, flow, verifier, state, expectedState }
    return state
  }

  /**
   * Finish a direct sign-in with whatever the person pasted.
   *
   * Returns the settled state rather than resolving quietly, so the UI can say what happened
   * without polling for it.
   */
  private async completeDirect(pasted: string): Promise<void> {
    const direct = this.direct
    if (!direct) return
    const { flow, verifier, state, expectedState, harness } = direct
    state.status = 'awaiting_authorization'

    try {
      const credential = await flow.exchange({
        code: pasted,
        verifier,
        state: expectedState,
      })
      // Cleared before storing, so a second paste of the same code cannot run the exchange twice
      // — the provider would refuse it as replay, and the message would be confusing.
      this.direct = undefined

      await this.accounts.connect(this.scope, {
        harness,
        label: harness,
        files: [{ path: credential.path, contents: credential.contents }],
        connectedAt: new Date().toISOString(),
        importedFrom: 'signed in through the control plane',
      })
      state.status = 'connected'
    } catch (error) {
      this.direct = undefined
      state.status = 'failed'
      state.error = error instanceof Error ? error.message : String(error)
    }
  }

  /**
   * Drive a login that runs as a task somewhere else.
   *
   * Resolves once the container has forwarded enough output to contain the sign-in link, so the
   * UI behaves exactly as it does locally: click, a window opens, paste what comes back.
   *
   * The state lives in this process, which is correct only while there is one of them. With a
   * second instance a login started on one would be invisible to the other, and this would need
   * to move into the database like run tokens did — noted here because the failure would look
   * like a login that forgets itself at random rather than like a missing table.
   */
  private async startTask(harness: HarnessId, recipe: Recipe): Promise<LoginState> {
    const loginId = randomUUID()
    // 32 bytes, so guessing it is not a route to someone's harness credential.
    const token = randomBytes(32).toString('base64url')
    const state: LoginState = {
      harness,
      status: 'starting',
      needsCode: recipe.needsCode,
      ...(recipe.inputHint ? { inputHint: recipe.inputHint } : {}),
    }
    this.state = state
    this.task = { loginId, token, state, recipe, seen: '' }

    const settleUrl = new Promise<void>((resolve) => {
      this.task!.settle = resolve
      // A task that never prints a link must not hang the request; it can still be polled.
      setTimeout(resolve, 40_000)
    })

    try {
      await this.launcher!.start({
        loginId,
        token,
        argv: recipe.argv,
        capture: recipe.capture,
        ...(recipe.callbackPort ? { callbackPort: recipe.callbackPort } : {}),
      })
    } catch (error) {
      state.status = 'failed'
      state.error = `could not start the login task: ${
        error instanceof Error ? error.message : String(error)
      }`
      return state
    }

    await settleUrl
    if (state.status === 'starting') {
      // Not failed: the task may simply be slow to pull the image, and the UI keeps polling.
      state.error = state.output
        ? undefined
        : 'the login task has not reported yet — it may still be starting'
    }
    return state
  }

  /** Whether a bearer belongs to the login in flight. */
  verifyTaskToken(loginId: string, authorization: string | undefined): boolean {
    const task = this.task
    if (!task || task.loginId !== loginId) return false
    const offered = authorization?.replace(/^Bearer /i, '') ?? ''
    // Length-independent comparison is not needed for a value this short-lived, but a plain
    // equality on a secret is worth being explicit about.
    return (
      offered.length === task.token.length &&
      timingSafeEqual(Buffer.from(offered), Buffer.from(task.token))
    )
  }

  /** Output forwarded by the container, folded in as if it were local stdout. */
  ingestTaskOutput(loginId: string, chunk: string): void {
    const task = this.task
    if (!task || task.loginId !== loginId) return
    task.seen += chunk
    if (applyOutput(task.state, task.seen, task.recipe)) task.settle?.()
  }

  /** Hand the container whatever the person supplied, once. */
  takeTaskInput(loginId: string): LoginInput | undefined {
    const task = this.task
    if (!task || task.loginId !== loginId) return undefined
    const pending = task.pending
    task.pending = undefined
    return pending
  }

  /** The task finished; store what it captured. */
  async completeTask(
    loginId: string,
    report: {
      exitCode: number
      files: HarnessAccount['files']
      missing?: string[]
      output?: string
    },
  ): Promise<void> {
    const task = this.task
    if (!task || task.loginId !== loginId) return
    const { state, recipe } = task
    this.task = undefined

    if (!report.files || report.files.length === 0) {
      state.status = 'failed'
      state.error =
        report.exitCode === 0
          ? `the login reported success but wrote no credential file${
              report.missing?.length ? ` (looked for ${report.missing.join(', ')})` : ''
            }`
          : `login exited ${report.exitCode}: ${report.output?.slice(-300) || '(no output)'}`
      return
    }

    await this.accounts.connect(this.scope, {
      harness: state.harness,
      label: state.harness,
      files: report.files,
      connectedAt: new Date().toISOString(),
      importedFrom: `${recipe.argv.join(' ')} (in a login task)`,
    })
    state.status = 'connected'
  }

  /** Pass the code the human copied from the sign-in page to the waiting CLI. */
  submitCode(code: string): void {
    const trimmed = code.trim()
    if (this.direct) {
      // Not awaited: the caller is an HTTP handler that should answer at once, and the outcome
      // is observed through `current()` exactly as the task path's is.
      void this.completeDirect(trimmed)
      return
    }
    if (this.task) {
      /**
       * A URL rather than a code, for a CLI whose callback the browser could not reach.
       *
       * Codex redirects to `localhost:1455`, which is the person's machine and not the task's —
       * so the redirect fails with the authorization code in the address bar. Pasting that URL
       * lets the container replay it against its own callback server, which is the one holding
       * the PKCE verifier. Distinguished by shape, so the person pastes whatever they were
       * given without being asked which kind it is.
       */
      const kind = /^https?:\/\//.test(trimmed) ? 'callback' : 'code'
      this.task.pending = { kind, value: trimmed }
      this.task.state.status = 'awaiting_authorization'
      return
    }
    if (!this.child || !this.state) throw new Error('no login in progress')
    if (!this.state.needsCode) throw new Error('this login does not take a code')
    this.child.stdin.write(`${trimmed}\n`)
    this.state.status = 'awaiting_authorization'
  }

  cancel(): void {
    if (this.direct) {
      this.direct.state.status = 'failed'
      this.direct.state.error = 'cancelled'
      // Nothing to stop: no container was started, and the verifier dies with this object.
      this.direct = undefined
    }
    const task = this.task
    if (task) {
      this.task = undefined
      task.state.status = 'failed'
      task.state.error = 'cancelled'
      // Told to stop, then stopped: the container may be mid-poll, and a task left running
      // holds a sign-in window open for as long as its timeout.
      task.pending = { kind: 'cancel' }
      void this.launcher?.stop(task.loginId).catch(() => {})
    }
    const child = this.child
    this.child = undefined
    if (this.state && this.state.status !== 'connected') {
      this.state.status = 'failed'
      this.state.error = 'cancelled'
    }
    child?.kill('SIGTERM')
  }

  /** Read what the CLI wrote and store it as the account for this harness. */
  private async finish(args: {
    state: LoginState
    recipe: Recipe
    home: string
    exitCode: number
    output: string
  }): Promise<void> {
    const { state, recipe, home, exitCode, output } = args
    // A login that was cancelled or already superseded has nothing to report.
    if (this.state !== state) return
    if (state.status === 'failed' && state.error === 'cancelled') return

    const files: HarnessAccount['files'] = []
    for (const path of recipe.capture) {
      const contents = await readFile(join(home, path), 'utf8').catch(() => null)
      if (contents) files.push({ path, contents })
    }

    if (files.length === 0) {
      state.status = 'failed'
      // An exit code alone is rarely enough; the CLI's own words usually name the cause.
      state.error =
        exitCode === 0
          ? 'the login reported success but wrote no credential file'
          : `login exited ${exitCode}: ${output.slice(-300) || '(no output)'}`
      return
    }

    await this.accounts.connect(this.scope, {
      harness: state.harness,
      label: state.harness,
      files,
      connectedAt: new Date().toISOString(),
      importedFrom: `${recipe.argv.join(' ')} (in ${this.image})`,
    })
    state.status = 'connected'
  }
}

/**
 * Strip terminal styling so the URL and code can be found in plain text.
 *
 * Matches the escape by code point rather than as a literal control character, which keeps this
 * file free of bytes that tooling tends to mangle.
 */
function stripAnsi(text: string): string {
  return text.replace(new RegExp(`${String.fromCharCode(27)}\\[[0-9;?]*[a-zA-Z]`, 'g'), '')
}

/**
 * Choose the sign-in link out of everything the CLI printed.
 *
 * FOUND BY RUNNING IT. Codex announces its own callback server first —
 * `Starting local login server on http://localhost:1455.` — so taking the first URL sent people
 * to a blank local page instead of OpenAI. A loopback address is never where a human signs in,
 * and the real link always carries query parameters.
 */
export function pickSignInUrl(output: string): string | undefined {
  const candidates = (output.match(URL_PATTERN) ?? []).map((url) => url.replace(/[.,)]+$/, ''))
  // Never loopback: that is the CLI announcing its own callback server, and sending someone
  // there shows them a blank page at best.
  const remote = candidates.filter((url) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url))

  /**
   * A query string is a strong hint, not a requirement.
   *
   * An authorization URL carries its parameters, so preferring one is how a plain announcement
   * or a docs link in the same output is skipped. But a device-code flow sends someone to a bare
   * page — `https://auth.openai.com/codex/device` — and passes the code separately, so requiring
   * a query discarded the only URL there was and the login sat showing nothing.
   *
   * The fallback is therefore narrow: a bare URL qualifies only if its path says what it is. A
   * link to documentation in the same output must still lose.
   */
  return remote.find((url) => url.includes('?')) ?? remote.find(looksLikeSignIn)
}

/**
 * Fold new CLI output into the login's state.
 *
 * Shared by both transports: a local child's stdout and a container's forwarded chunks are the
 * same bytes, and the URL has to be found in either. Returns true once the sign-in link is
 * known, which is what a caller waits on before answering the request.
 */
function applyOutput(state: LoginState, seen: string, recipe: Recipe): boolean {
  const plain = stripAnsi(seen)
  state.output = plain.slice(-1500)

  if (!state.userCode) {
    const code = CODE_PATTERN.exec(plain)
    if (code) state.userCode = code[1]
  }
  if (state.authorizationUrl) return false

  const url = pickSignInUrl(plain)
  if (!url) return false
  state.authorizationUrl = url
  state.status = recipe.needsCode ? 'awaiting_code' : 'awaiting_authorization'
  return true
}

/**
 * Whether a URL with no parameters is nonetheless where someone signs in.
 *
 * Only the path is read. Matching on the host would admit every link a vendor prints, and these
 * words are what a sign-in page is actually called across the flows we drive.
 */
function looksLikeSignIn(url: string): boolean {
  try {
    return /\/(device|login|signin|sign-in|authorize|oauth)(\/|$)/i.test(new URL(url).pathname)
  } catch {
    return false
  }
}
