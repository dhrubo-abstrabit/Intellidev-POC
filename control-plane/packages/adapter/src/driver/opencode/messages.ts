import { z } from 'zod'

/**
 * Raw `opencode run --format json` output.
 *
 * PROVENANCE — two sources, and the difference matters:
 *
 *  1. The **envelope and the four common part types** are from a real capture of
 *     opencode 1.18.16 (`test/fixtures/opencode/run-*.jsonl`).
 *  2. The **complete part inventory** below comes from opencode's own OpenAPI
 *     document (`opencode serve` → `GET /doc`), whose `Part` union lists twelve
 *     variants. Only four appear in the fixtures; the rest are mapped from the
 *     schema so a real one is handled rather than reported as drift.
 *
 * A CORRECTION WORTH REMEMBERING: the server's SSE stream and the `run --format
 * json` stream are **different formats**. The server emits `session.next.text.delta`
 * style events; `run` emits message *parts* wrapped in `{type, part}`. An earlier
 * version of this driver was written from the server schema and was simply wrong.
 * Capture beats inference.
 *
 * The format is opencode's own, so it does not vary by model. What does vary:
 * `cost` is 0 on free models, `reasoning` token counts and `reasoning` parts appear
 * only on reasoning models, and `patch` / `subtask` / `compaction` / `retry` parts
 * depend on what happens during the run rather than which model runs it.
 */

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough()

export const OcEnvelope = loose({
  /** snake_case echo of the part kind, e.g. `tool_use`. Informational only. */
  type: z.string(),
  timestamp: z.number().optional(),
  sessionID: z.string().optional(),
  part: loose({ type: z.string() }).optional(),
})
export type OcEnvelope = z.infer<typeof OcEnvelope>

/** `tokens` on a `step-finish` part. Note `total` is a sum, not a separate bucket. */
export const OcTokens = loose({
  total: z.number().default(0),
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache: loose({ read: z.number().default(0), write: z.number().default(0) }).default({}),
})

/** Every part kind the spec's `Part` union defines. */
export const OC_PART = {
  text: 'text',
  reasoning: 'reasoning',
  tool: 'tool',
  stepStart: 'step-start',
  stepFinish: 'step-finish',
  patch: 'patch',
  file: 'file',
  snapshot: 'snapshot',
  agent: 'agent',
  subtask: 'subtask',
  retry: 'retry',
  compaction: 'compaction',
} as const

/**
 * Part kinds that carry nothing the canonical log needs. Listed explicitly so a
 * thirteenth part kind shows up as drift instead of being silently dropped.
 */
export const IGNORED_PARTS = new Set<string>([
  OC_PART.stepStart,
  OC_PART.snapshot,
  OC_PART.file,
  OC_PART.agent,
  OC_PART.subtask,
  OC_PART.compaction,
])

/** `state.status` on a tool part. */
export const OC_TOOL_STATUS = ['pending', 'running', 'completed', 'error'] as const

/**
 * opencode has no file-change event: a write shows up as a tool call. These are the
 * tool names whose success means a file on disk moved.
 */
export const WRITE_TOOLS = new Set(['write', 'edit', 'multiedit', 'patch'])

/** `reason` on step-finish. `stop` is the only one that ends the turn. */
export const STEP_FINISH_STOP = 'stop'
