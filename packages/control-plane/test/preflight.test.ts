import { describe, expect, it } from 'vitest'
import { preflightRepo } from '../src/runs/preflight.js'

/**
 * The point of pre-flight is refusing for free.
 *
 * Each case below used to cost a whole dispatch — an ECS task and a 387 MB image pull — to
 * discover, and surfaced as a git error inside a container log rather than on the board.
 */

const REPO = 'https://github.com/acme/widget.git'

describe('an empty repository', () => {
  it('is refused, with the reason and the fix', async () => {
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'main',
      lsRemote: async () => [],
    })
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/empty repository/)
    // The fix belongs in the message: this is the first thing a new project hits.
    expect(result.problem).toMatch(/Push an initial commit/)
  })

  it('explains why it is not simply handled', async () => {
    // Deliberately a refusal rather than a repair: a run pins a base sha that would not
    // exist, and GitHub cannot open a pull request into a branch absent from the remote.
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'main',
      lsRemote: async () => [],
    })
    expect(result.problem).toMatch(/base commit to branch from/)
    expect(result.problem).toMatch(/already exists on the remote/)
  })
})

describe('a base branch that is not there', () => {
  it('lists what the repository does have', async () => {
    // The common real case: the form defaults to `main` and the repository uses `master`.
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'main',
      lsRemote: async () => ['master', 'develop'],
    })
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/"main" is not in/)
    expect(result.problem).toMatch(/master, develop/)
  })

  it('truncates a long branch list rather than printing hundreds', async () => {
    const many = Array.from({ length: 25 }, (_, i) => `branch-${i}`)
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'main',
      lsRemote: async () => many,
    })
    expect(result.problem).toMatch(/and 15 more/)
  })

  it('accepts a branch that exists', async () => {
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'develop',
      lsRemote: async () => ['master', 'develop'],
    })
    expect(result).toMatchObject({ ok: true })
  })
})

describe('an unreachable repository', () => {
  it('is refused with what git said, and what to check', async () => {
    const result = await preflightRepo({
      repoUrl: REPO,
      baseBranch: 'main',
      lsRemote: async () => {
        throw Object.assign(new Error('exit 128'), {
          stderr:
            "remote: Repository not found.\nfatal: repository 'https://github.com/acme/widget.git/' not found",
        })
      },
    })
    expect(result.ok).toBe(false)
    expect(result.problem).toMatch(/not found/)
    // Private-without-a-credential and a typo look identical from here, so say both.
    expect(result.problem).toMatch(/if the repository is private/)
  })

  it('never puts a credential in the message', async () => {
    // `git` echoes the URL it was handed, and this check injects a token into it. That
    // message is stored on a run row and rendered in the UI.
    const result = await preflightRepo({
      repoUrl: 'https://github.com/acme/widget.git',
      baseBranch: 'main',
      githubToken: 'ghp_supersecret',
      lsRemote: async () => {
        throw Object.assign(new Error('failed'), {
          stderr:
            "fatal: could not read from 'https://x-access-token:ghp_supersecret@github.com/acme/widget.git'",
        })
      },
    })
    expect(result.problem).not.toMatch(/ghp_supersecret/)
    expect(result.problem).toMatch(/<redacted>/)
  })
})
