import { z } from 'zod'

/**
 * Raw opencode events.
 *
 * PROVENANCE — read before trusting this file. These shapes come from opencode
 * 1.18.16's own OpenAPI 3.1 document, fetched from `GET /doc` on `opencode serve`
 * (472 schemas, no credentials required):
 *
 *   opencode serve --port <p> &
 *   curl -s http://127.0.0.1:<p>/doc
 *
 * That makes the shapes authoritative for the server's event stream. What is NOT
 * yet verified at runtime is whether `opencode run --format json` emits exactly
 * these objects, because this machine has no provider credentials configured
 * (`opencode providers list` reports 0). Record a fixture and re-run the contract
 * test once a provider is authenticated — the drift reporting below is what will
 * tell you if anything differs.
 *
 * Every event has the same envelope: `{ id, type, properties }`, where `type` is a
 * dotted string and the payload lives under `properties`.
 */

const loose = <T extends z.ZodRawShape>(shape: T) => z.object(shape).passthrough()

export const OcEnvelope = loose({
  id: z.string().optional(),
  type: z.string(),
  properties: z.record(z.unknown()).default({}),
})
export type OcEnvelope = z.infer<typeof OcEnvelope>

/** `tokens` on `session.next.step.ended`. Note the nested cache object. */
export const OcTokens = loose({
  input: z.number().default(0),
  output: z.number().default(0),
  reasoning: z.number().default(0),
  cache: loose({ read: z.number().default(0), write: z.number().default(0) }).default({}),
})

export const OC_EVENT = {
  sessionCreated: 'session.created',
  sessionIdle: 'session.idle',
  sessionError: 'session.error',
  textDelta: 'session.next.text.delta',
  textStarted: 'session.next.text.started',
  textEnded: 'session.next.text.ended',
  reasoningStarted: 'session.next.reasoning.started',
  toolCalled: 'session.next.tool.called',
  toolSuccess: 'session.next.tool.success',
  toolFailed: 'session.next.tool.failed',
  stepStarted: 'session.next.step.started',
  stepEnded: 'session.next.step.ended',
  stepFailed: 'session.next.step.failed',
  fileEdited: 'file.edited',
} as const

/**
 * Events the spec defines that we knowingly ignore. Listed explicitly so a
 * genuinely new event type is reported as drift rather than blending in.
 *
 * opencode's stream is far chattier than the other two — it drives a TUI, so it
 * carries permission prompts, LSP state, PTY lifecycle and installer notices that
 * mean nothing to a headless run.
 */
export const IGNORED_PREFIXES = [
  'tui.',
  'lsp.',
  'pty.',
  'installation.',
  'server.',
  'workspace.',
  'worktree.',
  'vcs.',
  'todo.',
  'reference.',
  'project.',
  'catalog.',
  'plugin.',
  'integration.',
  'models-dev.',
  'mcp.',
  'file.watcher.',
] as const

export const IGNORED_TYPES = new Set<string>([
  'session.updated',
  'session.status',
  'session.diff',
  'session.deleted',
  'session.compacted',
  'session.next.text.started',
  'session.next.text.ended.delta',
  'session.next.reasoning.delta',
  'session.next.reasoning.ended',
  'session.next.tool.input.started',
  'session.next.tool.input.delta',
  'session.next.tool.input.ended',
  'session.next.tool.progress',
  'session.next.step.started',
  'session.next.context.updated',
  'session.next.prompted',
  'session.next.prompt.admitted',
  'session.next.model.switched',
  'session.next.agent.switched',
  'session.next.synthetic',
  'session.next.moved',
  'session.next.retried',
  'session.next.compaction.started',
  'session.next.compaction.ended',
  'session.next.compaction.delta',
  'session.next.revert.staged',
  'session.next.revert.committed',
  'session.next.revert.cleared',
  'session.next.shell.started',
  'session.next.shell.ended',
  'message.updated',
  'message.removed',
  'message.part.updated',
  'message.part.delta',
  'message.part.removed',
  'command.executed',
  'permission.asked',
  'permission.replied',
  'permission.v2.asked',
  'permission.v2.replied',
  'question.asked',
  'question.replied',
  'question.rejected',
  'question.v2.asked',
  'question.v2.replied',
  'question.v2.rejected',
  'global.disposed',
])

export function isIgnored(type: string): boolean {
  if (IGNORED_TYPES.has(type)) return true
  return IGNORED_PREFIXES.some((prefix) => type.startsWith(prefix))
}
