import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
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
  error?: string
  /** Tail of the CLI's own output, so a stuck flow can be diagnosed. */
  output?: string
}

interface Recipe {
  /**
   * Where the login runs, which is decided per harness by where its credential lands.
   *
   *  - `container` for Claude Code: on macOS it writes to the Keychain, so a host login leaves
   *    nothing importable, while a Linux login writes exactly the file a run reads.
   *  - `host` for Codex: it stores a file on macOS too, *and* its flow completes through a
   *    callback on localhost — which the browser can reach on the host but not inside a
   *    container, where the server binds the container's own loopback.
   */
  where: 'container' | 'host'
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
}

const LOGIN_RECIPES: Partial<Record<HarnessId, Recipe>> = {
  // Prints an authorize URL, then reads the code from stdin.
  'claude-code': {
    where: 'container',
    argv: ['claude', 'auth', 'login', '--claudeai'],
    capture: ['.claude/.credentials.json'],
    needsCode: true,
  },
  // The normal browser flow rather than `--device-auth`, because device authorization is off by
  // default on a ChatGPT account and enabling it is a setting in someone's security page. Run on
  // the host so the callback on localhost:1455 is the same localhost the browser will visit.
  codex: {
    where: 'host',
    argv: ['codex', 'login'],
    capture: ['.codex/auth.json'],
    needsCode: false,
  },
  // opencode's login is an interactive provider picker with no scriptable form, so it is
  // deliberately absent: importing the file it writes is the honest path there.
}

/** Every URL in the output; which one is the sign-in link is decided in `pickSignInUrl`. */
const URL_PATTERN = /https?:\/\/[^\s'"]+/g
/** A device code, e.g. `ZF8D-ZDTZF`. */
const CODE_PATTERN = /\b([A-Z0-9]{4}-[A-Z0-9]{4,6})\b/

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
  ) {}

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
    await mkdir(join(this.workRoot, 'logins'), { recursive: true })
    this.home = await mkdtemp(join(this.workRoot, 'logins', `${harness}-`))
    const state: LoginState = { harness, status: 'starting', needsCode: recipe.needsCode }
    this.state = state

    // HOME is redirected either way: in a container so the credential outlives it, and on the
    // host so a re-login cannot clobber the developer's own credential file.
    const child =
      recipe.where === 'container'
        ? spawn(
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
        : spawn(recipe.argv[0]!, recipe.argv.slice(1), {
            env: { ...process.env, HOME: this.home },
            stdio: ['pipe', 'pipe', 'pipe'],
          })
    this.child = child

    let seen = ''
    const settleUrl = new Promise<void>((resolve) => {
      const inspect = (chunk: string) => {
        seen += chunk
        state.output = stripAnsi(seen).slice(-1500)

        if (!state.authorizationUrl) {
          const url = pickSignInUrl(stripAnsi(seen))
          if (url) {
            state.authorizationUrl = url
            state.status = recipe.needsCode ? 'awaiting_code' : 'awaiting_authorization'
            resolve()
          }
        }
        if (!state.userCode) {
          const code = CODE_PATTERN.exec(stripAnsi(seen))
          if (code) state.userCode = code[1]
        }
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

  /** Pass the code the human copied from the sign-in page to the waiting CLI. */
  submitCode(code: string): void {
    if (!this.child || !this.state) throw new Error('no login in progress')
    if (!this.state.needsCode) throw new Error('this login does not take a code')
    this.child.stdin.write(`${code.trim()}\n`)
    this.state.status = 'awaiting_authorization'
  }

  cancel(): void {
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
  const candidates = output.match(URL_PATTERN) ?? []
  return candidates
    .map((url) => url.replace(/[.,)]+$/, ''))
    .find((url) => !/^https?:\/\/(localhost|127\.0\.0\.1)/.test(url) && url.includes('?'))
}
