import { describe, expect, it } from "vitest";
import { ActionItemGenerationSchema, ActionItemConsolidationSchema } from "./schema";

describe("ActionItemGenerationSchema", () => {
  it("accepts a well-formed generation with the optional fields omitted", () => {
    const result = ActionItemGenerationSchema.safeParse({
      items: [{ kind: "action", title: "Fix flaky checkout test", priority: "medium", confidence: 0.8 }],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.items[0].sourceEventIds).toEqual([]);
    }
  });

  it("accepts an empty items array (the model choosing to surface nothing)", () => {
    expect(ActionItemGenerationSchema.safeParse({ items: [] }).success).toBe(true);
  });

  it("rejects confidence outside [0, 1]", () => {
    const result = ActionItemGenerationSchema.safeParse({
      items: [{ kind: "action", title: "x", priority: "medium", confidence: 1.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown kind or priority (the model hallucinating a category)", () => {
    const result = ActionItemGenerationSchema.safeParse({
      items: [{ kind: "todo", title: "x", priority: "medium", confidence: 0.5 }],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a missing title", () => {
    const result = ActionItemGenerationSchema.safeParse({
      items: [{ kind: "action", priority: "medium", confidence: 0.5 }],
    });
    expect(result.success).toBe(false);
  });
});

describe("ActionItemConsolidationSchema", () => {
  it("accepts a genuinely-new group with matchesOpenItemId null", () => {
    const result = ActionItemConsolidationSchema.safeParse({
      groups: [
        {
          matchesOpenItemId: null,
          draftKeys: ["d1"],
          canonicalTitle: "Fix flaky checkout test",
          kind: "blocker",
          priority: "high",
          confidence: 0.8,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a group matching an existing open item by id", () => {
    const result = ActionItemConsolidationSchema.safeParse({
      groups: [
        {
          matchesOpenItemId: "3fa85f64-5717-4562-b3fc-2c963f66afa6",
          draftKeys: ["d1", "d2"],
          canonicalTitle: "ignored when matchesOpenItemId is set",
          kind: "blocker",
          priority: "high",
          confidence: 0.9,
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a non-uuid matchesOpenItemId (the model hallucinating an id)", () => {
    const result = ActionItemConsolidationSchema.safeParse({
      groups: [
        {
          matchesOpenItemId: "not-a-uuid",
          draftKeys: ["d1"],
          canonicalTitle: "x",
          kind: "action",
          priority: "low",
          confidence: 0.5,
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty draftKeys array", () => {
    const result = ActionItemConsolidationSchema.safeParse({
      groups: [{ matchesOpenItemId: null, draftKeys: [], canonicalTitle: "x", kind: "action", priority: "low", confidence: 0.5 }],
    });
    expect(result.success).toBe(false);
  });
});
