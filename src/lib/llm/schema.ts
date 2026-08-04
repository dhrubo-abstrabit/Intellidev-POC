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
