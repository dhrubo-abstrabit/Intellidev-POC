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
  it("returns no rows for empty/whitespace-only text", async () => {
    expect(await buildChunkRows({ ...baseInput, text: "" })).toEqual([]);
    expect(await buildChunkRows({ ...baseInput, text: "   " })).toEqual([]);
  });

  it("assigns a dense, zero-based chunk_index across every row", async () => {
    const longText = "This is one sentence about the project status. ".repeat(60);
    const rows = await buildChunkRows({ ...baseInput, text: longText });
    expect(rows.length).toBeGreaterThan(1);
    expect(rows.map((r) => r.chunk_index)).toEqual(rows.map((_, i) => i));
  });

  it("gives distinct content_hash values for distinct chunk content", async () => {
    // Not "every hash is distinct" — RecursiveCharacterTextSplitter's
    // overlap can legitimately repeat a run of text verbatim across two
    // chunks (e.g. a highly repetitive input), which would make that
    // stronger assertion flaky against the splitter's real behaviour rather
    // than against buildChunkRows/contentHash themselves. What must always
    // hold is hash injectivity over distinct content.
    const longText = Array.from({ length: 30 }, (_, i) => `Update number ${i} about something different each time.`).join(" ");
    const rows = await buildChunkRows({ ...baseInput, text: longText });
    expect(rows.length).toBeGreaterThan(1);
    const distinctContent = new Set(rows.map((r) => r.content));
    const distinctHashes = new Set(rows.map((r) => r.content_hash));
    expect(distinctHashes.size).toBe(distinctContent.size);
  });

  it("passes project_id, source_url and title through, including null project_id for space-level sources", async () => {
    const rows = await buildChunkRows({
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

  it("defaults title and source_url to null when omitted", async () => {
    const rows = await buildChunkRows({ ...baseInput, text: "A short excerpt." });
    expect(rows[0].title).toBeNull();
    expect(rows[0].source_url).toBeNull();
  });

  it("leaves page_number null for a plain (non-paginated) text input", async () => {
    const rows = await buildChunkRows({ ...baseInput, text: "A short excerpt." });
    expect(rows[0].page_number).toBeNull();
  });

  it("stamps page_number per row and keeps chunk_index dense across pages when pages is set", async () => {
    const sentence = "This is one sentence about the project status. ";
    const rows = await buildChunkRows({
      ...baseInput,
      text: "unused when pages is set",
      pages: [
        { pageNumber: 1, text: sentence.repeat(30) },
        { pageNumber: 2, text: sentence.repeat(30) },
      ],
    });
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.map((r) => r.chunk_index)).toEqual(rows.map((_, i) => i));

    const pageNumbers = rows.map((r) => r.page_number);
    expect(pageNumbers.every((p) => p === 1 || p === 2)).toBe(true);
    // Every page-1 row precedes every page-2 row — pages are chunked and
    // concatenated in order, never interleaved.
    expect(pageNumbers.lastIndexOf(1)).toBeLessThan(pageNumbers.indexOf(2));
  });
});
