import { z } from "zod";

export const ActionItemDraftSchema = z.object({
  kind: z.enum(["action", "risk", "blocker", "update", "follow_up"]),
  /** Reused verbatim as the merge key: action_items.dedupe_hash is a hash of
   * this title, normalized (lowercase/trim/collapsed whitespace) — see the
   * system prompt's instruction to reuse an open item's exact title when a
   * new event is about the same issue, so re-running the generator refines
   * that row instead of duplicating it. There is no separate dedupe key. */
  title: z.string().min(1).max(300),
  description: z.string().max(2000).optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  confidence: z.number().min(0).max(1),
  ownerHint: z.string().max(200).optional(),
  /** Must be a subset of the ids we handed the model in this run's NEW
   * EVENTS block — validated (not just trusted) before insert. */
  sourceEventIds: z.array(z.string()).default([]),
});
export type ActionItemDraft = z.infer<typeof ActionItemDraftSchema>;

export const ActionItemGenerationSchema = z.object({
  items: z.array(ActionItemDraftSchema),
});
export type ActionItemGeneration = z.infer<typeof ActionItemGenerationSchema>;

/** Reconciles a run's draft items against each other and against currently
 * open items — semantic dedup, not the exact-title-hash matching the
 * persist loop still does as a safety net afterward. */
export const ActionItemConsolidationSchema = z.object({
  groups: z.array(
    z.object({
      /** An existing OPEN ITEM's real id if this group is the same
       * underlying issue, even if worded differently — null if genuinely
       * new. Never paraphrase an id; only echo one you were given. */
      matchesOpenItemId: z.string().uuid().nullable(),
      /** Which of this run's draft keys (d1, d2, ...) collapse into this
       * group. Every draft key must appear in exactly one group. */
      draftKeys: z.array(z.string()).min(1),
      /** Ignored by the caller when matchesOpenItemId is set — the stored
       * open item's own title is used instead, so dedupe_hash stays
       * correct regardless of what's written here. Only load-bearing for a
       * genuinely new group. */
      canonicalTitle: z.string().min(1).max(300),
      kind: z.enum(["action", "risk", "blocker", "update", "follow_up"]),
      mergedDescription: z.string().max(2000).optional(),
      priority: z.enum(["low", "medium", "high", "urgent"]),
      confidence: z.number().min(0).max(1),
      ownerHint: z.string().max(200).optional(),
    }),
  ),
});
export type ActionItemConsolidation = z.infer<typeof ActionItemConsolidationSchema>;
