import { describe, expect, it, vi } from "vitest";
import {
  EXTRACTION_SYSTEM_PROMPT,
  MAX_ATTACHMENT_CHARS_PER_CHUNK,
  renderExtractionUserContent,
  renderNewEvents,
  renderOpenItems,
  renderProjectProfile,
  renderRelatedContext,
} from "./prompt";
import type { ActionItemContext, RelatedContextChunk } from "./types";

const baseContext: ActionItemContext = {
  project: { id: "proj-1", name: "Acme Dashboard", description: "Internal ops tooling", timezone: "UTC" },
  openActionItems: [],
  recentSummaries: [],
  newEvents: [],
};

describe("renderOpenItems / renderProjectProfile", () => {
  it("falls back to (none) / (none yet) when empty", () => {
    expect(renderOpenItems([])).toBe("(none)");
    const profile = renderProjectProfile(baseContext);
    expect(profile).toContain("(none)");
    expect(profile).toContain("(none yet)");
  });

  it("renders open items with id, kind, priority and title", () => {
    const rendered = renderOpenItems([{ id: "t-1", title: "Fix flaky test", kind: "action", priority: "high" }]);
    expect(rendered).toBe("- id=t-1 [action/high] Fix flaky test");
  });
});

describe("renderNewEvents", () => {
  it("drops attachments over the per-chunk char budget instead of truncating, and warns", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const bigText = "x".repeat(MAX_ATTACHMENT_CHARS_PER_CHUNK - 100);
    const context: ActionItemContext = {
      ...baseContext,
      newEvents: [
        {
          id: "e-1",
          type: "slack.message",
          occurredAt: "2026-08-14T00:00:00Z",
          title: "first",
          attachments: [{ filename: "a.txt", mimeType: "text/plain", text: bigText, truncated: false }],
        },
        {
          id: "e-2",
          type: "slack.message",
          occurredAt: "2026-08-14T00:01:00Z",
          title: "second",
          attachments: [{ filename: "b.txt", mimeType: "text/plain", text: "y".repeat(500), truncated: false }],
        },
      ],
    };
    const rendered = renderNewEvents(context);
    expect(rendered).toContain("a.txt");
    expect(rendered).not.toContain("--- attachment: b.txt");
    expect(rendered).toContain("additional attachment(s) omitted");
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("dropped 1 attachment"));
    warnSpy.mockRestore();
  });
});

const chunk = (overrides: Partial<RelatedContextChunk>): RelatedContextChunk => ({
  label: "R1",
  chunkId: "chunk-1",
  sourceKind: "normalized_event",
  content: "some retrieved content",
  occurredAt: "2026-08-14T00:00:00Z",
  citableEventId: "event-9",
  distance: 0.2,
  ...overrides,
});

describe("renderRelatedContext", () => {
  it("returns '' (section omitted) for empty or undefined input", () => {
    expect(renderRelatedContext(undefined)).toBe("");
    expect(renderRelatedContext([])).toBe("");
  });

  it("renders each chunk's label but never its chunkId or citableEventId", () => {
    const rendered = renderRelatedContext([chunk({ label: "R1", chunkId: "chunk-secret-id", citableEventId: "event-secret-id" })]);
    expect(rendered).toContain("R1");
    expect(rendered).not.toContain("chunk-secret-id");
    expect(rendered).not.toContain("event-secret-id");
  });

  it("carries the 'possibly relevant / not authoritative' framing", () => {
    const rendered = renderRelatedContext([chunk({})]);
    expect(rendered).toMatch(/possibly relevant/i);
    expect(rendered).toMatch(/not authoritative/i);
  });

  it("orders chunks chronologically ascending, not by distance", () => {
    const rendered = renderRelatedContext([
      chunk({ label: "R1", occurredAt: "2026-08-20T00:00:00Z", distance: 0.1, content: "later" }),
      chunk({ label: "R2", occurredAt: "2026-08-01T00:00:00Z", distance: 0.5, content: "earlier" }),
    ]);
    expect(rendered.indexOf("earlier")).toBeLessThan(rendered.indexOf("later"));
  });
});

describe("renderExtractionUserContent", () => {
  it("places RELATED CONTEXT before NEW EVENTS", () => {
    const context: ActionItemContext = {
      ...baseContext,
      newEvents: [{ id: "e-1", type: "slack.message", occurredAt: "2026-08-14T00:00:00Z", title: "an event" }],
      relatedContext: [chunk({})],
    };
    const rendered = renderExtractionUserContent(context);
    expect(rendered.indexOf("RELATED CONTEXT")).toBeGreaterThanOrEqual(0);
    expect(rendered.indexOf("RELATED CONTEXT")).toBeLessThan(rendered.indexOf("NEW EVENTS"));
  });

  it("omits the RELATED CONTEXT section entirely when there's nothing retrieved", () => {
    const rendered = renderExtractionUserContent(baseContext);
    expect(rendered).not.toContain("RELATED CONTEXT");
  });
});

describe("EXTRACTION_SYSTEM_PROMPT", () => {
  it("mentions RELATED CONTEXT, NEW EVENTS, and relatedContextRefs — catching rules/renderer drift", () => {
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("RELATED CONTEXT");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("NEW EVENTS");
    expect(EXTRACTION_SYSTEM_PROMPT).toContain("relatedContextRefs");
  });
});
