import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  OpenAIGenerationWireSchema,
  OpenAIConsolidationWireSchema,
  toActionItemGeneration,
  toActionItemConsolidation,
} from "./openai-schema";

/** Recursively asserts every object node in a JSON Schema is genuinely
 * strict-mode-conformant: every property is required, additionalProperties
 * is false, and no `default` keyword appears anywhere (OpenAI's strict
 * structured outputs supports none of "optional properties",
 * "additionalProperties: true", or Zod's .default() reliably — see
 * openai-schema.ts's own doc comment). This is the guard against
 * accidentally reusing an .optional()/.default() field from schema.ts,
 * which would otherwise only surface as an opaque OpenAI 400 at runtime. */
function assertStrictConformant(node: unknown, path = "$"): void {
  if (node === null || typeof node !== "object") return;
  const obj = node as Record<string, unknown>;

  expect(obj, `${path} declares a 'default'`).not.toHaveProperty("default");

  if (obj.type === "object" || obj.properties) {
    const properties = (obj.properties ?? {}) as Record<string, unknown>;
    const propertyNames = Object.keys(properties);
    expect(obj.additionalProperties, `${path}.additionalProperties must be false`).toBe(false);
    expect(obj.required, `${path}.required must list every property`).toEqual(propertyNames);
    for (const [key, value] of Object.entries(properties)) {
      assertStrictConformant(value, `${path}.properties.${key}`);
    }
  }
  if (obj.type === "array" && obj.items) {
    assertStrictConformant(obj.items, `${path}.items`);
  }
}

describe("wire schema strict-mode conformance", () => {
  it("OpenAIGenerationWireSchema is fully strict-conformant", () => {
    assertStrictConformant(z.toJSONSchema(OpenAIGenerationWireSchema));
  });

  it("OpenAIConsolidationWireSchema is fully strict-conformant", () => {
    assertStrictConformant(z.toJSONSchema(OpenAIConsolidationWireSchema));
  });
});

const baseDraft = {
  kind: "action" as const,
  title: "Fix flaky test",
  description: "The checkout test fails intermittently.",
  priority: "medium" as const,
  confidence: 0.8,
  ownerHint: null,
  sourceEventIds: ["e1"],
  relatedContextRefs: ["R1"],
};

describe("toActionItemGeneration", () => {
  it("maps null ownerHint to undefined", () => {
    const result = toActionItemGeneration({ items: [baseDraft] });
    expect(result.items[0].ownerHint).toBeUndefined();
  });

  it("passes a non-null ownerHint through", () => {
    const result = toActionItemGeneration({ items: [{ ...baseDraft, ownerHint: "alice" }] });
    expect(result.items[0].ownerHint).toBe("alice");
  });

  it("clamps an out-of-range confidence into [0, 1]", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = toActionItemGeneration({ items: [{ ...baseDraft, confidence: 1.4 }] });
    expect(result.items[0].confidence).toBe(1);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it("truncates an over-long title to 300 chars", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const longTitle = "x".repeat(400);
    const result = toActionItemGeneration({ items: [{ ...baseDraft, title: longTitle }] });
    expect(result.items[0].title.length).toBe(300);
    warnSpy.mockRestore();
  });

  it("round-trips sourceEventIds and relatedContextRefs unchanged", () => {
    const result = toActionItemGeneration({ items: [baseDraft] });
    expect(result.items[0].sourceEventIds).toEqual(["e1"]);
    expect(result.items[0].relatedContextRefs).toEqual(["R1"]);
  });

  it("output passes ActionItemGenerationSchema (implicitly, since toActionItemGeneration parses through it)", () => {
    expect(() => toActionItemGeneration({ items: [baseDraft] })).not.toThrow();
  });
});

const baseGroup = {
  matchesOpenItemId: null,
  draftKeys: ["d1"],
  canonicalTitle: "Fix flaky test",
  kind: "action" as const,
  mergedDescription: null,
  priority: "medium" as const,
  confidence: 0.7,
  ownerHint: null,
};

describe("toActionItemConsolidation", () => {
  it("maps null mergedDescription/ownerHint to undefined", () => {
    const result = toActionItemConsolidation({ groups: [baseGroup] });
    expect(result.groups[0].mergedDescription).toBeUndefined();
    expect(result.groups[0].ownerHint).toBeUndefined();
  });

  it("keeps a valid UUID matchesOpenItemId", () => {
    const uuid = "550e8400-e29b-41d4-a716-446655440000";
    const result = toActionItemConsolidation({ groups: [{ ...baseGroup, matchesOpenItemId: uuid }] });
    expect(result.groups[0].matchesOpenItemId).toBe(uuid);
  });

  it("coerces a non-UUID matchesOpenItemId to null", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = toActionItemConsolidation({ groups: [{ ...baseGroup, matchesOpenItemId: "not-a-uuid" }] });
    expect(result.groups[0].matchesOpenItemId).toBeNull();
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});
