import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  createRedactor,
  noopRedactor,
  reservedCollisions,
  secretsForStage,
  type EnvSpec,
  type Redactor,
  type StageId,
} from '@intellidev/shared'
import type { BrokerClient } from './client.js'

export interface StageEnv {
  /** Merged plaintext vars and resolved secrets, ready to hand a child process. */
  env: Record<string, string>
  /** Built from the resolved secret values, so the bus can scrub them from the log. */
  redactor: Redactor
  /** Declared but not resolvable. A run should say so rather than fail obscurely. */
  unresolved: string[]
}

/**
 * Resolve the environment for one stage.
 *
 * Precedence, lowest first: manifest `vars`, then resolved secrets. Secrets win because
 * a project overriding its own placeholder with the real value is the normal case.
 *
 * Secrets are fetched per stage rather than once per run, so the broker can refuse a
 * stage that has no business with them and the audit log shows who asked.
 */
export async function materialiseStageEnv(args: {
  envSpec: EnvSpec
  stage: StageId
  client: BrokerClient
  /** Skip the broker entirely when a stage has no secrets in scope. */
  skipWhenNoSecrets?: boolean
}): Promise<StageEnv> {
  const { envSpec, stage, client } = args

  const collisions = reservedCollisions(envSpec)
  if (collisions.length > 0) {
    // Caught at dispatch too, but a second check here means a hand-edited manifest
    // cannot quietly break the credential helper.
    throw new Error(`project env overrides names the adapter owns: ${collisions.join(', ')}`)
  }

  const inScope = secretsForStage(envSpec, stage)
  if (inScope.length === 0 && args.skipWhenNoSecrets !== false) {
    return { env: { ...envSpec.vars }, redactor: noopRedactor, unresolved: [] }
  }

  const resolved = await client.secrets()
  // The broker returns what this stage may see; anything outside scope is ignored here
  // rather than trusted, so a broker bug cannot widen a stage's access.
  const allowedNames = new Set(inScope.map((s) => s.name))
  const values: Record<string, string> = {}
  for (const [name, value] of Object.entries(resolved.values)) {
    if (allowedNames.has(name)) values[name] = value
  }

  const missing = [...allowedNames].filter((name) => !(name in values)).sort()

  return {
    env: { ...envSpec.vars, ...values },
    redactor: createRedactor(values),
    unresolved: [...new Set([...resolved.unresolved, ...missing])].sort(),
  }
}

/**
 * Write a dotenv file most repos expect, and make git ignore it.
 *
 * The ignore goes in `.git/info/exclude`, not the repo's `.gitignore`: editing a
 * tracked file would put our plumbing in the PR diff, and a reviewer would rightly
 * ask why the agent touched it.
 */
export async function writeDotenv(args: {
  worktree: string
  dotenvPath: string
  env: Record<string, string>
}): Promise<string> {
  const target = join(args.worktree, args.dotenvPath)
  await mkdir(dirname(target), { recursive: true })

  const body = Object.entries(args.env)
    .map(([key, value]) => `${key}=${quoteDotenv(value)}`)
    .join('\n')
  await writeFile(target, `${body}\n`, { mode: 0o600 })

  await excludeFromGit(args.worktree, args.dotenvPath)
  return target
}

/** Values with whitespace or quotes need quoting or dotenv parsers disagree. */
function quoteDotenv(value: string): string {
  if (!/[\s"'#$`\\]/.test(value)) return value
  return `"${value.replace(/([\\"$`])/g, '\\$1').replace(/\n/g, '\\n')}"`
}

async function excludeFromGit(worktree: string, relativePath: string): Promise<void> {
  // In a worktree, `.git` is a file pointing at the real gitdir, so try both layouts
  // and fail quietly: a missing exclude is a tidiness problem, not a run-stopper.
  const candidates = [join(worktree, '.git', 'info', 'exclude')]
  try {
    const dotGit = await readFile(join(worktree, '.git'), 'utf8')
    const match = /^gitdir:\s*(.+)$/m.exec(dotGit)
    if (match?.[1]) candidates.push(join(match[1].trim(), 'info', 'exclude'))
  } catch {
    // `.git` is a directory, which the first candidate already covers.
  }

  for (const candidate of candidates) {
    try {
      const existing = await readFile(candidate, 'utf8').catch(() => '')
      if (existing.split('\n').some((line) => line.trim() === relativePath)) return
      await mkdir(dirname(candidate), { recursive: true })
      await appendFile(candidate, `${relativePath}\n`)
      return
    } catch {
      continue
    }
  }
}
