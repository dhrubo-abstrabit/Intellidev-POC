import { z } from 'zod'
import { ConnectionHealth, StageId } from './ids.js'

/**
 * Tools and skills are connected ONCE, in the UI, and then work for every harness
 * on every run. Consent and discovery happen in the control plane because a
 * headless container cannot complete an interactive OAuth consent.
 */

/**
 * Remote servers attach instantly. Built-in stdio servers need the command present
 * in the golden image, so adding one is an image release — the UI must show which
 * kind it is dealing with.
 */
export const ToolServerKind = z.enum(['remote_http', 'remote_sse', 'builtin_stdio'])
export type ToolServerKind = z.infer<typeof ToolServerKind>

export const ToolServerAuth = z.enum(['none', 'oauth2', 'bearer'])
export type ToolServerAuth = z.infer<typeof ToolServerAuth>

/** An entry in the org catalogue: something that *can* be attached to a project. */
export const ToolServer = z
  .object({
    id: z.string(),
    name: z.string().min(1),
    kind: ToolServerKind,
    auth: ToolServerAuth.default('none'),
    /** Required for remote kinds. */
    url: z.string().url().optional(),
    /** Required for builtin_stdio — resolved inside the golden image. */
    command: z.string().optional(),
    args: z.array(z.string()).default([]),
    /** Built-in servers are only visible to projects on this image version or newer. */
    minImageVersion: z.string().optional(),
  })
  .superRefine((server, ctx) => {
    const remote = server.kind !== 'builtin_stdio'
    if (remote && !server.url) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${server.kind} server "${server.name}" needs a url`,
        path: ['url'],
      })
    }
    if (!remote && !server.command) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `builtin_stdio server "${server.name}" needs a command`,
        path: ['command'],
      })
    }
  })
export type ToolServer = z.infer<typeof ToolServer>

/** A cached `tools/list` result. The digest is how tool-list drift is detected. */
export const ToolSnapshot = z.object({
  serverId: z.string(),
  digest: z.string(),
  verifiedAt: z.string().datetime(),
  tools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      inputSchema: z.record(z.unknown()).optional(),
    }),
  ),
})
export type ToolSnapshot = z.infer<typeof ToolSnapshot>

/** This project uses this server, with this config, in these stages. */
export const ToolAttachment = z.object({
  serverId: z.string(),
  /** Per-project config, e.g. which Linear team or Sentry org. */
  config: z.record(z.unknown()).default({}),
  /**
   * A dead optional server degrades the run; a dead required one blocks dispatch
   * with a clear message rather than failing thirty minutes in.
   */
  required: z.boolean().default(false),
  /** Empty means every tool the server exposes. */
  enabledTools: z.array(z.string()).default([]),
  /** Empty means every stage. */
  stages: z.array(StageId).default([]),
  health: ConnectionHealth.default('ok'),
})
export type ToolAttachment = z.infer<typeof ToolAttachment>

/** Precedence, highest first. The UI must show which one won. */
export const SkillOrigin = z.enum(['repo', 'project', 'org'])
export type SkillOrigin = z.infer<typeof SkillOrigin>

export const SkillRef = z.object({
  name: z.string().min(1),
  origin: SkillOrigin,
  description: z.string().optional(),
  /** Path inside the bundle or worktree. */
  path: z.string(),
  version: z.string().optional(),
  stages: z.array(StageId).default([]),
})
export type SkillRef = z.infer<typeof SkillRef>

/**
 * The canonical toolset for one run, resolved by the control plane and projected
 * into each harness's config by the adapter. Every harness ends up with a single
 * MCP server entry pointing at the adapter's gateway.
 */
export const ToolsetSpec = z.object({
  servers: z.array(
    z.object({
      server: ToolServer,
      attachment: ToolAttachment,
      snapshot: ToolSnapshot.optional(),
    }),
  ),
  skills: z.array(SkillRef),
})
export type ToolsetSpec = z.infer<typeof ToolsetSpec>

export const SKILL_ORIGIN_PRECEDENCE: readonly SkillOrigin[] = ['repo', 'project', 'org'] as const

/** Repo beats project beats org, by name. */
export function resolveSkills(candidates: readonly SkillRef[]): SkillRef[] {
  const rank = (origin: SkillOrigin) => SKILL_ORIGIN_PRECEDENCE.indexOf(origin)
  const winner = new Map<string, SkillRef>()
  for (const skill of candidates) {
    const current = winner.get(skill.name)
    if (!current || rank(skill.origin) < rank(current.origin)) winner.set(skill.name, skill)
  }
  return [...winner.values()].sort((a, b) => a.name.localeCompare(b.name))
}

/** Whether an attachment is in scope for a stage. Empty `stages` means all. */
export function attachmentInStage(attachment: ToolAttachment, stage: StageId): boolean {
  return attachment.stages.length === 0 || attachment.stages.includes(stage)
}

/** Whether dispatch should be blocked because a required server needs attention. */
export function blockingAttachments(attachments: readonly ToolAttachment[]): ToolAttachment[] {
  return attachments.filter((a) => a.required && a.health !== 'ok')
}
