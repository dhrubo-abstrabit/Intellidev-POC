import { join } from 'node:path'
import { renderContextDocument } from './context.js'
import {
  GATEWAY_SERVER_NAME,
  IRREVERSIBLE_DENY,
  stableStringify,
  type Projection,
  type ProjectedFile,
  type ProjectionSpec,
} from './spec.js'
import { renderToml } from './toml.js'

/**
 * One renderer per harness. Each returns the files to write; none performs I/O.
 *
 * Every renderer produces exactly **one** MCP server entry — the gateway — which is the
 * whole reason three different config formats do not become three different tool
 * configurations to maintain.
 */

export type Renderer = (spec: ProjectionSpec) => Projection

/** Deny-list every harness gets, plus whatever the project added. */
function denyList(spec: ProjectionSpec): string[] {
  return [...new Set([...IRREVERSIBLE_DENY, ...spec.policy.deny])].sort()
}

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

export const renderClaudeCode: Renderer = (spec) => {
  const files: ProjectedFile[] = [
    {
      path: join(spec.cwd, '.mcp.json'),
      contents: stableStringify({
        mcpServers: {
          [GATEWAY_SERVER_NAME]: {
            type: 'http',
            url: spec.gateway.url,
            headers: { Authorization: `Bearer ${spec.gateway.token}` },
          },
        },
      }),
    },
    {
      path: join(spec.home, '.claude', 'settings.json'),
      contents: stableStringify({
        // Only the gateway is pre-approved. Per-tool scoping is the gateway's job,
        // because this file cannot know which stage is running.
        permissions: {
          allow: [`mcp__${GATEWAY_SERVER_NAME}`],
          deny: denyList(spec),
        },
        // Explicit opt-in so a stray server in a developer's config cannot join the run.
        enableAllProjectMcpServers: false,
        enabledMcpjsonServers: [GATEWAY_SERVER_NAME],
        ...(spec.model ? { model: spec.model } : {}),
      }),
    },
    {
      path: join(spec.cwd, 'CLAUDE.md'),
      // Native skills: no index, because Claude Code loads them with progressive
      // disclosure and duplicating the list would just spend tokens.
      contents: renderContextDocument({
        context: spec.context,
        skills: spec.skills,
        includeSkillIndex: false,
      }),
    },
  ]
  // Claude Code has no config key for skills; it reads a conventional directory. The
  // link is therefore declared as part of the projection, not done behind its back.
  const links = spec.skillsDir
    ? [{ link: join(spec.cwd, '.claude', 'skills'), target: spec.skillsDir }]
    : []
  return { files, links }
}

// ---------------------------------------------------------------------------
// Codex
// ---------------------------------------------------------------------------

/** Our tool mode maps onto Codex's coarse sandbox, which is all it has. */
export function codexSandbox(mode: ProjectionSpec['policy']['mode']): string {
  return mode === 'full' ? 'workspace-write' : 'read-only'
}

export const renderCodex: Renderer = (spec) => ({
  links: [],
  files: [
    {
      path: join(spec.home, '.codex', 'config.toml'),
      contents: renderToml({
        scalars: {
          ...(spec.model ? { model: spec.model } : {}),
          // Nothing can answer a prompt in an unattended run; the container is the sandbox.
          approval_policy: 'never',
          sandbox_mode: codexSandbox(spec.policy.mode),
        },
        tables: [
          {
            path: ['mcp_servers', GATEWAY_SERVER_NAME],
            // Verified against codex 0.147.0: `codex mcp add --url
            // --bearer-token-env-var` writes exactly these two keys. Codex reads the
            // token from the environment rather than config, which keeps the secret out
            // of a file we render.
            values: { url: spec.gateway.url, bearer_token_env_var: spec.gateway.tokenEnvVar },
          },
        ],
      }),
    },
    {
      path: join(spec.cwd, 'AGENTS.md'),
      // No skill primitive, so the index is the only way a skill is discoverable, and
      // `skill_load` on the gateway is how the body arrives.
      contents: renderContextDocument({
        context: spec.context,
        skills: spec.skills,
        includeSkillIndex: true,
      }),
    },
  ],
})

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

/**
 * opencode's per-tool permission rules.
 *
 * Set permissively for everything the gateway governs, and denied only where the action
 * is irreversible. Tightening here would fight the gateway: the two disagreeing shows up
 * as the model apparently refusing to work.
 */
export function opencodePermissions(spec: ProjectionSpec): Record<string, string> {
  const write = spec.policy.mode === 'full' ? 'allow' : 'deny'
  return {
    read: 'allow',
    grep: 'allow',
    glob: 'allow',
    list: 'allow',
    lsp: 'allow',
    skill: 'allow',
    todowrite: 'allow',
    edit: write,
    bash: write,
    // Reaching outside the worktree is never part of a run's job.
    external_directory: 'deny',
    webfetch: 'deny',
    websearch: 'deny',
  }
}

export const renderOpencode: Renderer = (spec) => ({
  links: [],
  files: [
    {
      path: join(spec.cwd, 'opencode.json'),
      contents: stableStringify({
        $schema: 'https://opencode.ai/config.json',
        ...(spec.model ? { model: spec.model } : {}),
        mcp: {
          [GATEWAY_SERVER_NAME]: {
            type: 'remote',
            url: spec.gateway.url,
            headers: { Authorization: `Bearer ${spec.gateway.token}` },
            enabled: true,
          },
        },
        // Native skills, by path. No index in the context document for the same reason as
        // Claude Code.
        ...(spec.skillsDir ? { skills: { paths: [spec.skillsDir] } } : {}),
        instructions: [join(spec.cwd, 'AGENTS.md')],
        permission: opencodePermissions(spec),
      }),
    },
    {
      path: join(spec.cwd, 'AGENTS.md'),
      contents: renderContextDocument({
        context: spec.context,
        skills: spec.skills,
        includeSkillIndex: false,
      }),
    },
  ],
})

// ---------------------------------------------------------------------------

export const RENDERERS: Record<ProjectionSpec['harness'], Renderer> = {
  'claude-code': renderClaudeCode,
  codex: renderCodex,
  opencode: renderOpencode,
}

export function renderForHarness(spec: ProjectionSpec): Projection {
  const renderer = RENDERERS[spec.harness]
  if (!renderer) throw new Error(`no config renderer for harness "${spec.harness}"`)
  return renderer(spec)
}
