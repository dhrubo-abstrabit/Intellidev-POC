import { mkdir, stat } from 'node:fs/promises'
import { GitRunner } from './exec.js'

export interface DiffStat {
  filesChanged: number
  insertions: number
  deletions: number
}

export interface CommitResult {
  sha: string
  filesChanged: number
}

/**
 * Git operations for one run.
 *
 * The mirror is bare and blobless: full history so `git log` and blame work, blobs
 * fetched on demand so a large repo does not dominate the cache-restore budget. The
 * worktree is created from the mirror, which is what lets concurrent runs on one project
 * stay isolated — they each hold their own mirror copy and their own worktree.
 */
export class RunRepo {
  constructor(
    private readonly git: GitRunner,
    private readonly paths: { mirror: string; worktree: string },
  ) {}

  /**
   * Make sure the mirror exists and is current.
   *
   * Fetch rather than clone when it is already there — that is the whole point of
   * caching it. `--prune` matters: without it, branches deleted upstream linger and a
   * stale ref can make a base look resolvable when it is not.
   */
  async ensureMirror(
    repoUrl: string,
    opts: { partial?: boolean } = {},
  ): Promise<'cloned' | 'fetched'> {
    const exists = await this.isRepo(this.paths.mirror)
    if (exists) {
      await this.git.run(
        ['fetch', '--prune', 'origin', '+refs/heads/*:refs/heads/*'],
        this.paths.mirror,
      )
      return 'fetched'
    }

    await mkdir(this.paths.mirror, { recursive: true })
    const args = ['clone', '--bare']
    if (opts.partial !== false) args.push('--filter=blob:none')
    args.push(repoUrl, this.paths.mirror)
    // Clone runs from a parent directory: the target does not exist yet.
    await this.git.run(args, '/')
    return 'cloned'
  }

  private async isRepo(path: string): Promise<boolean> {
    // The directory must exist before git can run *in* it: spawn fails with ENOENT on a
    // missing cwd, which reads as "git is not installed" and sends you hunting the
    // wrong problem entirely.
    const exists = await stat(path)
      .then((s) => s.isDirectory())
      .catch(() => false)
    if (!exists) return false
    const result = await this.git.tryRun(['rev-parse', '--git-dir'], path)
    return result.exitCode === 0
  }

  /** Resolve a ref to a sha in the mirror. */
  async resolve(ref: string): Promise<string> {
    const result = await this.git.run(['rev-parse', ref], this.paths.mirror)
    return result.stdout.trim()
  }

  /**
   * Create the run's worktree on a new branch.
   *
   * The branch is created from an explicit base sha rather than a branch name, so the
   * run is pinned to what it started from even if the base moves underneath it.
   */
  async createWorktree(
    branch: string,
    baseSha: string,
  ): Promise<{ branch: string; baseSha: string }> {
    await mkdir(this.paths.worktree, { recursive: true })
    await this.git.run(
      ['worktree', 'add', '--force', '-b', branch, this.paths.worktree, baseSha],
      this.paths.mirror,
    )
    return { branch, baseSha }
  }

  /** Files changed in the worktree, staged or not, including untracked. */
  async status(): Promise<string[]> {
    const result = await this.git.run(['status', '--porcelain=v1', '-z'], this.paths.worktree)
    return result.stdout
      .split('\0')
      .filter((entry) => entry.length > 3)
      .map((entry) => entry.slice(3))
  }

  async hasChanges(): Promise<boolean> {
    return (await this.status()).length > 0
  }

  /** Diffstat against the base, for the PR body. */
  async diffStat(baseSha: string): Promise<DiffStat> {
    const result = await this.git.run(
      ['diff', '--shortstat', `${baseSha}..HEAD`],
      this.paths.worktree,
    )
    return parseShortstat(result.stdout)
  }

  /**
   * Stage everything and commit.
   *
   * Returns null when there is nothing to commit, rather than creating an empty commit:
   * a run that changed nothing should open no PR, and finding that out here is cheaper
   * than a reviewer finding out later.
   */
  async commitAll(message: string): Promise<CommitResult | null> {
    const changed = await this.status()
    if (changed.length === 0) return null

    await this.git.run(['add', '--all'], this.paths.worktree)
    // `--no-verify`: repo hooks are written for humans and can prompt or reformat, and
    // our gates already cover lint and tests.
    await this.git.run(['commit', '--no-verify', '-m', message], this.paths.worktree)
    const sha = (await this.git.run(['rev-parse', 'HEAD'], this.paths.worktree)).stdout.trim()
    return { sha, filesChanged: changed.length }
  }

  /**
   * Has the base branch moved since we started?
   *
   * Checked before pushing so the PR can say so. We report rather than rebase: a silent
   * rebase can turn a reviewed-clean diff into a wrong one.
   */
  async baseMoved(
    baseBranch: string,
    startedFromSha: string,
  ): Promise<{ moved: boolean; nowSha: string }> {
    // FETCH_HEAD rather than `origin/<branch>`: a **bare** mirror has no
    // remote-tracking refs, so `origin/main` does not resolve in a worktree cut from
    // one. Fetch writes FETCH_HEAD regardless of ref layout, which makes this work for
    // both bare mirrors and ordinary clones.
    await this.git.run(['fetch', 'origin', baseBranch], this.paths.worktree)
    const nowSha = (
      await this.git.run(['rev-parse', 'FETCH_HEAD'], this.paths.worktree)
    ).stdout.trim()
    return { moved: nowSha !== startedFromSha, nowSha }
  }

  /** Push the branch. Never force: history rewrites are deny-listed by design. */
  async push(branch: string): Promise<void> {
    await this.git.run(
      ['push', '--set-upstream', 'origin', `${branch}:${branch}`],
      this.paths.worktree,
    )
  }

  /** Delete the remote branch, so a failed run does not litter the remote. */
  async deleteRemoteBranch(branch: string): Promise<boolean> {
    const result = await this.git.tryRun(
      ['push', 'origin', '--delete', branch],
      this.paths.worktree,
    )
    return result.exitCode === 0
  }

  /** Commit subjects between base and HEAD, oldest first. */
  async commitSubjects(baseSha: string): Promise<string[]> {
    const result = await this.git.run(
      ['log', '--reverse', '--format=%s', `${baseSha}..HEAD`],
      this.paths.worktree,
    )
    return result.stdout.split('\n').filter((line) => line.trim().length > 0)
  }
}

/** Parse `git diff --shortstat`, which omits sections that are zero. */
export function parseShortstat(text: string): DiffStat {
  const files = /(\d+) files? changed/.exec(text)
  const insertions = /(\d+) insertions?\(\+\)/.exec(text)
  const deletions = /(\d+) deletions?\(-\)/.exec(text)
  return {
    filesChanged: files?.[1] ? Number(files[1]) : 0,
    insertions: insertions?.[1] ? Number(insertions[1]) : 0,
    deletions: deletions?.[1] ? Number(deletions[1]) : 0,
  }
}
