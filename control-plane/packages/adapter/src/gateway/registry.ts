import type { StageId, ToolPolicy, ToolsetSpec } from '@intellidev/shared'

/**
 * The merged tool list every harness sees, and the rules that shape it.
 *
 * Each harness gets exactly **one** MCP server entry pointing here, which is what makes
 * "connect once" true across three harnesses with three different config formats. The
 * filtering lives here rather than in each harness's own permission model, because only
 * two of the three can express per-tool rules — and levelling down to the weakest would
 * throw away the others' capability.
 */

/** MCP tool names are constrained; upstream names have to be made to fit. */
export const MAX_TOOL_NAME = 64
const NAME_SAFE = /[^a-zA-Z0-9_-]/g

export type ToolOrigin =
  { kind: 'builtin' } | { kind: 'upstream'; serverId: string; remoteName: string }

export interface RegisteredTool {
  /** The name the harness sees, namespaced and sanitised. */
  name: string
  description: string
  inputSchema: Record<string, unknown>
  origin: ToolOrigin
  /** Empty means every stage. */
  stages: readonly StageId[]
}

export type DenyReason = 'stage_scope' | 'policy_deny' | 'not_attached' | 'budget'

export type Resolution =
  { allowed: true; tool: RegisteredTool } | { allowed: false; reason: DenyReason; detail: string }

/**
 * Namespace an upstream tool so two servers exposing `search` cannot collide.
 *
 * Over-long names are truncated with a short stable digest rather than just cut: two
 * tools whose first 60 characters match would otherwise become the same name, and the
 * gateway would route one of them to the wrong server.
 */
export function namespacedToolName(serverId: string, remoteName: string): string {
  const server = serverId.replace(NAME_SAFE, '_')
  const tool = remoteName.replace(NAME_SAFE, '_')
  const joined = `${server}__${tool}`
  if (joined.length <= MAX_TOOL_NAME) return joined

  const digest = shortDigest(joined)
  return `${joined.slice(0, MAX_TOOL_NAME - digest.length - 1)}_${digest}`
}

function shortDigest(text: string): string {
  let hash = 0
  for (let i = 0; i < text.length; i++) hash = (Math.imul(31, hash) + text.charCodeAt(i)) | 0
  return (hash >>> 0).toString(36).slice(0, 6)
}

/** `Bash(git push*)` style patterns, plus plain `*` globs on tool names. */
export function matchesPattern(pattern: string, name: string): boolean {
  const bare = /^([A-Za-z0-9_-]+)\((.*)\)$/.exec(pattern)
  const target = bare ? (bare[1] ?? '') : pattern
  const escaped = target.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`).test(name)
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()
  /** Built-in names, reserved so an upstream server cannot shadow one. */
  private readonly reserved = new Set<string>()

  registerBuiltin(tool: Omit<RegisteredTool, 'origin'>): void {
    this.reserved.add(tool.name)
    this.tools.set(tool.name, { ...tool, origin: { kind: 'builtin' } })
  }

  /**
   * Register everything an attached server exposes, honouring `enabledTools`.
   *
   * A name that collides with a built-in is suffixed rather than dropped: silently
   * losing an upstream tool is worse than an ugly name, because nobody would notice.
   */
  registerUpstream(
    serverId: string,
    tools: ReadonlyArray<{
      name: string
      description?: string
      inputSchema?: Record<string, unknown>
    }>,
    attachment: { enabledTools: readonly string[]; stages: readonly StageId[] },
  ): RegisteredTool[] {
    const added: RegisteredTool[] = []
    for (const tool of tools) {
      if (attachment.enabledTools.length > 0 && !attachment.enabledTools.includes(tool.name)) {
        continue
      }
      let name = namespacedToolName(serverId, tool.name)
      if (this.reserved.has(name) || this.tools.has(name)) name = `${name}_${shortDigest(serverId)}`

      const registered: RegisteredTool = {
        name,
        description: tool.description ?? `${tool.name} (via ${serverId})`,
        inputSchema: tool.inputSchema ?? { type: 'object' },
        origin: { kind: 'upstream', serverId, remoteName: tool.name },
        stages: attachment.stages,
      }
      this.tools.set(name, registered)
      added.push(registered)
    }
    return added
  }

  all(): RegisteredTool[] {
    return [...this.tools.values()]
  }

  /**
   * What a stage may see.
   *
   * NOTE ON WHAT WE CANNOT INFER: a `read_only` policy cannot tell us whether a
   * third-party MCP tool mutates anything — the protocol carries no such signal. So mode
   * gates the built-ins we wrote, and upstream tools are scoped **explicitly** by
   * attachment stages and deny patterns. Guessing from a tool's name would be worse than
   * requiring the operator to say.
   */
  visibleTo(stage: StageId, policy: ToolPolicy): RegisteredTool[] {
    return this.all().filter((tool) => this.decide(tool, stage, policy).allowed)
  }

  /**
   * Resolve a call.
   *
   * Applied to `tools/call` as well as `tools/list`, because a harness may hold a stale
   * list — or simply try a name it remembers. A tool absent from the list must also be
   * refused when invoked, or the filter is decoration.
   */
  resolve(name: string, stage: StageId, policy: ToolPolicy): Resolution {
    const tool = this.tools.get(name)
    if (!tool) {
      return { allowed: false, reason: 'not_attached', detail: `no such tool "${name}"` }
    }
    return this.decide(tool, stage, policy)
  }

  private decide(tool: RegisteredTool, stage: StageId, policy: ToolPolicy): Resolution {
    if (tool.stages.length > 0 && !tool.stages.includes(stage)) {
      return {
        allowed: false,
        reason: 'stage_scope',
        detail: `"${tool.name}" is not in scope for stage "${stage}"`,
      }
    }

    for (const pattern of policy.deny) {
      if (matchesPattern(pattern, tool.name)) {
        return {
          allowed: false,
          reason: 'policy_deny',
          detail: `"${tool.name}" matches deny pattern "${pattern}"`,
        }
      }
    }

    // An explicit allow-list, when present, is exhaustive.
    if (policy.allow.length > 0) {
      const allowed = policy.allow.some((pattern) => matchesPattern(pattern, tool.name))
      if (!allowed) {
        return {
          allowed: false,
          reason: 'policy_deny',
          detail: `"${tool.name}" is not in the stage allow-list`,
        }
      }
    }

    if (policy.mode === 'none' && tool.origin.kind === 'upstream') {
      return {
        allowed: false,
        reason: 'policy_deny',
        detail: `stage tool mode is "none"`,
      }
    }

    return { allowed: true, tool }
  }
}

/** Build the registry for a run from its resolved toolset. */
export function registerToolset(
  registry: ToolRegistry,
  toolset: ToolsetSpec,
): { registered: number; skipped: string[] } {
  const skipped: string[] = []
  let registered = 0

  for (const entry of toolset.servers) {
    if (!entry.snapshot) {
      // Without a cached `tools/list` there is nothing to expose. Recorded rather than
      // ignored, because a required server with no snapshot should block dispatch.
      skipped.push(entry.server.id)
      continue
    }
    registered += registry.registerUpstream(
      entry.server.id,
      entry.snapshot.tools,
      entry.attachment,
    ).length
  }
  return { registered, skipped }
}
