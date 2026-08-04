import { describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/db/uuid";

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("uuidv7", () => {
  it("produces a well-formed v7 UUID (version nibble 7, variant bits 10)", () => {
    const id = uuidv7();
    expect(id).toMatch(UUID_RE);
  });

  it("is monotonically increasing in string order across calls at different timestamps", async () => {
    const a = uuidv7();
    await new Promise((r) => setTimeout(r, 5));
    const b = uuidv7();
    expect(a < b).toBe(true);
  });

  it("does not collide across many rapid calls", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => uuidv7()));
    expect(ids.size).toBe(5000);
  });
});


