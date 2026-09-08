import type { AgentEvent, GitStrategy, HarnessId, TaskBrief } from '@intellidev/shared'
import type { BuiltinActions, StageContext } from '../stages/types.js'
import { GitHubClient, parseRepoRef } from './github.js'
import { buildCommitMessage, buildPullRequestBody, buildPullRequestTitle } from './pr-body.js'
import type { RunRepo } from './repo.js'
import type { EventBus } from '../events/bus.js'

/**
 * The builtin stages: the deterministic ones that are ours rather than the model's.
 *
 * Branch creation and PR opening deliberately run no agent. There is nothing to reason
 * about — the branch name comes from the manifest pattern, and the PR body comes from the
 * event log — and making them agent stages would mean a model could get them wrong.
 */
export interface GitBuiltinsOptions {
  repo: RunRepo
  github: GitHubClient
  bus: EventBus
  git: GitStrategy
  task: TaskBrief
  harness: HarnessId
  repoUrl: string
  baseBranch: string
  branch: string
  /** Resolved at bootstrap, so the run is pinned to what it started from. */
  baseSha: string
  /** Records and events for the PR body, read at PR time. */
  snapshot: () => {
    events: readonly AgentEvent[]
    records: readonly import('@intellidev/shared').StageRecord[]
  }
  runUrl?: string
}

export class GitBuiltins implements BuiltinActions {
  constructor(private readonly opts: GitBuiltinsOptions) {}

  async createBranch(_ctx: StageContext): Promise<{ branch: string; from: string }> {
    // The worktree already exists from bootstrap; this stage records the fact so the
    // event log shows where the branch came from.
    return { branch: this.opts.branch, from: this.opts.baseSha }
  }

  /**
   * Commit the worktree as its own stage.
   *
   * Split out of `openPullRequest` because bundling the two meant a template with no `pr`
   * stage never committed at all: the agent's edits lived in the worktree and died with the
   * container. A commit is worth having whether or not a PR follows it.
   *
   * Safe to run twice — `commitAll` returns null when the tree is clean — so
   * `openPullRequest` still calls it for templates that have no commit stage.
   */
  async commit(_ctx: StageContext): Promise<{ sha: string; filesChanged: number } | null> {
    const { repo, bus, task } = this.opts
    const commit = await repo.commitAll(buildCommitMessage(task))
    if (!commit) return null
    bus.emit({
      type: 'git.committed',
      data: {
        sha: commit.sha,
        message: buildPullRequestTitle(task),
        filesChanged: commit.filesChanged,
      },
    })
    return commit
  }

  /**
   * Commit and push, so the next container can pick up where this one stopped.
   *
   * Exactly the argument `commit` above makes for a template with no `pr` stage — the edits
   * live in the worktree and die with the container — applied to the case nobody applied it
   * to: a run that parks for approval. The container is destroyed while it waits.
   *
   * Pushed as well as committed, because a commit in a destroyed container's worktree is no
   * more durable than the worktree. The push also puts the change where the person deciding
   * can read it, which is what a review gate is for.
   *
   * Deliberately not a pull request: whether one is wanted is the `pr` stage's business, and a
   * gate can sit anywhere.
   */
  async preserveWork(ctx: StageContext): Promise<{ sha: string; branch: string } | null> {
    const commit = await this.commit(ctx)
    // Nothing changed — a gate after a read-only stage, say. Nothing to preserve, and pushing
    // an unchanged branch would be a wasted round trip.
    if (!commit) return null

    await this.opts.repo.push(this.opts.branch)
    this.opts.bus.emit({ type: 'git.pushed', data: { branch: this.opts.branch, remote: 'origin' } })
    return { sha: commit.sha, branch: this.opts.branch }
  }

  async openPullRequest(
    ctx: StageContext,
  ): Promise<{ number: number; url: string; head: string; base: string }> {
    const { repo, task } = this.opts

    const commit = await this.commit(ctx)

    const diff = await repo.diffStat(this.opts.baseSha)
    this.opts.bus.emit({ type: 'diff.produced', data: diff })

    // A run that changed nothing should open no PR. Finding that out here costs a
    // second; a reviewer finding an empty PR costs their attention.
    if (diff.filesChanged === 0 && !commit) {
      throw new Error('nothing to open a pull request for: no files changed')
    }

    const baseMoved = await repo.baseMoved(this.opts.baseBranch, this.opts.baseSha)

    await repo.push(this.opts.branch)
    this.opts.bus.emit({ type: 'git.pushed', data: { branch: this.opts.branch, remote: 'origin' } })

    const { events, records } = this.opts.snapshot()
    const pr = await this.opts.github.openPullRequest({
      repo: parseRepoRef(this.opts.repoUrl),
      head: this.opts.branch,
      base: this.opts.baseBranch,
      title: buildPullRequestTitle(task),
      body: buildPullRequestBody({
        task,
        events,
        records,
        harness: this.opts.harness,
        diff,
        baseMoved,
        baseBranch: this.opts.baseBranch,
        ...(this.opts.runUrl ? { runUrl: this.opts.runUrl } : {}),
      }),
    })
    // The branches too, so the event can say what actually happened rather than guess.
    return { ...pr, head: this.opts.branch, base: this.opts.baseBranch }
  }

  /**
   * Tidy up after a failed run.
   *
   * Called by the orchestrator rather than a stage, because a failed run does not reach
   * its later stages — which is exactly when the branch needs removing.
   */
  async cleanupAfterFailure(): Promise<void> {
    if (!this.opts.git.deleteBranchOnFailure) return
    await this.opts.repo.deleteRemoteBranch(this.opts.branch)
  }
}
