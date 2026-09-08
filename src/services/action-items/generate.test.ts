import { describe, expect, it } from "vitest";
import { resolveConsolidationGroups } from "./generate";
import type { ActionItemDraft, ActionItemConsolidation } from "@/lib/llm/schema";
import type { OpenActionItemSummary } from "@/lib/llm/types";

type Group = ActionItemConsolidation["groups"][number];

function draft(overrides: Partial<ActionItemDraft> & Pick<ActionItemDraft, "title">): ActionItemDraft {
  return {
    kind: "action",
    description: "",
    priority: "medium",
    confidence: 0.8,
    sourceEventIds: [],
    ...overrides,
  };
}

function group(overrides: Partial<Group> & Pick<Group, "draftKeys" | "canonicalTitle">): Group {
  return {
    matchesOpenItemId: null,
    kind: "action",
    priority: "medium",
    confidence: 0.8,
    ...overrides,
  };
}

const OPEN_ITEM: OpenActionItemSummary = {
  id: "11111111-1111-1111-1111-111111111111",
  title: "Finalize embedding model selection",
  kind: "follow_up",
  priority: "medium",
};

describe("resolveConsolidationGroups", () => {
  it("treats a fabricated or unknown matchesOpenItemId as no match, falling back to canonicalTitle", () => {
    const draftByKey = new Map([["d1", draft({ title: "Finalize the embedding model" })]]);
    const openItemById = new Map([[OPEN_ITEM.id, OPEN_ITEM]]);

    const [resolved] = resolveConsolidationGroups(
      [group({ draftKeys: ["d1"], canonicalTitle: "Finalize the embedding model", matchesOpenItemId: "99999999-9999-9999-9999-999999999999" })],
      draftByKey,
      openItemById,
    );

    expect(resolved.matchesOpenItemId).toBeNull();
    expect(resolved.title).toBe("Finalize the embedding model");
  });

  it("uses the open item's STORED title on a valid match, never the model's canonicalTitle echo", () => {
    const draftByKey = new Map([["d1", draft({ title: "Finalize the embedding model" })]]);
    const openItemById = new Map([[OPEN_ITEM.id, OPEN_ITEM]]);

    const [resolved] = resolveConsolidationGroups(
      [group({ draftKeys: ["d1"], canonicalTitle: "This title should never be used", matchesOpenItemId: OPEN_ITEM.id })],
      draftByKey,
      openItemById,
    );

    expect(resolved.matchesOpenItemId).toBe(OPEN_ITEM.id);
    expect(resolved.title).toBe(OPEN_ITEM.title);
  });

  it("matches a single-draft group against an open item — the case the consolidation gate used to skip", () => {
    const draftByKey = new Map([["d1", draft({ title: "Can you finalize the embedding model?", sourceEventIds: ["ev-1"] })]]);
    const openItemById = new Map([[OPEN_ITEM.id, OPEN_ITEM]]);

    const resolved = resolveConsolidationGroups(
      [group({ draftKeys: ["d1"], canonicalTitle: "Finalize the embedding model", matchesOpenItemId: OPEN_ITEM.id })],
      draftByKey,
      openItemById,
    );

    expect(resolved).toHaveLength(1);
    expect(resolved[0].matchesOpenItemId).toBe(OPEN_ITEM.id);
    expect(resolved[0].title).toBe(OPEN_ITEM.title);
    expect(resolved[0].sourceEventIds).toEqual(["ev-1"]);
  });

  it("drops an unknown draft key from a group instead of throwing, and dedupes sourceEventIds across the group's drafts", () => {
    const draftByKey = new Map([
      ["d1", draft({ title: "Fix flaky checkout test", sourceEventIds: ["ev-1", "ev-2"] })],
      ["d2", draft({ title: "Checkout tests fail intermittently", sourceEventIds: ["ev-2", "ev-3"] })],
    ]);
    const openItemById = new Map<string, OpenActionItemSummary>();

    const [resolved] = resolveConsolidationGroups(
      [group({ draftKeys: ["d1", "d2", "d-unknown"], canonicalTitle: "Fix flaky checkout test" })],
      draftByKey,
      openItemById,
    );

    expect(resolved.matchesOpenItemId).toBeNull();
    expect(resolved.sourceEventIds.sort()).toEqual(["ev-1", "ev-2", "ev-3"]);
  });
});
