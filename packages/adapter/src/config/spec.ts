import type { HarnessId, SkillRef, ToolPolicy } from '@intellidev/shared'

/**
 * The canonical input every renderer reads.
 *
 * One spec, three projections. Adding a fourth harness means writing one renderer
 * against this — not touching stages, tools, skills or the gateway.
 */
export interface ProjectionSpec {
  harness: HarnessId
  /** The worktree. Project-scoped config lands here. */
  cwd: string
  /** Pinned per run so a developer's real home is never written to. */
  home: string
  /**
   * How a harness reaches the gateway.
   *
   * Loopback HTTP rather than stdio, verified against all three CLIs. If the harness
   * spawned the gateway itself it would be a separate process from the adapter, and every
   * built-in tool would need a second IPC hop back for stage state and event emission.
   * In-process over 127.0.0.1 removes that entirely.
   *
   * The token is passed by header where a harness supports one, and by environment
   * variable for Codex, which reads `bearer_token_env_var`.
   */
  gateway: { url: string; token: string; tokenEnvVar: string }
  /** Absolute path to the resolved skills directory, or null when there are none. */
  skillsDir: string | null
  skills: readonly SkillRef[]
  /** Contents of the project's context document, already read. */
  context: string
  /** Baseline policy. Stage scoping is NOT projected — see the note below. */
  policy: ToolPolicy
  model?: string
  /** Shell command for `credential.helper`, if the run has a broker. */
  credentialHelper?: string
}

/**
 * A file to write. Renderers return these rather than performing I/O, so a projection
 * can be asserted in full without a filesystem.
 */
export interface ProjectedFile {
  /** Absolute path. */
  path: string
  contents: string
  /** Defaults to 0644. Config carrying no secrets does not need to be tighter. */
  mode?: number
}

/**
 * A symlink to create.
 *
 * Part of the projection rather than a side effect of writing it: Claude Code discovers
 * skills from a conventional path, so its skills wiring is a link rather than a config
 * key. If that were an implicit step, a failure would make skills silently vanish with
 * nothing in any config file to explain it.
 */
export interface ProjectedLink {
  link: string
  target: string
}

/** Everything a harness needs on disk, fully described. */
export interface Projection {
  files: ProjectedFile[]
  links: ProjectedLink[]
}

/** The single MCP server name every harness sees. */
export const GATEWAY_SERVER_NAME = 'intellidev'

/**
 * WHY STAGE SCOPING IS NEVER PROJECTED INTO HARNESS CONFIG.
 *
 * Harness config is written **once at boot**, and the stage moves during the run. A
 * permission file that encoded "design may not write" would be stale the moment `code`
 * started, and there is no way to express "it depends which stage is running" in any of
 * the three formats.
 *
 * So the gateway is the authoritative filter, and harness-level permissions are
 * defence-in-depth for the *irreversible* things only. The two must not disagree: if a
 * harness denied something the gateway allows, the stage would fail in a way that looks
 * like the model refusing to work.
 */
export const IRREVERSIBLE_DENY = [
  'Bash(git push --force*)',
  'Bash(git push -f*)',
  'Bash(git reset --hard*)',
  'Bash(rm -rf /*)',
] as const

/** Deterministic JSON, so re-rendering an unchanged spec produces an identical file. */
export function stableStringify(value: unknown, indent = 2): string {
  return `${JSON.stringify(sortKeys(value), null, indent)}\n`
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys)
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key])
    }
    return out
  }
  return value
}
