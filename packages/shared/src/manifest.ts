import { z } from 'zod'
import { HarnessId } from './ids.js'
import { StageTemplate } from './stages.js'

/**
 * A project is data, not an image. This manifest is the single source of truth that
 * both the adapter and every harness derive their configuration from.
 *
 * Manifests are IMMUTABLE and versioned. Runs pin a version, so editing a project
 * never changes the meaning of a run already in flight.
 */

export const RepoRef = z.object({
  url: z.string().min(1),
  defaultBranch: z.string().default('main'),
  branchPattern: z.string().default('feat/{{task.slug}}-{{task.id}}'),
})
export type RepoRef = z.infer<typeof RepoRef>

/** Test dependencies are sidecars in the same task definition — never nested Docker. */
export const ServiceRef = z.object({
  image: z.string().min(1),
  env: z.record(z.string()).default({}),
  portMappings: z.array(z.number().int().positive()).default([]),
})
export type ServiceRef = z.infer<typeof ServiceRef>

export const RuntimeSpec = z.object({
  /** Resolved by mise inside the container and cached in S3. */
  toolchain: z.record(z.string()).default({}),
  setup: z.string().optional(),
  services: z.array(ServiceRef).default([]),
  /** Fargate default is modest; set this from the project rather than discovering it. */
  ephemeralStorageGb: z.number().int().min(21).max(200).default(50),
  cpu: z.number().int().positive().default(2048),
  memoryMb: z.number().int().positive().default(4096),
})
export type RuntimeSpec = z.infer<typeof RuntimeSpec>

export const HarnessSpec = z.object({
  default: HarnessId,
  allowed: z.array(HarnessId).min(1),
  seatPool: z.string().min(1),
  models: z.record(z.object({ model: z.string(), effort: z.string().optional() })).default({}),
})
export type HarnessSpec = z.infer<typeof HarnessSpec>

/** Deny-list the irreversible. Enforced in the adapter, not only in a prompt. */
export const DEFAULT_TOOL_DENY = [
  'Bash(rm -rf /*)',
  'Bash(git push --force*)',
  'Bash(git reset --hard*)',
  'Bash(git push*:main)',
] as const

export const PolicySpec = z.object({
  /** Enforced as a security group plus VPC endpoints — outside the container. */
  network: z.object({ allow: z.array(z.string()).default([]) }).default({}),
  tools: z
    .object({
      allow: z.array(z.string()).default([]),
      deny: z.array(z.string()).default([...DEFAULT_TOOL_DENY]),
    })
    .default({}),
  /** Stages whose completion needs a human decision. */
  approvals: z.array(z.string()).default([]),
})
export type PolicySpec = z.infer<typeof PolicySpec>

export const BudgetSpec = z.object({
  perRun: z
    .object({
      tokensMax: z.number().int().positive().default(4_000_000),
      usdEstMax: z.number().positive().default(8),
      /** Runs that hang bill wall clock the whole time. Not optional. */
      wallClockSec: z.number().int().positive().default(5_400),
      idleKillSec: z.number().int().positive().default(300),
      perStageTimeoutSec: z.number().int().positive().default(1_800),
    })
    .default({}),
  perDay: z.object({ usdEstMax: z.number().positive().default(120) }).default({}),
})
export type BudgetSpec = z.infer<typeof BudgetSpec>

export const ProjectManifest = z.object({
  version: z.number().int().positive(),
  project: z.string().min(1),
  repos: z.array(RepoRef).min(1),
  runtime: RuntimeSpec.default({}),
  harnesses: HarnessSpec,
  /** Catalogue server ids attached to this project; config lives in tool_attachments. */
  toolServerIds: z.array(z.string()).default([]),
  skillDirs: z.array(z.string()).default(['./skills']),
  /** Rendered into CLAUDE.md and AGENTS.md. */
  contextFile: z.string().default('./context/repo.md'),
  stageTemplate: StageTemplate,
  policy: PolicySpec.default({}),
  budget: BudgetSpec.default({}),
})
export type ProjectManifest = z.infer<typeof ProjectManifest>

/** Fill a branch pattern. Kept dumb on purpose — no arbitrary expressions. */
export function renderBranchName(pattern: string, vars: { taskId: string; slug: string }): string {
  return pattern
    .replaceAll('{{task.id}}', vars.taskId)
    .replaceAll('{{task.slug}}', vars.slug)
    .replace(/[^A-Za-z0-9._\/-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^[-\/]+|[-\/]+$/g, '')
}

/** Slugify a task title for use in a branch name. */
export function slugify(title: string, maxLength = 40): string {
  return title
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '')
}
