import { mkdir, mkdtemp, readFile, readlink, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolPolicy, type HarnessId, type SkillRef } from '@intellidev/shared'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { GENERATED_HEADER, renderContextDocument } from '../src/config/context.js'
import { ensureSymlink, materialiseConfig, writeIfChanged } from '../src/config/materialise.js'
import {
  RENDERERS,
  codexSandbox,
  opencodePermissions,
  renderForHarness,
} from '../src/config/renderers.js'
import {
  GATEWAY_SERVER_NAME,
  IRREVERSIBLE_DENY,
  stableStringify,
  type ProjectionSpec,
} from '../src/config/spec.js'
import { renderToml } from '../src/config/toml.js'

const skills: SkillRef[] = [
  {
    name: 'migrations',
    origin: 'project',
    path: 'skills/migrations',
    description: 'Review first',
    stages: [],
  },
  { name: 'release', origin: 'org', path: 'skills/release', stages: [] },
]

function spec(over: Partial<ProjectionSpec> = {}): ProjectionSpec {
  return {
    harness: 'opencode',
    cwd: '/work/run-1',
    home: '/home/adapter',
    gateway: {
      url: 'http://127.0.0.1:7717/mcp',
      token: 'gwt_secret_value',
      tokenEnvVar: 'INTELLIDEV_GATEWAY_TOKEN',
    },
    skillsDir: '/opt/project/skills',
    skills,
    context: '# acme-web\n\nUse pnpm. Never edit generated files.',
    policy: ToolPolicy.parse({ mode: 'full' }),
    model: 'anthropic/claude-opus-5',
    ...over,
  }
}

const fileFor = (projection: ReturnType<typeof renderForHarness>, suffix: string) =>
  projection.files.find((f) => f.path.endsWith(suffix))

// --- one gateway entry, every harness --------------------------------------

describe('every harness gets exactly one MCP server', () => {
  const harnesses: HarnessId[] = ['claude-code', 'codex', 'opencode']

  it.each(harnesses)('%s points at the gateway and nothing else', (harness) => {
    const config = renderForHarness(spec({ harness }))
      .files.map((f) => f.contents)
      .join('\n')
    // The whole reason three config formats do not become three tool configurations.
    expect(config).toContain(GATEWAY_SERVER_NAME)
    expect(config).toContain('http://127.0.0.1:7717/mcp')
    // No other server may appear.
    expect(config).not.toMatch(/sentry|linear/i)
  })

  it.each(harnesses)('%s writes a context document', (harness) => {
    const { files } = renderForHarness(spec({ harness }))
    const context = files.find((f) => /CLAUDE\.md|AGENTS\.md/.test(f.path))
    expect(context?.contents).toContain('Use pnpm.')
  })

  it('switching harness changes which files are written, and nothing else', () => {
    // T8 acceptance, stated directly: the harness is a rendering target. Stages, tools
    // and skills must behave identically regardless of which one runs.
    const projections = harnesses.map((harness) => ({
      harness,
      ...renderForHarness(spec({ harness })),
    }))

    // The set of paths differs...
    const pathSets = projections.map((p) => p.files.map((f) => f.path.split('/').pop()).sort())
    expect(new Set(pathSets.map((p) => p.join(','))).size).toBe(harnesses.length)

    for (const { harness, files, links } of projections) {
      const all = [...files.map((f) => f.contents), ...links.map((l) => l.target)].join('\n')
      // ...but the gateway invocation is byte-identical everywhere.
      expect(all, harness).toContain('http://127.0.0.1:7717/mcp')

      // The context body is the same text in every projection.
      const context = files.find((f) => /CLAUDE\.md|AGENTS\.md/.test(f.path))
      expect(context?.contents, harness).toContain('Never edit generated files.')

      // Every harness can reach both skills: two by path (config key or declared link),
      // one through the index in its context document.
      const reachesSkills =
        all.includes('/opt/project/skills') ||
        (all.includes('migrations') && all.includes('release'))
      expect(reachesSkills, `${harness} cannot reach the skills`).toBe(true)
    }
  })

  it('covers every harness in the union', () => {
    // A new HarnessId with no renderer would otherwise fail only at boot.
    expect(Object.keys(RENDERERS).sort()).toEqual(['claude-code', 'codex', 'opencode'])
  })
})

// --- Claude Code -----------------------------------------------------------

describe('claude-code projection', () => {
  const projection = renderForHarness(spec({ harness: 'claude-code' }))

  it('writes .mcp.json in the worktree with only the gateway', () => {
    const mcp = JSON.parse(fileFor(projection, '.mcp.json')!.contents)
    expect(Object.keys(mcp.mcpServers)).toEqual([GATEWAY_SERVER_NAME])
    expect(mcp.mcpServers[GATEWAY_SERVER_NAME]).toEqual({
      type: 'http',
      url: 'http://127.0.0.1:7717/mcp',
      headers: { Authorization: 'Bearer gwt_secret_value' },
    })
  })

  it('pre-approves the gateway but not individual tools', () => {
    const settings = JSON.parse(fileFor(projection, 'settings.json')!.contents)
    // This file cannot know which stage is running, so per-tool scoping stays with the
    // gateway; encoding it here would be stale the moment the stage moved.
    expect(settings.permissions.allow).toEqual([`mcp__${GATEWAY_SERVER_NAME}`])
  })

  it('denies the irreversible things as defence in depth', () => {
    const settings = JSON.parse(fileFor(projection, 'settings.json')!.contents)
    for (const pattern of IRREVERSIBLE_DENY) expect(settings.permissions.deny).toContain(pattern)
  })

  it('merges project deny patterns without duplicating the defaults', () => {
    const withExtra = renderForHarness(
      spec({
        harness: 'claude-code',
        policy: ToolPolicy.parse({
          mode: 'full',
          deny: ['Bash(git push --force*)', 'Bash(curl*)'],
        }),
      }),
    )
    const settings = JSON.parse(fileFor(withExtra, 'settings.json')!.contents)
    expect(settings.permissions.deny).toContain('Bash(curl*)')
    expect(
      settings.permissions.deny.filter((d: string) => d === 'Bash(git push --force*)'),
    ).toHaveLength(1)
  })

  it('refuses to inherit a developer’s other MCP servers', () => {
    const settings = JSON.parse(fileFor(projection, 'settings.json')!.contents)
    expect(settings.enableAllProjectMcpServers).toBe(false)
    expect(settings.enabledMcpjsonServers).toEqual([GATEWAY_SERVER_NAME])
  })

  it('declares the skills link in the projection, not as a hidden side effect', () => {
    // A link created behind the projection's back would make skills vanish silently if
    // the step ever failed.
    expect(projection.links).toEqual([
      { link: '/work/run-1/.claude/skills', target: '/opt/project/skills' },
    ])
  })

  it('declares no link when the project has no skills', () => {
    expect(renderForHarness(spec({ harness: 'claude-code', skillsDir: null })).links).toEqual([])
  })

  it('omits the skill index, because native loading does it better', () => {
    // Duplicating the list would spend tokens on what the harness already does with
    // progressive disclosure.
    const context = fileFor(projection, 'CLAUDE.md')!.contents
    expect(context).not.toContain('Available skills')
    expect(context).toContain(GENERATED_HEADER)
  })
})

// --- Codex -----------------------------------------------------------------

describe('codex projection', () => {
  const projection = renderForHarness(spec({ harness: 'codex' }))
  const toml = fileFor(projection, 'config.toml')!.contents

  it('declares the gateway as an mcp_servers table', () => {
    expect(toml).toContain(`[mcp_servers.${GATEWAY_SERVER_NAME}]`)
    // Exactly the keys `codex mcp add --url --bearer-token-env-var` writes.
    expect(toml).toContain('url = "http://127.0.0.1:7717/mcp"')
    expect(toml).toContain('bearer_token_env_var = "INTELLIDEV_GATEWAY_TOKEN"')
    // Codex reads the token from the environment, so it must not be inline.
    expect(toml).not.toContain('gwt_secret_value')
  })

  it('never asks for approval, since nothing can answer', () => {
    expect(toml).toContain('approval_policy = "never"')
  })

  it('maps tool mode onto the only sandbox control codex has', () => {
    expect(codexSandbox('full')).toBe('workspace-write')
    expect(codexSandbox('read_only')).toBe('read-only')
    expect(codexSandbox('none')).toBe('read-only')
    expect(toml).toContain('sandbox_mode = "workspace-write"')
  })

  it('puts scalars before tables, as TOML requires', () => {
    expect(toml.indexOf('approval_policy')).toBeLessThan(toml.indexOf('[mcp_servers'))
  })

  it('includes the skill index, because codex has no skill primitive', () => {
    // Here the index is the only way a skill is discoverable at all.
    const context = fileFor(projection, 'AGENTS.md')!.contents
    expect(context).toContain('Available skills')
    expect(context).toContain('**migrations** — Review first')
    expect(context).toContain('no summary provided')
    expect(context).toContain('skill_load')
  })
})

// --- opencode --------------------------------------------------------------

describe('opencode projection', () => {
  const projection = renderForHarness(spec({ harness: 'opencode' }))
  const config = JSON.parse(fileFor(projection, 'opencode.json')!.contents)

  it('declares the gateway as a remote mcp server', () => {
    expect(config.mcp[GATEWAY_SERVER_NAME]).toEqual({
      type: 'remote',
      url: 'http://127.0.0.1:7717/mcp',
      headers: { Authorization: 'Bearer gwt_secret_value' },
      enabled: true,
    })
  })

  it('uses native skills by path', () => {
    expect(config.skills).toEqual({ paths: ['/opt/project/skills'] })
    expect(fileFor(projection, 'AGENTS.md')!.contents).not.toContain('Available skills')
  })

  it('omits skills entirely when the project has none', () => {
    const none = JSON.parse(
      fileFor(renderForHarness(spec({ skillsDir: null, skills: [] })), 'opencode.json')!.contents,
    )
    expect(none.skills).toBeUndefined()
  })

  it('points instructions at the context document', () => {
    expect(config.instructions).toEqual(['/work/run-1/AGENTS.md'])
  })

  it('permits what the gateway governs and denies the irreversible', () => {
    // Tightening here would fight the gateway, which shows up as the model apparently
    // refusing to work.
    expect(config.permission.read).toBe('allow')
    expect(config.permission.edit).toBe('allow')
    expect(config.permission.external_directory).toBe('deny')
    expect(config.permission.websearch).toBe('deny')
  })

  it('flips write permissions with the stage tool mode', () => {
    const readOnly = opencodePermissions(spec({ policy: ToolPolicy.parse({ mode: 'read_only' }) }))
    expect(readOnly.edit).toBe('deny')
    expect(readOnly.bash).toBe('deny')
    expect(readOnly.read).toBe('allow')
  })

  it('references the published config schema', () => {
    expect(config.$schema).toBe('https://opencode.ai/config.json')
  })
})

// --- determinism -----------------------------------------------------------

describe('determinism', () => {
  it('sorts keys so an unchanged spec renders byte-identically', () => {
    const a = renderForHarness(spec({ harness: 'opencode' }))
    const b = renderForHarness(spec({ harness: 'opencode' }))
    expect(a.files.map((f) => f.contents)).toEqual(b.files.map((f) => f.contents))
  })

  it('does not depend on key insertion order', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('ends every file with a newline', () => {
    for (const harness of ['claude-code', 'codex', 'opencode'] as HarnessId[]) {
      for (const file of renderForHarness(spec({ harness })).files) {
        expect(file.contents.endsWith('\n'), `${harness} ${file.path}`).toBe(true)
      }
    }
  })
})

// --- TOML escaping ---------------------------------------------------------

describe('renderToml', () => {
  it('quotes keys outside the bare charset', () => {
    expect(
      renderToml({ tables: [{ path: ['mcp_servers', 'claude.ai Sentry'], values: { a: '1' } }] }),
    ).toContain('[mcp_servers."claude.ai Sentry"]')
  })

  it('escapes backslashes and quotes, which would otherwise break the parse', () => {
    // A malformed file surfaces as "no MCP servers configured", not as a syntax error.
    const out = renderToml({ scalars: { p: 'C:\\work\\"x"' } })
    expect(out).toBe('p = "C:\\\\work\\\\\\"x\\""\n')
  })

  it('escapes control characters as \\uXXXX', () => {
    expect(renderToml({ scalars: { s: 'a\u0001b' } })).toContain('\\u0001')
  })

  it('writes booleans and numbers unquoted', () => {
    expect(renderToml({ scalars: { n: 3, b: true } })).toBe('n = 3\nb = true\n')
  })

  it('skips undefined values rather than emitting empty keys', () => {
    expect(renderToml({ scalars: { a: 'x', b: undefined } })).toBe('a = "x"\n')
  })
})

describe('renderContextDocument', () => {
  it('marks the file as generated so nobody edits it by hand', () => {
    const out = renderContextDocument({ context: 'body', skills: [], includeSkillIndex: true })
    expect(out.startsWith(GENERATED_HEADER)).toBe(true)
    expect(out).toContain('Edit the manifest, not this file')
  })

  it('omits the index when asked to include it but there are no skills', () => {
    const out = renderContextDocument({ context: 'body', skills: [], includeSkillIndex: true })
    expect(out).not.toContain('Available skills')
  })

  it('sorts skills by name', () => {
    const out = renderContextDocument({ context: 'b', skills, includeSkillIndex: true })
    expect(out.indexOf('migrations')).toBeLessThan(out.indexOf('release'))
  })
})

// --- writing to disk -------------------------------------------------------

describe('materialiseConfig', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-config-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  const onDisk = (over: Partial<ProjectionSpec> = {}) =>
    spec({
      cwd: join(root, 'work'),
      home: join(root, 'home'),
      skillsDir: join(root, 'skills'),
      ...over,
    })

  it('writes every file, then writes nothing on a second run', async () => {
    const s = onDisk({ harness: 'codex' })
    const first = await materialiseConfig(s)
    expect(first.written.length).toBeGreaterThan(0)
    expect(first.unchanged).toEqual([])

    const second = await materialiseConfig(s)
    // A resumed run re-materialises; churning mtimes would make it impossible to tell
    // whether anything actually changed.
    expect(second.written).toEqual([])
    expect(second.unchanged.length).toBe(first.written.length)
  })

  it('rewrites when the spec changes', async () => {
    await materialiseConfig(onDisk({ harness: 'codex' }))
    const changed = await materialiseConfig(onDisk({ harness: 'codex', model: 'gpt-5-codex' }))
    expect(changed.written.some((p) => p.endsWith('config.toml'))).toBe(true)
  })

  it('creates parent directories that do not exist yet', async () => {
    await materialiseConfig(onDisk({ harness: 'claude-code' }))
    const settings = await readFile(join(root, 'home', '.claude', 'settings.json'), 'utf8')
    expect(JSON.parse(settings).permissions).toBeDefined()
  })

  it('links the skills directory for a harness with native skills', async () => {
    await mkdir(join(root, 'skills'), { recursive: true })
    const report = await materialiseConfig(onDisk({ harness: 'claude-code' }))
    expect(report.links[0]?.created).toBe(true)
    expect(await readlink(join(root, 'work', '.claude', 'skills'))).toBe(join(root, 'skills'))
  })

  it('leaves an already-correct link alone', async () => {
    await mkdir(join(root, 'skills'), { recursive: true })
    const s = onDisk({ harness: 'claude-code' })
    await materialiseConfig(s)
    expect((await materialiseConfig(s)).links[0]?.created).toBe(false)
  })

  it('replaces a link pointing somewhere stale', async () => {
    await mkdir(join(root, 'skills'), { recursive: true })
    await mkdir(join(root, 'old-skills'), { recursive: true })
    const link = join(root, 'work', '.claude', 'skills')
    await ensureSymlink(link, join(root, 'old-skills'))
    // A stale link would silently serve the previous run's skills.
    await materialiseConfig(onDisk({ harness: 'claude-code' }))
    expect(await readlink(link)).toBe(join(root, 'skills'))
  })

  it('does not link skills for a harness that reads them from config', async () => {
    const report = await materialiseConfig(onDisk({ harness: 'opencode' }))
    // opencode declares skills by config key, so it declares no links at all.
    expect(report.links).toEqual([])
  })

  it('writes config world-readable, since it carries no secrets', async () => {
    await materialiseConfig(onDisk({ harness: 'opencode' }))
    const mode = (await stat(join(root, 'work', 'opencode.json'))).mode & 0o777
    expect(mode).toBe(0o644)
  })
})

describe('writeIfChanged', () => {
  let root: string
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'intellidev-wic-'))
  })
  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  it('reports false when contents already match', async () => {
    const path = join(root, 'a.json')
    await writeFile(path, 'same\n')
    expect(await writeIfChanged({ path, contents: 'same\n' })).toBe(false)
    expect(await writeIfChanged({ path, contents: 'different\n' })).toBe(true)
  })
})
