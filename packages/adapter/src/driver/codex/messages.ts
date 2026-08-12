import { z } from 'zod'

/**
 * Raw Codex `exec --json` events.
 *
 * Verified against codex-cli 0.147.0 using the fixtures in `test/fixtures/codex/`.
 *
 * The shape is fundamentally different from Claude Code's: Codex emits typed
 * *items* with `item.started` / `item.completed` around them, rather than message
 * content blocks. That difference is the reason this driver exists before anything
 * is built on top of the abstraction.
 */

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough()

/** Carries the thread id, which is the resume token for `codex exec resume`. */
export const CxThreadStarted = loose({
  type: z.literal('thread.started'),
  thread_id: z.string(),
})

export const CxTurnStarted = loose({ type: z.literal('turn.started') })

/**
 * Field names differ from Claude Code's: `cached_input_tokens` rather than
 * `cache_read_input_tokens`, and there is no cost figure at all.
 */
export const CxUsage = loose({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cached_input_tokens: z.number().default(0),
  cache_write_input_tokens: z.number().default(0),
  reasoning_output_tokens: z.number().default(0),
})

export const CxTurnCompleted = loose({
  type: z.literal('turn.completed'),
  usage: CxUsage.optional(),
})

export const CxTurnFailed = loose({
  type: z.literal('turn.failed'),
  error: z.unknown().optional(),
})

// --- items ---------------------------------------------------------------

export const CxCommandItem = loose({
  id: z.string(),
  type: z.literal('command_execution'),
  command: z.string(),
  aggregated_output: z.string().default(''),
  exit_code: z.number().nullish(),
  status: z.string().optional(),
})

export const CxAgentMessageItem = loose({
  id: z.string(),
  type: z.literal('agent_message'),
  text: z.string().default(''),
})

export const CxFileChangeItem = loose({
  id: z.string(),
  type: z.literal('file_change'),
  changes: z.array(loose({ path: z.string(), kind: z.string() })).default([]),
  status: z.string().optional(),
})

export const CxReasoningItem = loose({
  id: z.string(),
  type: z.literal('reasoning'),
})

/**
 * Anticipated but NOT yet observed in a fixture. Handled so a real one is mapped
 * rather than reported as drift, and flagged here so nobody mistakes it for
 * verified behaviour.
 */
export const CxMcpToolCallItem = loose({
  id: z.string(),
  type: z.literal('mcp_tool_call'),
  server: z.string().optional(),
  tool: z.string().optional(),
  arguments: z.unknown().optional(),
  result: z.unknown().optional(),
  status: z.string().optional(),
  error: z.unknown().optional(),
})

export const CxItem = z.union([
  CxCommandItem,
  CxAgentMessageItem,
  CxFileChangeItem,
  CxReasoningItem,
  CxMcpToolCallItem,
  loose({ id: z.string().optional(), type: z.string() }),
])

export const CxItemEvent = loose({
  type: z.union([z.literal('item.started'), z.literal('item.completed')]),
  item: CxItem,
})

/** Item types we knowingly ignore, listed so a new one reads as drift. */
export const IGNORED_ITEM_TYPES = new Set(['todo_list', 'web_search'])

/** Top-level event types we knowingly ignore. */
export const IGNORED_TYPES = new Set(['turn.started', 'thread.continued'])

/** `file_change.changes[].kind` → our canonical change vocabulary. */
export const FILE_CHANGE_KINDS: Record<string, 'added' | 'modified' | 'deleted'> = {
  add: 'added',
  added: 'added',
  create: 'added',
  modify: 'modified',
  modified: 'modified',
  update: 'modified',
  edit: 'modified',
  delete: 'deleted',
  deleted: 'deleted',
  remove: 'deleted',
}

/**
 * `codex exec` runs shell commands rather than exposing named tools, so a
 * `command_execution` maps onto the same canonical `tool.call` shape as Claude
 * Code's `Bash` — which is what lets one UI render both.
 */
export const COMMAND_TOOL_NAME = 'Bash'
