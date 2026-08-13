import { GATEWAY_SERVER_NAME } from '../config/spec.js'

/**
 * Recognise a tool call that already passed through our gateway.
 *
 * FOUND BY RUNNING IT. The gateway emits `tool.call` / `tool.result` for everything routed
 * through it, and a harness *also* reports its own tool use — so every gateway call landed
 * in the log twice, once under the gateway's name (`stage_state`) and once under the
 * harness's namespaced name (`intellidev_stage_state`). A reviewer reading the log would
 * count double, and the PR body's tool counts would be wrong.
 *
 * The gateway is authoritative for its own tools, because only it knows which upstream
 * server answered and which calls were refused. The harness stays authoritative for its
 * *native* tools — `read`, `glob`, `bash` — which never touch the gateway. So each mapper
 * drops tool events that name the gateway, and keeps everything else.
 *
 * Each harness namespaces differently, so all three shapes are matched:
 *
 *   opencode     `intellidev_stage_state`
 *   Claude Code  `mcp__intellidev__stage_state`
 *   Codex        `intellidev__stage_state`
 */
const SEPARATORS = ['__', '_', '.', '/', '-']

export function isGatewayToolName(name: string, server = GATEWAY_SERVER_NAME): boolean {
  if (!name) return false

  // Claude Code's MCP form, which carries its own prefix.
  if (name.startsWith(`mcp__${server}__`)) return true

  for (const separator of SEPARATORS) {
    if (name.startsWith(`${server}${separator}`)) return true
  }
  return false
}
