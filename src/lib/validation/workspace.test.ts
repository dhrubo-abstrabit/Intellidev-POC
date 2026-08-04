import { describe, expect, it } from "vitest";
import { slugify } from "@/lib/validation/workspace";

const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

describe("slugify", () => {
  it("lowercases and hyphenates a normal name", () => {
    expect(slugify("Acme Technologies")).toBe("acme-technologies");
  });

  it("strips accents rather than dropping the letter", () => {
    expect(slugify("Café Corp")).toBe("cafe-corp");
  });

  it("collapses repeated separators and trims leading/trailing hyphens", () => {
    expect(slugify("  --Acme!!  Corp--  ")).toBe("acme-corp");
  });

  it("always satisfies the DB slug constraint, even for pathological input", () => {
    const inputs = ["a", "", "!!!", "   ", "x".repeat(200), "日本語"];
    for (const input of inputs) {
      const slug = slugify(input);
      expect(slug).toMatch(SLUG_RE);
    }
  });

  it("produces a slug within the 50-char cap", () => {
    expect(slugify("a".repeat(200)).length).toBeLessThanOrEqual(50);
  });
});
