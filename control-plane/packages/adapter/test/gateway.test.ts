import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DEFAULT_STAGE_TEMPLATE,
  StageTemplate,
  ToolPolicy,
  type EventBodyInput,
  type SkillRef,
  type StageId,
  type TaskBrief,
  type ToolsetSpec,
} from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { availableChecks, buildBuiltinTools, type BuiltinContext } from '../src/gateway/builtins.js'
import { Gateway } from '../src/gateway/gateway.js'
import {
  MAX_TOOL_NAME,
  ToolRegistry,
  matchesPattern,
  namespacedToolName,
  registerToolset,
} from '../src/gateway/registry.js'
import { isGatewayToolName } from '../src/gateway/naming.js'
import { flattenContent } from '../src/gateway/upstream.js'
import type { CommandRunner } from '../src/stages/types.js'

const policy = (over: Partial<ReturnType<typeof ToolPolicy.parse>> = {}) =>
  ToolPolicy.parse({ mode: 'full', allow: [], deny: [], ...over })

const task: TaskBrief = {
  id: 'task_1',
  title: 'Add login',
  description: 'Add OAuth login.',
  acceptanceCriteria: ['works'],
}

// --- naming and matching ---------------------------------------------------

describe('namespacedToolName', () => {
  it('namespaces by server so two servers cannot collide', () => {
    expect(namespacedToolName('sentry', 'search')).toBe('sentry__search')
    expect(namespacedToolName('linear', 'search')).toBe('linear__search')
  })

  it('sanitises characters MCP names cannot carry', () => {
    expect(namespacedToolName('claude.ai Sentry', 'list/issues')).toBe(
      'claude_ai_Sentry__list_issues',
    )
  })

  it('keeps names within the protocol limit', () => {
    const name = namespacedToolName('s'.repeat(50), 't'.repeat(50))
    expect(name.length).toBeLessThanOrEqual(MAX_TOOL_NAME)
  })

  it('distinguishes over-long names that share a prefix', () => {
    // Truncating alone would route one of these to the wrong server.
    const a = namespacedToolName('server', `${'x'.repeat(60)}_alpha`)
    const b = namespacedToolName('server', `${'x'.repeat(60)}_beta`)
    expect(a).not.toBe(b)
  })
})

describe('matchesPattern', () => {
  it('matches plain names and globs', () => {
    expect(matchesPattern('sentry__search', 'sentry__search')).toBe(true)
    expect(matchesPattern('sentry__*', 'sentry__search')).toBe(true)
    expect(matchesPattern('sentry__*', 'linear__search')).toBe(false)
  })

  it('matches the tool name out of a Bash(...) style pattern', () => {
    expect(matchesPattern('Bash(git push --force*)', 'Bash')).toBe(true)
  })
})

// --- registry filtering ----------------------------------------------------

describe('ToolRegistry', () => {
  function registry() {
    const r = new ToolRegistry()
    r.registerBuiltin({
      name: 'task_context',
      description: 'ctx',
      inputSchema: {},
      stages: [],
    })
    r.registerUpstream('sentry', [{ name: 'list_issues' }, { name: 'resolve_issue' }], {
      enabledTools: [],
      stages: ['code', 'test'],
    })
    r.registerUpstream('linear', [{ name: 'search' }], { enabledTools: [], stages: [] })
    return r
  }

  it('shows a stage only the tools scoped to it', () => {
    const r = registry()
    const design = r.visibleTo('design', policy()).map((t) => t.name)
    // T7 acceptance: a tool excluded from design is genuinely absent there.
    expect(design).not.toContain('sentry__list_issues')
    expect(design).toContain('linear__search')
    expect(design).toContain('task_context')

    expect(r.visibleTo('code', policy()).map((t) => t.name)).toContain('sentry__list_issues')
  })

  it('refuses a call to a tool the stage cannot see, not just hides it', () => {
    // A harness may hold a stale list; hiding without refusing makes the filter
    // decoration rather than a control.
    const decision = registry().resolve('sentry__list_issues', 'design', policy())
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('stage_scope')
  })

  it('honours enabledTools, exposing only the chosen subset', () => {
    const r = new ToolRegistry()
    r.registerUpstream('sentry', [{ name: 'list_issues' }, { name: 'delete_project' }], {
      enabledTools: ['list_issues'],
      stages: [],
    })
    expect(r.all().map((t) => t.name)).toEqual(['sentry__list_issues'])
  })

  it('applies deny patterns', () => {
    const decision = registry().resolve(
      'sentry__resolve_issue',
      'code',
      policy({ deny: ['sentry__resolve*'] }),
    )
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('policy_deny')
  })

  it('treats a non-empty allow-list as exhaustive', () => {
    const r = registry()
    const allowed = policy({ allow: ['task_context'] })
    expect(r.visibleTo('code', allowed).map((t) => t.name)).toEqual(['task_context'])
  })

  it('hides upstream tools when the stage tool mode is none, but keeps built-ins', () => {
    // A stage still has to be able to report, even with no tools.
    const visible = registry()
      .visibleTo('code', policy({ mode: 'none' }))
      .map((t) => t.name)
    expect(visible).toEqual(['task_context'])
  })

  it('reports an unknown tool as not attached', () => {
    const decision = registry().resolve('nope', 'code', policy())
    expect(decision.allowed).toBe(false)
    if (!decision.allowed) expect(decision.reason).toBe('not_attached')
  })

  it('does not let an upstream server shadow a built-in', () => {
    const r = new ToolRegistry()
    r.registerBuiltin({ name: 'run_check', description: '', inputSchema: {}, stages: [] })
    const added = r.registerUpstream('x', [{ name: 'check' }], { enabledTools: [], stages: [] })
    // Suffixed rather than dropped: silently losing an upstream tool is worse.
    expect(added[0]?.name).not.toBe('run_check')
    expect(r.all()).toHaveLength(2)
  })
})

describe('registerToolset', () => {
  it('skips a server with no cached tool list, and says which', () => {
    const toolset: ToolsetSpec = {
      servers: [
        {
          server: {
            id: 'sentry',
            name: 'Sentry',
            kind: 'remote_http',
            auth: 'oauth2',
            url: 'https://x',
            args: [],
          },
          attachment: {
            serverId: 'sentry',
            config: {},
            required: true,
            enabledTools: [],
            stages: [],
            health: 'ok',
          },
        },
      ],
      skills: [],
    }
    const result = registerToolset(new ToolRegistry(), toolset)
    // Recorded rather than ignored: a required server with no snapshot should block.
    expect(result.skipped).toEqual(['sentry'])
    expect(result.registered).toBe(0)
  })
})

// --- built-in tools --------------------------------------------------------

describe('builtin tools', () => {
  let dir: string
  let outputs: Array<{ stage: StageId; output: unknown }>
  let questions: string[]
  let commands: string[]

  const template = StageTemplate.parse(DEFAULT_STAGE_TEMPLATE)

  const skills: SkillRef[] = [
    { name: 'migrations', origin: 'project', path: 'skills/migrations/SKILL.md', stages: [] },
  ]

  const runner: CommandRunner = {
    run: async (command) => {
      commands.push(command)
      return { exitCode: command.includes('test') ? 1 : 0, stdout: 'out', stderr: 'err' }
    },
  }

  function ctx(stage: StageId = 'code'): BuiltinContext {
    return {
      task,
      template,
      stage: () => stage,
      attempt: () => 2,
      commands: runner,
      cwd: dir,
      skills,
      bundleRoot: dir,
      onStageOutput: (s, output) => outputs.push({ stage: s, output }),
      onQuestion: (q) => questions.push(q),
    }
  }

  const tool = (name: string, stage: StageId = 'code') =>
    buildBuiltinTools(ctx(stage)).find((t) => t.name === name)!

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'intellidev-gw-'))
    await mkdir(join(dir, 'skills', 'migrations'), { recursive: true })
    await writeFile(join(dir, 'skills', 'migrations', 'SKILL.md'), '# Migrations\nAlways review.\n')
    outputs = []
    questions = []
    commands = []
  })
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('derives checks from the template gates, so the agent runs what the gate runs', () => {
    // A separate list would drift, and passing your own check but failing the gate is
    // the most confusing possible outcome.
    const checks = availableChecks(template)
    expect(checks.map((c) => c.name)).toEqual(['verify', 'test'])
    expect(checks.find((c) => c.name === 'test')?.command).toBe('pnpm test')
  })

  it('task_context returns the brief', async () => {
    const json = JSON.parse(await tool('task_context').handler({}))
    expect(json.title).toBe('Add login')
    expect(json.acceptanceCriteria).toEqual(['works'])
  })

  it('stage_state names the gate the stage must satisfy', async () => {
    const json = JSON.parse(await tool('stage_state', 'test').handler({}))
    expect(json.stage).toBe('test')
    expect(json.attempt).toBe(2)
    expect(json.gate).toEqual({ kind: 'command', command: 'pnpm test' })
    expect(json.maxAttempts).toBe(3)
  })

  it('stage_state exposes the predicate schema so the agent can satisfy it', async () => {
    const json = JSON.parse(await tool('stage_state', 'review').handler({}))
    expect(json.gate.kind).toBe('predicate')
    expect(json.gate.expression).toBe('blocking == 0')
    expect(json.gate.schema.required).toContain('blocking')
  })

  it('stage_advance records output and does not claim the gate passed', async () => {
    const reply = await tool('stage_advance', 'review').handler({ output: { blocking: 0 } })
    expect(outputs).toEqual([{ stage: 'review', output: { blocking: 0 } }])
    // Saying "recorded" rather than "passed" stops the agent assuming success.
    expect(reply).toContain('will validate')
    expect(reply).not.toMatch(/passed/i)
  })

  it('stage_advance rejects a missing output', async () => {
    expect(await tool('stage_advance').handler({})).toContain('error:')
    expect(outputs).toEqual([])
  })

  it('run_check runs the gate command and reports the exit code', async () => {
    const reply = await tool('run_check').handler({ name: 'test' })
    expect(commands).toEqual(['pnpm test'])
    expect(reply).toContain('exit 1')
    expect(reply).toContain('$ pnpm test')
  })

  it('run_check refuses an unknown check rather than inventing one', async () => {
    const reply = await tool('run_check').handler({ name: 'deploy' })
    expect(reply).toContain('no such check')
    expect(commands).toEqual([])
  })

  it('skill_list summarises without loading bodies', async () => {
    const json = JSON.parse(await tool('skill_list').handler({}))
    expect(json).toEqual([{ name: 'migrations', description: null, origin: 'project' }])
  })

  it('skill_load reads the resolved path', async () => {
    expect(await tool('skill_load').handler({ name: 'migrations' })).toContain('Always review.')
  })

  it('skill_load cannot be used to read arbitrary files', async () => {
    // The path comes from the resolved skill set, never from the caller.
    const reply = await tool('skill_load').handler({ name: '../../../etc/passwd' })
    expect(reply).toContain('no skill named')
  })

  it('ask_user records the question and tells the agent to proceed', async () => {
    const reply = await tool('ask_user').handler({ question: 'Which auth provider?' })
    expect(questions).toEqual(['Which auth provider?'])
    // Pretending an answer is coming would make the agent wait and burn the budget.
    expect(reply).toContain('No human is attached')
    expect(reply).toContain('state the assumption')
  })
})

// --- dispatch --------------------------------------------------------------

describe('Gateway dispatch', () => {
  function build(opts: { stage?: StageId; policy?: ReturnType<typeof ToolPolicy.parse> } = {}) {
    const events: EventBodyInput[] = []
    const registry = new ToolRegistry()
    registry.registerUpstream('sentry', [{ name: 'list_issues' }], {
      enabledTools: [],
      stages: ['code'],
    })
    const upstreamCalls: string[] = []
    const gateway = new Gateway({
      registry,
      builtins: [
        {
          name: 'echo',
          description: 'echo',
          inputSchema: {},
          stages: [],
          handler: async (input) => `echoed ${JSON.stringify(input)}`,
        },
        {
          name: 'boom',
          description: 'always fails',
          inputSchema: {},
          stages: [],
          handler: async () => {
            throw new Error('kaboom')
          },
        },
      ],
      upstream: {
        call: async (serverId, remoteName) => {
          upstreamCalls.push(`${serverId}/${remoteName}`)
          return 'upstream result'
        },
      },
      stage: () => opts.stage ?? 'code',
      policy: () => opts.policy ?? policy(),
      emit: (event) => events.push(event),
    })
    return { gateway, events, upstreamCalls }
  }

  it('emits a call and a result for a built-in', async () => {
    const { gateway, events } = build()
    const outcome = await gateway.callTool('echo', { a: 1 })
    expect(outcome).toEqual({ ok: true, content: 'echoed {"a":1}' })
    expect(events.map((e) => e.type)).toEqual(['tool.call', 'tool.result'])
  })

  it('routes an upstream call and tags the event with its server', async () => {
    const { gateway, events, upstreamCalls } = build()
    const outcome = await gateway.callTool('sentry__list_issues', {})
    expect(outcome.content).toBe('upstream result')
    expect(upstreamCalls).toEqual(['sentry/list_issues'])
    const call = events.find((e) => e.type === 'tool.call')
    if (call?.type === 'tool.call') expect(call.data.server).toBe('sentry')
  })

  it('emits tool.denied for a call the stage may not make', async () => {
    const { gateway, events } = build({ stage: 'design' })
    const outcome = await gateway.callTool('sentry__list_issues', {})
    expect(outcome.ok).toBe(false)
    const denied = events.find((e) => e.type === 'tool.denied')
    // A silently-missing tool is one of the hardest things to debug from a transcript.
    expect(denied?.type).toBe('tool.denied')
    if (denied?.type === 'tool.denied') expect(denied.data.reason).toBe('stage_scope')
    expect(events.some((e) => e.type === 'tool.call')).toBe(false)
  })

  it('returns a failure as content rather than throwing', async () => {
    // An MCP error aborts the turn; a message lets the agent read it and try again.
    const { gateway, events } = build()
    const outcome = await gateway.callTool('boom', {})
    expect(outcome.ok).toBe(false)
    expect(outcome.content).toContain('kaboom')
    const result = events.find((e) => e.type === 'tool.result')
    if (result?.type === 'tool.result') expect(result.data.ok).toBe(false)
  })

  it('pairs every result with its call id', async () => {
    const { gateway, events } = build()
    await gateway.callTool('echo', {})
    const call = events.find((e) => e.type === 'tool.call')
    const result = events.find((e) => e.type === 'tool.result')
    if (call?.type === 'tool.call' && result?.type === 'tool.result') {
      expect(result.data.id).toBe(call.data.id)
    }
  })

  it('lists only what the current stage may see', async () => {
    expect(
      build({ stage: 'design' })
        .gateway.listTools()
        .map((t) => t.name),
    ).toEqual(['echo', 'boom'])
    expect(
      build({ stage: 'code' })
        .gateway.listTools()
        .map((t) => t.name),
    ).toContain('sentry__list_issues')
  })
})

// --- upstream content flattening -------------------------------------------

describe('flattenContent', () => {
  it('joins text blocks', () => {
    expect(
      flattenContent([
        { type: 'text', text: 'a' },
        { type: 'text', text: 'b' },
      ]),
    ).toBe('a\nb')
  })

  it('describes non-text blocks rather than dropping them', () => {
    // An image that silently vanishes is worse than one the agent knows it received.
    expect(flattenContent([{ type: 'image', data: 'x' }])).toBe('[image content]')
    expect(flattenContent([{ type: 'resource', resource: { uri: 'file:///a' } }])).toBe(
      '[resource file:///a]',
    )
  })

  it('handles a non-array payload', () => {
    expect(flattenContent('plain')).toBe('plain')
  })
})

describe('gateway tool de-duplication', () => {
  it('recognises how each harness namespaces a gateway tool', () => {
    // Found by running a real task: every gateway call was landing in the log twice.
    expect(isGatewayToolName('intellidev_stage_state')).toBe(true)
    expect(isGatewayToolName('mcp__intellidev__stage_state')).toBe(true)
    expect(isGatewayToolName('intellidev__run_check')).toBe(true)
    expect(isGatewayToolName('intellidev.run_check')).toBe(true)
  })

  it('leaves a harness own tools alone', () => {
    // The harness stays authoritative for tools that never touch the gateway.
    expect(isGatewayToolName('read')).toBe(false)
    expect(isGatewayToolName('bash')).toBe(false)
    expect(isGatewayToolName('Edit')).toBe(false)
    expect(isGatewayToolName('sentry__search')).toBe(false)
    expect(isGatewayToolName('')).toBe(false)
  })

  it('does not match a tool that merely starts with the same letters', () => {
    expect(isGatewayToolName('intellidevious_tool')).toBe(false)
  })
})
