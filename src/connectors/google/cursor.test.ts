import { describe, expect, it } from "vitest";
import { emptyGoogleCursor, parseGoogleCursor, rotatePriority, type GoogleCursor } from "./cursor";

describe("parseGoogleCursor", () => {
  it("returns an empty cursor for null/undefined", () => {
    expect(parseGoogleCursor(null)).toEqual(emptyGoogleCursor());
    expect(parseGoogleCursor(undefined)).toEqual(emptyGoogleCursor());
  });

  it("returns an empty cursor for garbage jsonb rather than throwing", () => {
    expect(parseGoogleCursor("not an object")).toEqual(emptyGoogleCursor());
    expect(parseGoogleCursor(42)).toEqual(emptyGoogleCursor());
    expect(parseGoogleCursor([])).toEqual(emptyGoogleCursor());
  });

  it("returns an empty cursor for an unrecognized version or provider", () => {
    expect(parseGoogleCursor({ provider: "google", v: 2, gmail: null })).toEqual(emptyGoogleCursor());
    // A PRE-MERGE cursor left on a legacy row degrades to "start over"
    // rather than being half-interpreted as a google one.
    expect(parseGoogleCursor({ provider: "gmail", v: 1, lastInternalDateMs: 5 })).toEqual(emptyGoogleCursor());
    expect(parseGoogleCursor({ provider: "google_drive", v: 1, sources: {} })).toEqual(emptyGoogleCursor());
  });

  it("passes well-formed sub-cursors through verbatim", () => {
    const cursor = {
      provider: "google" as const,
      v: 1 as const,
      gmail: { provider: "gmail", v: 1, lastInternalDateMs: 1700000000000 },
      drive: { provider: "google_drive", v: 1, sources: {} },
      chat: { provider: "google_chat", v: 1, spaceCursors: { "spaces/A": "2026-01-01T00:00:00Z" } },
      lastPriorityService: "drive" as const,
    };
    expect(parseGoogleCursor(cursor)).toEqual(cursor);
  });

  it("nulls out a sub-cursor slot that isn't an object", () => {
    const parsed = parseGoogleCursor({ provider: "google", v: 1, gmail: "junk", drive: [], chat: 7 });
    expect(parsed).toEqual(emptyGoogleCursor());
  });

  it("drops an unrecognized lastPriorityService instead of trusting it", () => {
    const parsed = parseGoogleCursor({ provider: "google", v: 1, gmail: null, lastPriorityService: "calendar" });
    expect(parsed.lastPriorityService).toBeUndefined();
  });
});

describe("rotatePriority", () => {
  const enabled = ["gmail", "drive", "chat"] as const;

  it("returns the list unchanged when there is no previous priority", () => {
    expect(rotatePriority(enabled, undefined)).toEqual(["gmail", "drive", "chat"]);
  });

  it("moves whichever service ran last to the back, keeping the rest in order", () => {
    expect(rotatePriority(enabled, "gmail")).toEqual(["drive", "chat", "gmail"]);
    expect(rotatePriority(enabled, "drive")).toEqual(["chat", "gmail", "drive"]);
    // Already last — a run that got all the way through changes nothing,
    // which is correct: nothing was starved, so nothing needs re-ordering.
    expect(rotatePriority(enabled, "chat")).toEqual(["gmail", "drive", "chat"]);
  });

  it("returns the list unchanged when the last service is no longer enabled", () => {
    expect(rotatePriority(["gmail", "chat"] as const, "drive")).toEqual(["gmail", "chat"]);
  });

  it("does not mutate its input", () => {
    const input = [...enabled];
    rotatePriority(input, "gmail");
    expect(input).toEqual(["gmail", "drive", "chat"]);
  });

  it("gives every service a turn at the front when runs keep getting truncated", () => {
    // Worst case: each run's budget only ever covers ONE service, so the
    // service it reached is what gets rotated to the back.
    let order = rotatePriority(enabled, undefined);
    const firsts: string[] = [order[0]];
    for (let run = 0; run < 2; run++) {
      order = rotatePriority(enabled, order[0]);
      firsts.push(order[0]);
    }
    expect(firsts).toEqual(["gmail", "drive", "chat"]);
  });
});

describe("emptyGoogleCursor", () => {
  it("has an empty slot per sub-service and no priority yet", () => {
    const cursor: GoogleCursor = emptyGoogleCursor();
    expect(cursor).toEqual({ provider: "google", v: 1, gmail: null, drive: null, chat: null });
  });
});
