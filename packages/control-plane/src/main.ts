import { mkdir } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { buildServer } from './server.js'
import { McpRegistry } from './mcp/registry.js'
import type { DispatchMode } from './dispatch.js'

/**
 * Dev entry point.
 *
 * `INTELLIDEV_MODE=docker` runs each task in the golden image, which is the mode that
 * validates the container path. `inline` runs the adapter in this process, which is faster
 * to iterate on. The UI cannot tell them apart, and that is the test.
 */
const port = Number(process.env['PORT'] ?? 4000)
const mode = (process.env['INTELLIDEV_MODE'] ?? 'inline') as DispatchMode
// Resolved against the repo root, not the cwd: `pnpm --filter` runs this from the package
// directory, where a relative `examples/bundle` points at nothing.
const repoRoot = resolve(import.meta.dirname, '..', '..', '..')
const workRoot = resolve(process.env['INTELLIDEV_WORK_ROOT'] ?? join(repoRoot, '.intellidev-work'))
const bundleRoot = resolve(process.env['INTELLIDEV_BUNDLE'] ?? join(repoRoot, 'examples/bundle'))

/**
 * Provider credentials to forward into a run.
 *
 * An allowlist rather than the whole environment: a run should not inherit every secret the
 * control plane happens to hold. Named here so which providers work is a fact you can read
 * rather than discover.
 */
const PROVIDER_KEYS = [
  // A long-lived subscription token from `claude setup-token`. Verified against the pinned
  // CLI binary, which reads this name.
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'OPENROUTER_API_KEY',
  'GROQ_API_KEY',
  'GEMINI_API_KEY',
  'GOOGLE_GENERATIVE_AI_API_KEY',
] as const

const harnessEnv = Object.fromEntries(
  PROVIDER_KEYS.flatMap((key) => {
    const value = process.env[key]
    return value ? [[key, value]] : []
  }),
)

/**
 * Model overrides, per harness.
 *
 * Per-harness rather than one global value, because model ids are not interchangeable:
 * opencode wants `provider/model` while Claude Code wants its own names. A single override
 * applied to whichever harness a task happened to pick is a way to silently break the others.
 * `INTELLIDEV_MODEL` stays as a fallback for the common case of using one harness.
 */
const models = Object.fromEntries(
  (['opencode', 'claude-code', 'codex'] as const).flatMap((harness) => {
    const specific = process.env[`INTELLIDEV_MODEL_${harness.toUpperCase().replace(/-/g, '_')}`]
    const value = specific ?? process.env['INTELLIDEV_MODEL']
    return value ? [[harness, value]] : []
  }),
)

await mkdir(workRoot, { recursive: true })

// Under the work root, not the repo: the file holds live OAuth refresh tokens.
const mcp = await McpRegistry.open(join(workRoot, 'mcp-servers.json'))

const app = await buildServer({
  dispatch: {
    mode,
    bundleRoot,
    image: process.env['INTELLIDEV_IMAGE'] ?? 'intellidev/runner:dev',
    workRoot,
    ...(Object.keys(models).length > 0 ? { models } : {}),
    ...(Object.keys(harnessEnv).length > 0 ? { harnessEnv } : {}),
    ...(process.env['INTELLIDEV_GITHUB_TOKEN']
      ? { githubToken: process.env['INTELLIDEV_GITHUB_TOKEN'] }
      : {}),
    // In docker mode a local bare repo has to be visible inside the container, or git
    // cannot reach an origin that is just a host path.
    ...(process.env['INTELLIDEV_MOUNT_REPO']
      ? {
          extraMounts: [
            {
              source: resolve(process.env['INTELLIDEV_MOUNT_REPO']),
              target: resolve(process.env['INTELLIDEV_MOUNT_REPO']),
            },
          ],
        }
      : {}),
  },
  mcp,
  publicDir: resolve(import.meta.dirname, '..', 'public'),
})

await app.listen({ port, host: '127.0.0.1' })

process.stderr.write(
  [
    ``,
    `  Intellidev control plane`,
    `  → http://127.0.0.1:${port}`,
    ``,
    `  mode    ${mode}${mode === 'inline' ? '  (set INTELLIDEV_MODE=docker to run in a container)' : ''}`,
    `  bundle  ${bundleRoot}`,
    `  work    ${workRoot}`,
    `  mcp     ${mcp.list().length} connected server(s)`,
    `  model   ${
      Object.entries(models)
        .map(([h, v]) => `${h}=${v}`)
        .join(' ') || 'harness default'
    }`,
    `  keys    ${Object.keys(harnessEnv).join(', ') || 'none forwarded'}`,
    ``,
  ].join('\n'),
)
