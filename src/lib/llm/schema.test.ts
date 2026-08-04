import { describe, expect, it } from "vitest";
import { ActionItemGenerationSchema } from "./schema";

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
