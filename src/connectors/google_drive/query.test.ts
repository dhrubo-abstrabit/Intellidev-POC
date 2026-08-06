import { describe, expect, it } from "vitest";
import { buildIncrementalQuery, buildFolderQuery, buildBackfillQuery, chunkParents, corporaParamsFor, escapeDriveQueryLiteral, MAX_PARENTS_IN_QUERY } from "./query";

describe("escapeDriveQueryLiteral", () => {
  it("escapes single quotes and backslashes", () => {
    expect(escapeDriveQueryLiteral("O'Brien")).toBe("O\\'Brien");
    expect(escapeDriveQueryLiteral("a\\b")).toBe("a\\\\b");
  });
});

describe("chunkParents", () => {
  it("chunks at the boundary sizes", () => {
    expect(chunkParents(Array.from({ length: 1 }, (_, i) => `id${i}`))).toHaveLength(1);
    expect(chunkParents(Array.from({ length: MAX_PARENTS_IN_QUERY }, (_, i) => `id${i}`))).toHaveLength(1);
    expect(chunkParents(Array.from({ length: MAX_PARENTS_IN_QUERY + 1 }, (_, i) => `id${i}`))).toHaveLength(2);
    expect(chunkParents(Array.from({ length: MAX_PARENTS_IN_QUERY * 2 + 1 }, (_, i) => `id${i}`))).toHaveLength(3);
  });

  it("respects a custom chunk size", () => {
    expect(chunkParents(["a", "b", "c"], 2)).toEqual([["a", "b"], ["c"]]);
  });
});

describe("corporaParamsFor", () => {
  it("never emits corpora=allDrives — orderBy is documented as ignored under it", () => {
    expect(corporaParamsFor(null).corpora).not.toBe("allDrives");
    expect(corporaParamsFor("drive-id").corpora).not.toBe("allDrives");
  });

  it("uses corpora=user with no driveId for My Drive", () => {
    expect(corporaParamsFor(null)).toEqual({ corpora: "user", supportsAllDrives: true });
  });

  it("uses corpora=drive with driveId and includeItemsFromAllDrives for a shared drive", () => {
    expect(corporaParamsFor("drive-123")).toEqual({
      corpora: "drive",
      driveId: "drive-123",
      includeItemsFromAllDrives: true,
      supportsAllDrives: true,
    });
  });
});

describe("buildIncrementalQuery", () => {
  it("uses an inclusive floor (>=) and excludes folders", () => {
    const q = buildIncrementalQuery({ floorIso: "2026-01-01T00:00:00.000Z", parentIds: null });
    expect(q).toContain("modifiedTime >= '2026-01-01T00:00:00.000Z'");
    expect(q).toContain("mimeType != 'application/vnd.google-apps.folder'");
    expect(q).not.toContain("in parents");
  });

  it("adds an OR'd parent clause when parentIds is a non-empty array", () => {
    const q = buildIncrementalQuery({ floorIso: "2026-01-01T00:00:00.000Z", parentIds: ["a", "b"] });
    expect(q).toContain("('a' in parents or 'b' in parents)");
  });

  it("omits the parent clause entirely for null parentIds (shared-drive-root / broad tier)", () => {
    const q = buildIncrementalQuery({ floorIso: "2026-01-01T00:00:00.000Z", parentIds: null });
    expect(q).not.toContain("in parents");
  });

  it("never adds trashed = false — a trashing that bumps modifiedTime must still surface", () => {
    const q = buildIncrementalQuery({ floorIso: "2026-01-01T00:00:00.000Z", parentIds: null });
    expect(q).not.toContain("trashed = false");
  });

  it("escapes a quote in the floor timestamp defensively", () => {
    const q = buildIncrementalQuery({ floorIso: "2026-01-01'T00:00:00", parentIds: null });
    expect(q).toContain("2026-01-01\\'T00:00:00");
  });
});

describe("buildFolderQuery", () => {
  it("filters to folders only, not trashed, under the given parents", () => {
    const q = buildFolderQuery(["a", "b"]);
    expect(q).toContain("mimeType = 'application/vnd.google-apps.folder'");
    expect(q).toContain("trashed = false");
    expect(q).toContain("('a' in parents or 'b' in parents)");
  });
});

describe("buildBackfillQuery", () => {
  it("always includes a parent clause (unlike the incremental query's null case)", () => {
    const q = buildBackfillQuery({ floorIso: "2026-01-01T00:00:00.000Z", parentIds: ["a"] });
    expect(q).toContain("'a' in parents");
    expect(q).toContain("modifiedTime >= '2026-01-01T00:00:00.000Z'");
  });
});
