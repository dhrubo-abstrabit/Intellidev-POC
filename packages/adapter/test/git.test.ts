import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentEvent, StageRecord, TaskBrief } from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GitRunner } from '../src/git/exec.js'
import { GitHubClient, parseRepoRef } from '../src/git/github.js'
import {
  buildCommitMessage,
  buildPullRequestBody,
  buildPullRequestTitle,
  stagePath,
} from '../src/git/pr-body.js'
import { RunRepo, parseShortstat } from '../src/git/repo.js'

const identity = { name: 'intellidev[bot]', email: 'intellidev[bot]@users.noreply.github.com' }

const task: TaskBrief = {
  id: 'task_42',
  title: 'Add OAuth login',
  description: 'Users should be able to sign in with OAuth.\n\nUse the existing session store.',
  details: 'See the spike in #118.',
  acceptanceCriteria: ['Login works end to end', 'Session survives a refresh'],
}

function event(partial: Partial<AgentEvent> & Pick<AgentEvent, 'type' | 'data'>): AgentEvent {
  return {
    seq: 0,
    runId: 'run_1',
    ts: '2026-08-13T09:00:00.000Z',
    stage: 'code',
    ...partial,
  } as AgentEvent
}

// --- real git against temp repos -------------------------------------------

describe('RunRepo against real git', () => {
  let root: string
  let origin: string
  let mirror: string
  let worktree: string
  let git: GitRunner
  let repo: RunRepo
  const commands: string[] = []

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-git-'))
    origin = join(root, 'origin.git')
    mirror = join(root, 'mirror.git')
    worktree = join(root, 'work')
    commands.length = 0

    git = new GitRunner({
      home: root,
      identity,
      timeoutSec: 60,
      onCommand: (c) => commands.push(c),
    })

    // A bare origin with one commit, built through a scratch clone.
    await git.run(['init', '--bare', '--initial-branch=main', origin], root)
    const seed = join(root, 'seed')
    await git.run(['clone', origin, seed], root)
    await writeFile(join(seed, 'README.md'), '# seed\n')
    await git.run(['add', '.'], seed)
    await git.run(['commit', '-m', 'seed'], seed)
    await git.run(['push', 'origin', 'main'], seed)

    repo = new RunRepo(git, { mirror, worktree })
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('clones a mirror, then fetches on the next run', async () => {
    expect(await repo.ensureMirror(origin, { partial: false })).toBe('cloned')
    expect(await repo.ensureMirror(origin, { partial: false })).toBe('fetched')
    // Fetching a cached mirror is the whole point of caching it.
    expect(commands.filter((c) => c.startsWith('git clone'))).toHaveLength(2) // seed + mirror
  })

  it('creates a worktree on a new branch from an explicit sha', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    const created = await repo.createWorktree('feat/add-oauth-42', baseSha)
    expect(created.branch).toBe('feat/add-oauth-42')
    // Pinned to a sha, not a branch name, so a moving base cannot change what we built on.
    expect(created.baseSha).toBe(baseSha)
    expect(await readFile(join(worktree, 'README.md'), 'utf8')).toContain('# seed')
  })

  it('reports no changes on a fresh worktree', async () => {
    await repo.ensureMirror(origin, { partial: false })
    await repo.createWorktree('feat/x', await repo.resolve('main'))
    expect(await repo.hasChanges()).toBe(false)
    expect(await repo.commitAll('nothing')).toBeNull()
  })

  it('commits with the bot identity, never an inherited one', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/x', baseSha)
    await writeFile(join(worktree, 'auth.ts'), 'export const login = () => {}\n')

    const commit = await repo.commitAll('feat: add login')
    expect(commit?.sha).toMatch(/^[0-9a-f]{40}$/)
    expect(commit?.filesChanged).toBe(1)

    const author = await git.run(['log', '-1', '--format=%an <%ae>'], worktree)
    // A run is not a human; attributing its commits to one makes blame lie.
    expect(author.stdout.trim()).toBe(`${identity.name} <${identity.email}>`)
  })

  it('produces a diffstat against the base', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/x', baseSha)
    await writeFile(join(worktree, 'a.ts'), 'a\nb\nc\n')
    await repo.commitAll('add a')

    const diff = await repo.diffStat(baseSha)
    expect(diff.filesChanged).toBe(1)
    expect(diff.insertions).toBe(3)
    expect(diff.deletions).toBe(0)
  })

  it('lists commit subjects since the base, oldest first', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/x', baseSha)
    await writeFile(join(worktree, 'a.ts'), 'a\n')
    await repo.commitAll('first')
    await writeFile(join(worktree, 'b.ts'), 'b\n')
    await repo.commitAll('second')
    expect(await repo.commitSubjects(baseSha)).toEqual(['first', 'second'])
  })

  it('pushes the branch to origin', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/pushed', baseSha)
    await writeFile(join(worktree, 'a.ts'), 'a\n')
    await repo.commitAll('add a')
    await repo.push('feat/pushed')

    const remote = await git.run(['branch', '--list', 'feat/pushed'], origin)
    expect(remote.stdout).toContain('feat/pushed')
  })

  it('detects that the base moved, and does not rebase', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/x', baseSha)
    await writeFile(join(worktree, 'mine.ts'), 'mine\n')
    await repo.commitAll('mine')

    // Someone else lands on main while we work.
    const other = join(root, 'other')
    await git.run(['clone', origin, other], root)
    await writeFile(join(other, 'theirs.ts'), 'theirs\n')
    await git.run(['add', '.'], other)
    await git.run(['commit', '-m', 'theirs'], other)
    await git.run(['push', 'origin', 'main'], other)

    const moved = await repo.baseMoved('main', baseSha)
    expect(moved.moved).toBe(true)
    expect(moved.nowSha).not.toBe(baseSha)
    // Our branch is untouched: reporting beats a silent rebase.
    expect(await repo.commitSubjects(baseSha)).toEqual(['mine'])
  })

  it('reports the base as unmoved when nothing landed', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/x', baseSha)
    expect((await repo.baseMoved('main', baseSha)).moved).toBe(false)
  })

  it('deletes the remote branch after a failure', async () => {
    await repo.ensureMirror(origin, { partial: false })
    const baseSha = await repo.resolve('main')
    await repo.createWorktree('feat/doomed', baseSha)
    await writeFile(join(worktree, 'a.ts'), 'a\n')
    await repo.commitAll('a')
    await repo.push('feat/doomed')

    expect(await repo.deleteRemoteBranch('feat/doomed')).toBe(true)
    const remote = await git.run(['branch', '--list', 'feat/doomed'], origin)
    expect(remote.stdout.trim()).toBe('')
  })

  it('supports a blobless clone', async () => {
    // The default for real projects: full history, blobs on demand.
    expect(await repo.ensureMirror(origin, { partial: true })).toBe('cloned')
    expect(await repo.resolve('main')).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('GitRunner environment', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-gitenv-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('never hangs on an auth prompt', async () => {
    const git = new GitRunner({ home: root, identity, timeoutSec: 30 })
    // No credential helper and an unreachable private repo: without
    // GIT_TERMINAL_PROMPT=0 this would block forever waiting for a password.
    const result = await git.tryRun(
      ['ls-remote', 'https://github.com/intellidev-nonexistent/private-nope.git'],
      root,
    )
    expect(result.exitCode).not.toBe(0)
    expect(result.stderr.length).toBeGreaterThan(0)
  }, 30_000)

  it('ignores a host gitconfig, so runs are reproducible', async () => {
    const git = new GitRunner({ home: root, identity })
    const result = await git.tryRun(['config', '--get', 'user.name'], root)
    // HOME is pinned to a temp dir and GIT_CONFIG_NOSYSTEM is set, so `user.name` is
    // genuinely unset — git exits 1 for a missing key, and that exit *is* the proof
    // that the developer's global config did not leak in.
    expect(result.exitCode).toBe(1)
    expect(result.stdout.trim()).toBe('')
  })

  it('still commits, because identity comes from env not config', async () => {
    // The corollary: with no gitconfig at all, commits only work because the runner
    // passes GIT_AUTHOR_* and GIT_COMMITTER_* explicitly.
    const git = new GitRunner({ home: root, identity })
    await git.run(['init', '--initial-branch=main', '.'], root)
    await writeFile(join(root, 'f.txt'), 'x\n')
    await git.run(['add', '.'], root)
    await git.run(['commit', '-m', 'works without gitconfig'], root)
    const author = await git.run(['log', '-1', '--format=%an'], root)
    expect(author.stdout.trim()).toBe(identity.name)
  })

  it('resets inherited credential helpers before adding ours', async () => {
    const commands: string[] = []
    const git = new GitRunner({
      home: root,
      identity,
      credentialHelper: '!intellidev-cred git',
      onCommand: (c) => commands.push(c),
    })
    await git.tryRun(['--version'], root)
    expect(commands[0]).toContain('--version')
  })
})

// --- pure builders ---------------------------------------------------------

describe('parseShortstat', () => {
  it('parses a full shortstat', () => {
    expect(parseShortstat(' 3 files changed, 42 insertions(+), 8 deletions(-)')).toEqual({
      filesChanged: 3,
      insertions: 42,
      deletions: 8,
    })
  })

  it('handles the sections git omits when they are zero', () => {
    expect(parseShortstat(' 1 file changed, 2 insertions(+)')).toEqual({
      filesChanged: 1,
      insertions: 2,
      deletions: 0,
    })
    expect(parseShortstat('')).toEqual({ filesChanged: 0, insertions: 0, deletions: 0 })
  })
})

describe('parseRepoRef', () => {
  it('accepts every form a manifest might carry', () => {
    // Failing on one of these at PR time would waste the whole run.
    for (const url of [
      'github.com/acme/web',
      'https://github.com/acme/web',
      'https://github.com/acme/web.git',
      'git@github.com:acme/web.git',
      'acme/web',
    ]) {
      expect(parseRepoRef(url), url).toEqual({ owner: 'acme', repo: 'web' })
    }
  })

  it('throws on something that is not a repo reference', () => {
    expect(() => parseRepoRef('nope')).toThrow(/cannot parse/)
  })
})

describe('buildCommitMessage', () => {
  it('is deterministic and derived from the task', () => {
    const message = buildCommitMessage(task)
    expect(message.split('\n')[0]).toBe('Add OAuth login')
    expect(message).toContain('Task: task_42')
    // Two runs of the same task must produce the same message.
    expect(buildCommitMessage(task)).toBe(message)
  })

  it('uses only the first paragraph of the description', () => {
    const message = buildCommitMessage(task)
    expect(message).toContain('Users should be able to sign in with OAuth.')
    expect(message).not.toContain('Use the existing session store.')
  })

  it('truncates an overlong subject', () => {
    const long = { ...task, title: 'x'.repeat(200) }
    expect(buildPullRequestTitle(long).length).toBeLessThanOrEqual(72)
    expect(buildPullRequestTitle(long).endsWith('…')).toBe(true)
  })
})

describe('stagePath', () => {
  const record = (stage: StageRecord['stage'], attempt = 1): StageRecord => ({
    stage,
    attempt,
    status: 'passed',
    resumeToken: null,
    gatePassed: true,
  })

  it('marks retried stages with a count', () => {
    expect(
      stagePath([
        record('design'),
        record('code'),
        record('test'),
        record('code', 2),
        record('test', 2),
      ]),
    ).toBe('design → code(2) → test(2)')
  })

  it('returns null with no records', () => {
    expect(stagePath([])).toBeNull()
  })
})

describe('buildPullRequestBody', () => {
  const records: StageRecord[] = [
    { stage: 'code', attempt: 1, status: 'passed', resumeToken: null, gatePassed: null },
    { stage: 'test', attempt: 1, status: 'failed', resumeToken: null, gatePassed: false },
    { stage: 'code', attempt: 2, status: 'passed', resumeToken: null, gatePassed: null },
    { stage: 'test', attempt: 2, status: 'passed', resumeToken: null, gatePassed: true },
    {
      stage: 'review',
      attempt: 1,
      status: 'passed',
      harness: 'claude-code',
      resumeToken: null,
      gatePassed: true,
      output: {
        blocking: 0,
        findings: [
          { severity: 'suggestion', file: 'src/auth.ts', line: 12, summary: 'Extract a helper' },
        ],
      },
    },
  ]

  const events: AgentEvent[] = [
    event({ type: 'file.changed', data: { path: 'src/auth.ts', change: 'modified' } }),
    event({ type: 'file.changed', data: { path: 'src/auth.test.ts', change: 'added' } }),
    event({ type: 'file.changed', data: { path: 'src/auth.ts', change: 'modified' } }),
    event({
      type: 'gate.evaluated',
      data: { kind: 'command', passed: false, label: 'pnpm test', detail: 'boom', exitCode: 1 },
    }),
    event({
      type: 'gate.evaluated',
      data: { kind: 'command', passed: true, label: 'pnpm test', detail: 'ok', exitCode: 0 },
    }),
    event({
      type: 'gate.evaluated',
      data: { kind: 'command', passed: true, label: 'pnpm lint', detail: 'ok', exitCode: 0 },
    }),
    event({
      type: 'usage.updated',
      data: {
        tokensIn: 1_240_000,
        tokensOut: 43_000,
        tokensCacheRead: 900_000,
        tokensCacheWrite: 0,
        usdEst: 0.84,
        estimate: false,
      },
    }),
  ]

  const body = buildPullRequestBody({
    task,
    events,
    records,
    harness: 'opencode',
    diff: { filesChanged: 2, insertions: 42, deletions: 8 },
    baseBranch: 'main',
    runUrl: 'https://intellidev.test/runs/4821',
  })

  it('states what was asked, including acceptance criteria', () => {
    expect(body).toContain('## What was asked')
    expect(body).toContain('Users should be able to sign in with OAuth.')
    expect(body).toContain('- Login works end to end')
    expect(body).toContain('See the spike in #118.')
  })

  it('lists changed files once each, sorted', () => {
    const section = body.split('## Checks')[0] ?? ''
    expect(section).toContain('`src/auth.test.ts`')
    expect(section).toContain('`src/auth.ts`')
    // The same file changed twice must not appear twice.
    expect(section.match(/`src\/auth\.ts`/g)).toHaveLength(1)
  })

  it('names each check and how many attempts it took', () => {
    // A suite that passed on the second try is a different signal from first time.
    expect(body).toContain('`pnpm test`')
    expect(body).toContain('passed after 2 attempts')
    expect(body).toContain('`pnpm lint`')
  })

  it('reports who reviewed and what they found', () => {
    expect(body).toContain('Reviewed by **claude-code**')
    expect(body).toContain('0 blocking')
    expect(body).toContain('Extract a helper')
    expect(body).toContain('`src/auth.ts:12`')
  })

  it('records the harness, stage path, tokens and cost', () => {
    expect(body).toContain('`opencode`')
    expect(body).toContain('code(2) → test(2) → review')
    expect(body).toContain('1.2M in / 43k out')
    expect(body).toContain('~$0.84')
    expect(body).toContain('https://intellidev.test/runs/4821')
  })

  it('says it was assembled from the log, not written by the model', () => {
    expect(body).toContain("Assembled from this run's event log")
  })

  it('warns when the base moved, and says it did not rebase', () => {
    const moved = buildPullRequestBody({
      task,
      events,
      records,
      harness: 'opencode',
      baseBranch: 'main',
      baseMoved: { moved: true, nowSha: 'abcdef1234567890' },
    })
    expect(moved).toContain('Base moved during this run')
    expect(moved).toContain('was **not** rebased')
    expect(moved).toContain('abcdef123456')
  })

  it('omits the base-moved warning when nothing landed', () => {
    expect(body).not.toContain('Base moved')
  })

  it('handles a run with no findings and no diff', () => {
    const minimal = buildPullRequestBody({
      task,
      events: [],
      records: [
        { stage: 'code', attempt: 1, status: 'passed', resumeToken: null, gatePassed: null },
      ],
      harness: 'codex',
    })
    expect(minimal).toContain('_No file changes recorded._')
    expect(minimal).not.toContain('## Checks')
    expect(minimal).not.toContain('## Review')
  })
})

// --- GitHub client ---------------------------------------------------------

describe('GitHubClient', () => {
  it('opens a pull request with a fresh token', async () => {
    const calls: Array<{ url: string; auth: string | null; body: unknown }> = []
    let tokenReads = 0
    const client = new GitHubClient({
      token: async () => {
        tokenReads++
        return `ghs_${tokenReads}`
      },
      fetchImpl: (async (url: URL, init: RequestInit) => {
        calls.push({
          url: String(url),
          auth: (init.headers as Record<string, string>)['authorization'] ?? null,
          body: init.body ? JSON.parse(String(init.body)) : null,
        })
        return new Response(JSON.stringify({ number: 7, html_url: 'https://gh.test/pr/7' }), {
          status: 201,
        })
      }) as unknown as typeof fetch,
    })

    const pr = await client.openPullRequest({
      repo: { owner: 'acme', repo: 'web' },
      head: 'feat/x',
      base: 'main',
      title: 't',
      body: 'b',
    })
    expect(pr).toEqual({ number: 7, url: 'https://gh.test/pr/7' })
    expect(calls[0]?.url).toBe('https://api.github.com/repos/acme/web/pulls')
    // Fetched per call, so a run longer than an hour still opens its PR.
    expect(calls[0]?.auth).toBe('Bearer ghs_1')
  })

  it('adopts an existing PR when GitHub says one is already open', async () => {
    // A retried or resumed run must not fail because its own earlier attempt succeeded.
    let call = 0
    const client = new GitHubClient({
      token: async () => 't',
      fetchImpl: (async () => {
        call++
        if (call === 1) return new Response('already exists', { status: 422 })
        return new Response(JSON.stringify([{ number: 3, html_url: 'https://gh.test/pr/3' }]), {
          status: 200,
        })
      }) as unknown as typeof fetch,
    })
    const pr = await client.openPullRequest({
      repo: { owner: 'acme', repo: 'web' },
      head: 'feat/x',
      base: 'main',
      title: 't',
      body: 'b',
    })
    expect(pr.number).toBe(3)
  })

  it('throws when the 422 has no adoptable PR behind it', async () => {
    const client = new GitHubClient({
      token: async () => 't',
      fetchImpl: (async (url: URL) =>
        String(url).includes('state=open')
          ? new Response('[]', { status: 200 })
          : new Response('bad base', { status: 422 })) as unknown as typeof fetch,
    })
    await expect(
      client.openPullRequest({
        repo: { owner: 'acme', repo: 'web' },
        head: 'feat/x',
        base: 'nope',
        title: 't',
        body: 'b',
      }),
    ).rejects.toThrow(/422/)
  })
})

describe('resolving a base branch that is not there', () => {
  it('says the repository is empty rather than "ambiguous argument"', async () => {
    // The first thing a new project hits: a repository created in the UI and never pushed
    // to. Git's own message reads like a syntax error.
    const root = await mkdtemp(join(tmpdir(), 'empty-mirror-'))
    const mirror = join(root, 'repo.git')
    await mkdir(mirror, { recursive: true })
    execFileSync('git', ['init', '--bare', '-q', mirror])

    const repo = new RunRepo(
      new GitRunner({ home: root, identity: { name: 'i', email: 'i@e' }, timeoutSec: 30 }),
      { mirror, worktree: join(root, 'work') },
    )
    await expect(repo.resolve('main')).rejects.toThrow(/no branches at all/)
    await expect(repo.resolve('main')).rejects.toThrow(/empty repository/)
  })

  it('lists the branches that do exist when the name is simply wrong', async () => {
    const root = await mkdtemp(join(tmpdir(), 'mirror-'))
    const source = join(root, 'src')
    await mkdir(source, { recursive: true })
    execFileSync('git', ['init', '-q', '-b', 'master', source])
    await writeFile(join(source, 'README.md'), '# x\n')
    execFileSync('git', ['add', '.'], { cwd: source })
    execFileSync('git', ['-c', 'user.email=i@e', '-c', 'user.name=i', 'commit', '-qm', 'init'], {
      cwd: source,
    })

    const mirror = join(root, 'repo.git')
    execFileSync('git', ['clone', '--bare', '-q', source, mirror])

    const repo = new RunRepo(
      new GitRunner({ home: root, identity: { name: 'i', email: 'i@e' }, timeoutSec: 30 }),
      { mirror, worktree: join(root, 'work') },
    )
    // The common real case: the field defaults to `main` and the repo uses `master`.
    await expect(repo.resolve('main')).rejects.toThrow(/does not exist.*master/s)
    await expect(repo.resolve('master')).resolves.toMatch(/^[0-9a-f]{40}$/)
  })
})
