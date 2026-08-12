import { z } from 'zod'

/**
 * Raw Claude Code `--output-format stream-json` messages.
 *
 * Verified against claude-code 2.1.228 using the recorded fixtures in
 * `test/fixtures/claude-code/`. Every object is permissive on purpose: we require
 * only the fields we read, so a new field upstream cannot break the parse. What we
 * do NOT tolerate is a new top-level `type` going unnoticed — unrecognised types
 * are reported as drift instead of dropped.
 */

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough()

export const CcUsage = loose({
  input_tokens: z.number().default(0),
  output_tokens: z.number().default(0),
  cache_creation_input_tokens: z.number().default(0),
  cache_read_input_tokens: z.number().default(0),
})

export const CcTextBlock = loose({ type: z.literal('text'), text: z.string() })
export const CcThinkingBlock = loose({ type: z.literal('thinking') })
export const CcToolUseBlock = loose({
  type: z.literal('tool_use'),
  id: z.string(),
  name: z.string(),
  input: z.unknown().optional(),
})
export const CcToolResultBlock = loose({
  type: z.literal('tool_result'),
  tool_use_id: z.string(),
  content: z.unknown().optional(),
  is_error: z.boolean().optional(),
})

/** Blocks we do not recognise are ignored at block level, not treated as drift. */
export const CcContentBlock = z.union([
  CcTextBlock,
  CcThinkingBlock,
  CcToolUseBlock,
  CcToolResultBlock,
  loose({ type: z.string() }),
])

export const CcSystemInit = loose({
  type: z.literal('system'),
  subtype: z.literal('init'),
  session_id: z.string(),
  model: z.string().optional(),
  claude_code_version: z.string().optional(),
  tools: z.array(z.string()).default([]),
  mcp_servers: z.array(loose({ name: z.string(), status: z.string() })).default([]),
  skills: z.array(z.string()).default([]),
  capabilities: z.array(z.string()).default([]),
})

export const CcAssistant = loose({
  type: z.literal('assistant'),
  session_id: z.string().optional(),
  message: loose({
    id: z.string().optional(),
    model: z.string().optional(),
    content: z.array(CcContentBlock).default([]),
    usage: CcUsage.optional(),
  }),
})

export const CcUser = loose({
  type: z.literal('user'),
  session_id: z.string().optional(),
  message: loose({ content: z.array(CcContentBlock).default([]) }),
})

export const CcResult = loose({
  type: z.literal('result'),
  subtype: z.string().optional(),
  is_error: z.boolean().default(false),
  session_id: z.string().optional(),
  num_turns: z.number().optional(),
  stop_reason: z.string().nullish(),
  total_cost_usd: z.number().optional(),
  usage: CcUsage.optional(),
})

/**
 * Seat window state. This is the harness reporting the provider's own numbers, so
 * `resetsAt` and `status` are authoritative rather than estimated — the one place
 * we get a real answer instead of a derived one.
 */
export const CcRateLimitEvent = loose({
  type: z.literal('rate_limit_event'),
  rate_limit_info: loose({
    status: z.string(),
    /** Unix seconds. */
    resetsAt: z.number(),
    rateLimitType: z.string(),
    isUsingOverage: z.boolean().default(false),
  }),
})

/** Only present with `--include-partial-messages`. Carries the token deltas. */
export const CcStreamEvent = loose({
  type: z.literal('stream_event'),
  event: loose({ type: z.string() }),
})

export const CcMessage = z.union([
  CcSystemInit,
  CcAssistant,
  CcUser,
  CcResult,
  CcRateLimitEvent,
  CcStreamEvent,
  loose({ type: z.string() }),
])
export type CcMessage = z.infer<typeof CcMessage>

/**
 * Stream-event subtypes we knowingly ignore. Listed explicitly so that a genuinely
 * new subtype shows up as drift rather than blending in with these.
 */
export const IGNORED_STREAM_EVENTS = new Set([
  'message_start',
  'message_delta',
  'message_stop',
  'content_block_stop',
  'ping',
])

/** Top-level types we knowingly ignore. */
export const IGNORED_TYPES = new Set(['system'])

/** Tools whose success means a file on disk changed. */
export const WRITE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit'])
