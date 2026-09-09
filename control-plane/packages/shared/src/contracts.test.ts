import { describe, expect, it } from 'vitest'
import {
  DEFAULT_HARNESS,
  TASK_STATUS_TRANSITIONS,
  canTransitionTask,
  isRunTerminal,
} from './ids.js'
import { ProjectManifest, renderBranchName, slugify } from './manifest.js'
import { DEFAULT_STAGE_TEMPLATE, StageTemplate } from './stages.js'
import { attachmentInStage, blockingAttachments, resolveSkills } from './tools.js'

describe('stage templates', () => {
  it('accepts the default template', () => {
    const parsed = StageTemplate.parse(DEFAULT_STAGE_TEMPLATE)
    expect(parsed.stages.map((s) => s.id)).toEqual([
      'design',
      'branch',
      'code',
      'verify',
      'test',
      'review',
      'commit',
      'pr',
    ])
  })

  it('reviews with a different harness than the default, so review is cross-model', () => {
    const parsed = StageTemplate.parse(DEFAULT_STAGE_TEMPLATE)
    const review = parsed.stages.find((s) => s.id === 'review')
    // The invariant, not the literal: whoever writes the code must not review it.
    expect(review?.harness).toBeDefined()
    expect(review?.harness).not.toBe(DEFAULT_HARNESS)
    expect(review?.tools.mode).toBe('read_only')
  })

  it('leaves every other stage on the project default', () => {
    const parsed = StageTemplate.parse(DEFAULT_STAGE_TEMPLATE)
    const overridden = parsed.stages.filter((s) => s.harness !== undefined).map((s) => s.id)
    expect(overridden).toEqual(['review'])
  })

  it('gives the design stage no write access', () => {
    const parsed = StageTemplate.parse(DEFAULT_STAGE_TEMPLATE)
    expect(parsed.stages.find((s) => s.id === 'design')?.tools.mode).toBe('read_only')
  })

  it('rejects duplicate stage ids', () => {
    expect(() =>
      StageTemplate.parse({
        name: 'dupe',
        stages: [
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
          { id: 'code', kind: 'agent', promptFile: 'p.md' },
        ],
      }),
    ).toThrow(/duplicate stage/)
  })

  it('rejects an onFail target outside the template', () => {
    expect(() =>
      StageTemplate.parse({
        name: 'dangling',
        stages: [
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'true' },
            maxAttempts: 2,
            onFail: 'design',
          },
        ],
      }),
    ).toThrow(/not in this template/)
  })

  it('rejects retries with nowhere to go', () => {
    expect(() =>
      StageTemplate.parse({
        name: 'no-target',
        stages: [
          {
            id: 'test',
            kind: 'agent',
            promptFile: 'p.md',
            gate: { kind: 'command', run: 'true' },
            maxAttempts: 3,
          },
        ],
      }),
    ).toThrow(/no onFail target/)
  })

  it('requires builtin stages to name an action', () => {
    expect(() =>
      StageTemplate.parse({ name: 'b', stages: [{ id: 'pr', kind: 'builtin' }] }),
    ).toThrow(/needs an action/)
  })

  it('requires agent stages to carry instructions, from a file or inline', () => {
    /**
     * Either satisfies it. A stage we ship names a file in the bundle; one somebody adds in the
     * UI carries its text, because the bundle is baked at build time and has nowhere to put it.
     * A stage with neither runs on a generated one-liner — which looks like it works and
     * produces nothing useful.
     */
    expect(() =>
      StageTemplate.parse({ name: 'a', stages: [{ id: 'code', kind: 'agent' }] }),
    ).toThrow(/needs a prompt or a promptFile/)

    for (const stage of [
      { id: 'code', kind: 'agent', promptFile: 'prompts/code.md' },
      { id: 'security-review', kind: 'agent', prompt: 'Look for injection and authz gaps.' },
    ]) {
      expect(() => StageTemplate.parse({ name: 'a', stages: [stage] })).not.toThrow()
    }
  })

  it('accepts a stage name a project invented, and refuses one that is not a slug', () => {
    /**
     * The vocabulary used to be a closed enum of nine, which made the pipeline exactly as
     * configurable as whoever edited that file. It is open now — but still a slug, because an id
     * names a bundle entry and appears in an event stream, and free text there would let a
     * template smuggle a path into a filename.
     */
    const ok = (id: string) =>
      StageTemplate.parse({
        name: 'a',
        stages: [{ id, kind: 'agent', prompt: 'do the thing' }],
      })
    expect(() => ok('security-review')).not.toThrow()
    expect(() => ok('a11y')).not.toThrow()

    for (const bad of ['../escape', 'Design', 'has space', '-leading', '']) {
      expect(() => ok(bad), `"${bad}" should be refused`).toThrow()
    }
  })
})

describe('manifest', () => {
  const minimal = {
    version: 1,
    project: 'acme-web',
    repos: [{ url: 'github.com/acme/web' }],
    harnesses: {
      default: 'claude-code',
      allowed: ['claude-code', 'codex'],
      seatPool: 'claude-max-pool',
    },
    stageTemplate: DEFAULT_STAGE_TEMPLATE,
  }

  it('applies defaults for everything optional', () => {
    const parsed = ProjectManifest.parse(minimal)
    expect(parsed.repos[0]?.defaultBranch).toBe('main')
    expect(parsed.runtime.ephemeralStorageGb).toBe(50)
    expect(parsed.budget.perRun.idleKillSec).toBe(300)
    expect(parsed.skillDirs).toEqual(['./skills'])
  })

  it('deny-lists the irreversible by default', () => {
    const parsed = ProjectManifest.parse(minimal)
    expect(parsed.policy.tools.deny).toContain('Bash(git push --force*)')
  })

  it('sets a wall-clock limit, because hung runs bill for wall clock', () => {
    const parsed = ProjectManifest.parse(minimal)
    expect(parsed.budget.perRun.wallClockSec).toBeGreaterThan(0)
  })

  it('requires at least one repo', () => {
    expect(() => ProjectManifest.parse({ ...minimal, repos: [] })).toThrow()
  })

  it('rejects ephemeral storage below the Fargate floor', () => {
    expect(() =>
      ProjectManifest.parse({ ...minimal, runtime: { ephemeralStorageGb: 10 } }),
    ).toThrow()
  })
})

describe('branch naming', () => {
  it('slugifies a title', () => {
    expect(slugify('Add OAuth  login (v2)!')).toBe('add-oauth-login-v2')
  })

  it('renders the default pattern', () => {
    expect(
      renderBranchName('feat/{{task.slug}}-{{task.id}}', { taskId: '42', slug: 'add-oauth' }),
    ).toBe('feat/add-oauth-42')
  })

  it('strips characters git refs cannot carry', () => {
    expect(renderBranchName('feat/{{task.slug}}', { taskId: '1', slug: 'a b~c^d' })).toBe(
      'feat/a-b-c-d',
    )
  })
})

describe('status transitions', () => {
  it('allows the happy path', () => {
    expect(canTransitionTask('not_started', 'dispatched')).toBe(true)
    expect(canTransitionTask('running', 'in_review')).toBe(true)
    expect(canTransitionTask('in_review', 'done')).toBe(true)
  })

  it('refuses to skip ahead', () => {
    expect(canTransitionTask('not_started', 'done')).toBe(false)
    expect(canTransitionTask('not_started', 'running')).toBe(false)
  })

  it('treats done as terminal', () => {
    expect(canTransitionTask('done', 'running')).toBe(false)
  })

  it('lets a queued task wait for capacity and come back', () => {
    expect(canTransitionTask('dispatched', 'waiting_capacity')).toBe(true)
    expect(canTransitionTask('waiting_capacity', 'running')).toBe(true)
  })

  it('knows which run statuses are terminal', () => {
    expect(isRunTerminal('succeeded')).toBe(true)
    expect(isRunTerminal('parked')).toBe(false)
  })
})

describe('skills and attachments', () => {
  it('lets repo skills shadow project and org ones', () => {
    const resolved = resolveSkills([
      { name: 'migrations', origin: 'org', path: 'org/migrations', stages: [] },
      { name: 'migrations', origin: 'repo', path: '.claude/skills/migrations', stages: [] },
      { name: 'migrations', origin: 'project', path: 'proj/migrations', stages: [] },
      { name: 'release', origin: 'org', path: 'org/release', stages: [] },
    ])
    expect(resolved).toHaveLength(2)
    expect(resolved.find((s) => s.name === 'migrations')?.origin).toBe('repo')
  })

  it('treats an empty stage list as every stage', () => {
    const all = {
      serverId: 's',
      config: {},
      required: false,
      enabledTools: [],
      stages: [],
      health: 'ok' as const,
    }
    expect(attachmentInStage(all, 'design')).toBe(true)
    expect(attachmentInStage({ ...all, stages: ['code'] }, 'design')).toBe(false)
  })

  it('blocks dispatch only on unhealthy required attachments', () => {
    const base = { serverId: 's', config: {}, enabledTools: [], stages: [] }
    const blocking = blockingAttachments([
      { ...base, required: true, health: 'needs_reauth' },
      { ...base, required: false, health: 'unreachable' },
      { ...base, required: true, health: 'ok' },
    ])
    expect(blocking).toHaveLength(1)
    expect(blocking[0]?.health).toBe('needs_reauth')
  })
})

describe('a dispatched task can reach a terminal state', () => {
  it('allows dispatched → in_review without passing through running', () => {
    // A run's outcome is authoritative, and it can finish without a `run.started` event
    // ever being recorded. A database blip losing that one write left a task stuck on
    // `dispatched` for ever while its run said `succeeded` — the board lying.
    expect(canTransitionTask('dispatched', 'in_review')).toBe(true)
  })

  it('still refuses the transitions that would let a client invent progress', () => {
    expect(canTransitionTask('not_started', 'in_review')).toBe(false)
    expect(canTransitionTask('not_started', 'running')).toBe(false)
    expect(canTransitionTask('done', 'running')).toBe(false)
  })

  it('leaves every non-terminal task status a route to a terminal one', () => {
    // The invariant behind the bug: if any non-terminal status has no path to a terminal
    // one, a run finishing there strands its task permanently.
    for (const from of [
      'not_started',
      'dispatched',
      'waiting_capacity',
      'running',
      'blocked',
    ] as const) {
      const reachable = TASK_STATUS_TRANSITIONS[from]
      const canFinish =
        reachable.includes('failed') ||
        reachable.includes('in_review') ||
        reachable.some((next) => TASK_STATUS_TRANSITIONS[next].includes('failed'))
      expect(canFinish, `${from} cannot reach a terminal status`).toBe(true)
    }
  })
})
