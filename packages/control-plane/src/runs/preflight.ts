import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/**
 * Checks a task's repository before a container is launched.
 *
 * The failure this exists for: pointing a task at a repository that is empty, or at a base
 * branch that does not exist, cost a full dispatch — an ECS task, an image pull, thirty
 * seconds — to discover something `git ls-remote` answers in under one. Worse, the answer
 * arrived as `ambiguous argument 'main'` in a container log rather than on the board.
 *
 * Deliberately a **refusal, not a repair**. An empty repository could be made to work by
 * committing to an orphan branch, but two things argue against doing that quietly: the base
 * sha a run pins for reproducibility would not exist, and GitHub cannot open a pull request
 * into a branch that is not on the remote — so the run would fail at `pr` anyway. Creating
 * the first commit in someone's repository is a much larger liberty than adding a branch to
 * it, and it should be their decision.
 *
 * Runs anonymously unless a token is supplied, which is enough for a public repository and
 * is why the check is cheap.
 */

export interface RepoPreflightOptions {
  readonly repoUrl: string
  readonly baseBranch: string
  /** Used for a private repository. Injected into the URL, never logged. */
  readonly githubToken?: string
  readonly timeoutMs?: number
  /** Injected in tests. */
  readonly lsRemote?: (repoUrl: string) => Promise<string[]>
}

export interface RepoPreflightResult {
  readonly ok: boolean
  /** Present when `ok` is false. Written for whoever is looking at the board. */
  readonly problem?: string
  readonly branches?: readonly string[]
}

export async function preflightRepo(opts: RepoPreflightOptions): Promise<RepoPreflightResult> {
  let branches: string[]
  try {
    branches = opts.lsRemote
      ? await opts.lsRemote(opts.repoUrl)
      : await lsRemoteHeads(opts.repoUrl, opts.githubToken, opts.timeoutMs ?? 15_000)
  } catch (error) {
    // Unreachable, private without a credential, or simply a typo — all one class from here,
    // and all better said now than after a container has started.
    return {
      ok: false,
      problem:
        `cannot read ${redact(opts.repoUrl)}: ${redact(describe(error))}. ` +
        'Check the URL, and that the control plane has a credential if the repository is private.',
    }
  }

  if (branches.length === 0) {
    return {
      ok: false,
      problem:
        `${redact(opts.repoUrl)} has no branches — it is an empty repository. ` +
        'Push an initial commit and dispatch again. A run needs a base commit to branch ' +
        'from, and a pull request needs a base branch that already exists on the remote.',
      branches,
    }
  }

  if (!branches.includes(opts.baseBranch)) {
    return {
      ok: false,
      problem:
        `base branch "${opts.baseBranch}" is not in ${redact(opts.repoUrl)}. ` +
        `It has: ${branches.slice(0, 10).join(', ')}` +
        `${branches.length > 10 ? `, and ${branches.length - 10} more` : ''}.`,
      branches,
    }
  }

  return { ok: true, branches }
}

async function lsRemoteHeads(
  repoUrl: string,
  githubToken: string | undefined,
  timeoutMs: number,
): Promise<string[]> {
  const url = githubToken ? withToken(repoUrl, githubToken) : repoUrl
  const { stdout } = await run('git', ['ls-remote', '--heads', url], {
    timeout: timeoutMs,
    env: {
      ...process.env,
      // Without this a private repository without a credential *prompts*, and the call hangs
      // until the timeout instead of failing with something readable.
      GIT_TERMINAL_PROMPT: '0',
      GIT_ASKPASS: '/bin/true',
    },
  })
  return stdout
    .split('\n')
    .map((line) => line.split('\t')[1])
    .filter((ref): ref is string => Boolean(ref))
    .map((ref) => ref.replace(/^refs\/heads\//, ''))
}

/** Only for https remotes; anything else is returned untouched. */
function withToken(repoUrl: string, token: string): string {
  try {
    const url = new URL(repoUrl)
    if (url.protocol !== 'https:') return repoUrl
    url.username = 'x-access-token'
    url.password = token
    return url.toString()
  } catch {
    return repoUrl
  }
}

/**
 * Strips anything credential-shaped before the message is stored on a run row.
 *
 * `git` echoes the URL it was given, and that URL may carry the token this check injected —
 * which would then be written to the database and shown in the UI.
 */
function redact(text: string): string {
  return text.replace(/\/\/[^@/\s]*:[^@/\s]*@/g, '//<redacted>@')
}

function describe(error: unknown): string {
  if (error instanceof Error) {
    const stderr = (error as { stderr?: string }).stderr
    const first = stderr?.trim().split('\n').filter(Boolean).at(-1)
    return first ?? error.message
  }
  return String(error)
}
