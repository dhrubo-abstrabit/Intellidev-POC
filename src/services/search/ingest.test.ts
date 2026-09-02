import { describe, expect, it } from "vitest";
import { buildChunkRows } from "./ingest";

const baseInput = {
  clientSpaceId: "cs-1",
  projectId: "proj-1",
  sourceKind: "normalized_event" as const,
  sourceId: "event-1",
  provider: "slack" as const,
  occurredAt: "2026-08-14T00:00:00Z",
};

describe("buildChunkRows", () => {
  it("returns no rows for empty/whitespace-only text", () => {
    expect(buildChunkRows({ ...baseInput, text: "" })).toEqual([]);
    expect(buildChunkRows({ ...baseInput, text: "   " })).toEqual([]);
  });

  it("assigns a dense, zero-based chunk_index across every row", () => {
    const longText = "This is one sentence about the project status. ".repeat(60);
    const rows = buildChunkRows({ ...baseInput, text: longText });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.chunk_index)).toEqual(rows.map((_, i) => i));
  });

  it("gives each chunk a distinct content_hash", () => {
    const longText = Array.from({ length: 30 }, (_, i) => `Update number ${i} about something different each time.`).join(" ");
    const rows = buildChunkRows({ ...baseInput, text: longText });
    expect(rows.length).toBeGreaterThan(1);
    const hashes = new Set(rows.map((r) => r.content_hash));
    expect(hashes.size).toBe(rows.length);
  });

  it("passes project_id, source_url and title through, including null project_id for space-level sources", () => {
    const rows = buildChunkRows({
      ...baseInput,
      projectId: null,
      title: "Q3 roadmap",
      sourceUrl: "https://example.com/doc/1",
      text: "A short excerpt.",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      project_id: null,
      title: "Q3 roadmap",
      source_url: "https://example.com/doc/1",
      client_space_id: "cs-1",
      source_kind: "normalized_event",
      source_id: "event-1",
    });
  });

  it("defaults title and source_url to null when omitted", () => {
    const rows = buildChunkRows({ ...baseInput, text: "A short excerpt." });
    expect(rows[0].title).toBeNull();
    expect(rows[0].source_url).toBeNull();
  });
});
