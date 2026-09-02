import { z } from "zod";
import {
  ActionItemDraftSchema,
  ActionItemGenerationSchema,
  ActionItemConsolidationSchema,
  type ActionItemGeneration,
  type ActionItemConsolidation,
} from "./schema";

/**
 * Strict-mode mirrors of schema.ts's Zod schemas, for OpenAI's structured
 * outputs (zodTextFormat -> a JSON Schema with strict:true). OpenAI's
 * strict mode does NOT support optional properties the way schema.ts uses
 * them (Zod .optional() either gets force-marked required by the SDK's
 * strict-schema conversion, or — on the zod v4 JSON-schema path — emits a
 * type union like ["string","number","boolean","null"] that would let the
 * model return a NUMBER for a field like ownerHint; see
 * github.com/openai/openai-node#1469). So every field here is PRESENT and
 * REQUIRED; "absent" is expressed as `null` and mapped back to `undefined`
 * by the adapters below.
 *
 * Deliberately carries NO .min()/.max()/.uuid() — keyword support under
 * strict mode is undocumented, so bounds are enforced locally, after
 * parsing, instead of trusted from the wire schema. schema.ts's real
 * schemas remain the single source of truth for validity: every adapter
 * below normalizes, then parses through them, never returning a value that
 * only the wire schema validated.
 */
const OpenAIDraftWireSchema = z.object({
  kind: z.enum(["action", "risk", "blocker", "update", "follow_up"]),
  title: z.string(),
  description: z.string(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  confidence: z.number(),
  ownerHint: z.string().nullable(),
  sourceEventIds: z.array(z.string()),
  relatedContextRefs: z.array(z.string()),
});

export const OpenAIGenerationWireSchema = z.object({
  items: z.array(OpenAIDraftWireSchema),
});

export const OpenAIConsolidationWireSchema = z.object({
  groups: z.array(
    z.object({
      matchesOpenItemId: z.string().nullable(),
      draftKeys: z.array(z.string()),
      canonicalTitle: z.string(),
      kind: z.enum(["action", "risk", "blocker", "update", "follow_up"]),
      mergedDescription: z.string().nullable(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      confidence: z.number(),
      ownerHint: z.string().nullable(),
    }),
  ),
});

export type OpenAIGenerationWire = z.infer<typeof OpenAIGenerationWireSchema>;
export type OpenAIConsolidationWire = z.infer<typeof OpenAIConsolidationWireSchema>;

/** Delegates to zod's own uuid validator rather than a hand-rolled regex —
 * schema.ts's matchesOpenItemId field is z.string().uuid(), and a looser
 * local check could accept a value that then fails at the final .parse()
 * below instead of being cleanly coerced to null here, defeating the
 * normalize-then-parse contract this whole file exists for. */
function isValidUuid(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max) : s;
}

/** Normalizes one wire-format draft (null-for-absent, unbounded numbers and
 * lengths) into schema.ts's real, bounded shape, warning on every
 * correction rather than silently masking it. Never throws for an
 * out-of-bounds value — a bad float or an overlong string costs one
 * clamped field, not the whole day's extraction; genuinely malformed
 * shapes still fail at the final ActionItemDraftSchema.parse() below. */
function adaptDraft(wire: OpenAIGenerationWire["items"][number]): ReturnType<typeof ActionItemDraftSchema.parse> {
  if (wire.confidence < 0 || wire.confidence > 1) {
    console.warn(`[llm] openai: clamping out-of-range confidence ${wire.confidence} for draft "${wire.title}"`);
  }
  if (wire.title.length > 300) {
    console.warn(`[llm] openai: truncating over-long title (${wire.title.length} chars) for draft`);
  }
  if (wire.description.length > 2000) {
    console.warn(`[llm] openai: truncating over-long description (${wire.description.length} chars) for draft "${wire.title}"`);
  }

  const normalized = {
    kind: wire.kind,
    title: truncate(wire.title, 300),
    description: truncate(wire.description, 2000),
    priority: wire.priority,
    confidence: clamp01(wire.confidence),
    ownerHint: wire.ownerHint === null ? undefined : truncate(wire.ownerHint, 200),
    sourceEventIds: wire.sourceEventIds,
    relatedContextRefs: wire.relatedContextRefs,
  };
  return ActionItemDraftSchema.parse(normalized);
}

export function toActionItemGeneration(wire: OpenAIGenerationWire): ActionItemGeneration {
  return ActionItemGenerationSchema.parse({ items: wire.items.map(adaptDraft) });
}

export function toActionItemConsolidation(wire: OpenAIConsolidationWire): ActionItemConsolidation {
  const groups = wire.groups.map((group) => {
    const validId = group.matchesOpenItemId !== null && isValidUuid(group.matchesOpenItemId);
    if (group.matchesOpenItemId !== null && !validId) {
      console.warn(`[llm] openai: coercing non-UUID matchesOpenItemId "${group.matchesOpenItemId}" to null for group "${group.canonicalTitle}"`);
    }
    if (group.confidence < 0 || group.confidence > 1) {
      console.warn(`[llm] openai: clamping out-of-range confidence ${group.confidence} for consolidation group "${group.canonicalTitle}"`);
    }
    return {
      matchesOpenItemId: validId ? group.matchesOpenItemId : null,
      draftKeys: group.draftKeys,
      canonicalTitle: truncate(group.canonicalTitle, 300),
      kind: group.kind,
      mergedDescription: group.mergedDescription === null ? undefined : truncate(group.mergedDescription, 2000),
      priority: group.priority,
      confidence: clamp01(group.confidence),
      ownerHint: group.ownerHint === null ? undefined : truncate(group.ownerHint, 200),
    };
  });
  return ActionItemConsolidationSchema.parse({ groups });
}
