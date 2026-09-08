import { describe, expect, it } from "vitest";
import { buildTaskQueryText, filterAndMapCandidates } from "./find-related";
import type { RetrievedChunk } from "@/services/search/retrieve";

function chunk(overrides: Partial<RetrievedChunk> & Pick<RetrievedChunk, "chunkId" | "citableEventId">): RetrievedChunk {
  return {
    sourceKind: "normalized_event",
    sourceId: "src-1",
    provider: "slack",
    title: null,
    content: "some retrieved content",
    occurredAt: "2026-08-14T00:00:00Z",
    sourceUrl: null,
    pageNumber: null,
    distance: 0.2,
    ...overrides,
  };
}

describe("buildTaskQueryText", () => {
  it("concatenates title and description", () => {
    expect(buildTaskQueryText({ title: "Fix flaky test", description: "It fails sometimes." })).toBe("Fix flaky test\nIt fails sometimes.");
  });

  it("returns just the title when there's no description", () => {
    expect(buildTaskQueryText({ title: "Fix flaky test", description: null })).toBe("Fix flaky test");
  });

  it("returns just the title when the description is an empty string", () => {
    expect(buildTaskQueryText({ title: "Fix flaky test", description: "" })).toBe("Fix flaky test");
  });
});

describe("filterAndMapCandidates", () => {
  it("drops a chunk with no citableEventId (a context_document chunk that can never be linked)", () => {
    const result = filterAndMapCandidates([chunk({ chunkId: "c1", citableEventId: null })], []);
    expect(result).toHaveLength(0);
  });

  it("drops a chunk whose citableEventId is already linked to this task", () => {
    const result = filterAndMapCandidates([chunk({ chunkId: "c1", citableEventId: "event-1" })], ["event-1"]);
    expect(result).toHaveLength(0);
  });

  it("catches an event_attachment chunk already linked, even though its own sourceId (the attachment id) differs from the excluded event id", () => {
    // This is the case retrieveContextChunks' own excludeSourceIds can't
    // catch on its own — sourceId is the attachment's id, not the event's,
    // so only a post-filter on citableEventId closes the gap.
    const result = filterAndMapCandidates(
      [chunk({ chunkId: "c1", sourceKind: "event_attachment", sourceId: "attachment-1", citableEventId: "event-1" })],
      ["event-1"],
    );
    expect(result).toHaveLength(0);
  });

  it("keeps a citable chunk that isn't already linked, and maps its fields", () => {
    const result = filterAndMapCandidates(
      [chunk({ chunkId: "c1", citableEventId: "event-1", title: "Slack thread", content: "some content", distance: 0.3, pageNumber: 2 })],
      ["event-2"],
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      chunkId: "c1",
      normalizedEventId: "event-1",
      title: "Slack thread",
      snippet: "some content",
      distance: 0.3,
      pageNumber: 2,
    });
  });

  it("keeps only the surviving chunks when candidates are mixed", () => {
    const result = filterAndMapCandidates(
      [
        chunk({ chunkId: "c1", citableEventId: null }),
        chunk({ chunkId: "c2", citableEventId: "event-1" }),
        chunk({ chunkId: "c3", citableEventId: "event-2" }),
      ],
      ["event-1"],
    );
    expect(result.map((c) => c.chunkId)).toEqual(["c3"]);
  });
});
