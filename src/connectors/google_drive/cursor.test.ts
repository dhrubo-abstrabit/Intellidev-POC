import { describe, expect, it } from "vitest";
import {
  advanceFloor,
  buildFolderPath,
  diffFolderSet,
  emptyCursor,
  isFolderSetStale,
  parseCursor,
  pruneCursorSources,
} from "./cursor";

describe("parseCursor", () => {
  it("returns an empty cursor for null/undefined", () => {
    expect(parseCursor(null)).toEqual(emptyCursor());
    expect(parseCursor(undefined)).toEqual(emptyCursor());
  });

  it("returns an empty cursor for an unrecognized version", () => {
    expect(parseCursor({ provider: "google_drive", v: 2, sources: {} })).toEqual(emptyCursor());
  });

  it("returns an empty cursor for garbage jsonb rather than throwing", () => {
    expect(parseCursor("not an object")).toEqual(emptyCursor());
    expect(parseCursor(42)).toEqual(emptyCursor());
    expect(parseCursor({ provider: "google_drive", v: 1 })).toEqual(emptyCursor()); // missing `sources`
  });

  it("round-trips a well-formed cursor", () => {
    const cursor = { provider: "google_drive" as const, v: 1 as const, sources: { abc: {} as never } };
    expect(parseCursor(cursor)).toEqual(cursor);
  });
});

describe("pruneCursorSources", () => {
  it("drops entries for sources no longer configured", () => {
    const cursor = {
      provider: "google_drive" as const,
      v: 1 as const,
      sources: { a: {} as never, b: {} as never },
    };
    expect(pruneCursorSources(cursor, ["a"]).sources).toEqual({ a: {} });
  });
});

describe("advanceFloor", () => {
  it("does not advance when nothing was processed", () => {
    const result = advanceFloor({ previousFloor: "2026-01-01T00:00:00.000Z", processedFiles: [] });
    expect(result).toEqual({ floor: "2026-01-01T00:00:00.000Z", boundary: [] });
  });

  it("advances to the max modifiedTime among processed files", () => {
    const result = advanceFloor({
      previousFloor: "2026-01-01T00:00:00.000Z",
      processedFiles: [
        { id: "f1", version: "1", modifiedTime: "2026-01-02T00:00:00.000Z" },
        { id: "f2", version: "1", modifiedTime: "2026-01-03T00:00:00.000Z" },
      ],
    });
    expect(result.floor).toBe("2026-01-03T00:00:00.000Z");
  });

  it("the boundary set is exactly the files sitting at the new floor", () => {
    const result = advanceFloor({
      previousFloor: "2026-01-01T00:00:00.000Z",
      processedFiles: [
        { id: "f1", version: "1", modifiedTime: "2026-01-03T00:00:00.000Z" },
        { id: "f2", version: "2", modifiedTime: "2026-01-03T00:00:00.000Z" }, // ties the max
        { id: "f3", version: "1", modifiedTime: "2026-01-02T00:00:00.000Z" }, // earlier — not on the boundary
      ],
    });
    expect(new Set(result.boundary)).toEqual(new Set(["f1:1", "f2:2"]));
  });
});

describe("diffFolderSet", () => {
  it("reports added and removed folder ids", () => {
    const diff = diffFolderSet({ a: {}, b: {} }, { a: {}, c: {} });
    expect(diff.added).toEqual(["c"]);
    expect(diff.removed).toEqual(["b"]);
  });
});

describe("buildFolderPath", () => {
  const folders = {
    root: { n: "Project", p: null },
    mid: { n: "Docs", p: "root" },
    leaf: { n: "Drafts", p: "mid" },
  };

  it("builds a path from root to the given folder", () => {
    expect(buildFolderPath(folders, "leaf")).toBe("Project/Docs/Drafts");
  });

  it("returns undefined for an undefined folderId", () => {
    expect(buildFolderPath(folders, undefined)).toBeUndefined();
  });

  it("returns undefined (not a throw) when the map is missing an ancestor", () => {
    expect(buildFolderPath({ leaf: { n: "Drafts", p: "missing-parent" } }, "leaf")).toBe("Drafts");
  });

  it("is cycle-guarded — a corrupted map with a parent cycle returns undefined instead of looping forever", () => {
    const cyclic = { a: { n: "A", p: "b" }, b: { n: "B", p: "a" } };
    expect(buildFolderPath(cyclic, "a")).toBeUndefined();
  });
});

describe("isFolderSetStale", () => {
  it("is stale when older than the ttl", () => {
    const now = Date.parse("2026-01-01T06:00:00.000Z");
    expect(isFolderSetStale("2026-01-01T00:00:00.000Z", now, 5 * 60 * 60 * 1000)).toBe(true);
  });

  it("is not stale within the ttl", () => {
    const now = Date.parse("2026-01-01T02:00:00.000Z");
    expect(isFolderSetStale("2026-01-01T00:00:00.000Z", now, 5 * 60 * 60 * 1000)).toBe(false);
  });

  it("treats an unparsable timestamp as stale", () => {
    expect(isFolderSetStale("not-a-date", Date.now())).toBe(true);
  });
});
