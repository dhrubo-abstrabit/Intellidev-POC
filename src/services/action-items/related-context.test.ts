import { describe, expect, it } from "vitest";
import { buildQueryTexts } from "./related-context";
import type { NewEventSummary } from "@/lib/llm/types";

function event(overrides: Partial<NewEventSummary> & Pick<NewEventSummary, "id" | "type" | "occurredAt">): NewEventSummary {
  return { title: null, body: null, ...overrides };
}

describe("buildQueryTexts", () => {
  it("returns nothing for an empty event list", () => {
    expect(buildQueryTexts([])).toEqual([]);
  });

  it("groups events by type into separate query texts", () => {
    const events = [
      event({ id: "1", type: "slack.message", occurredAt: "2026-08-14T00:00:00Z", title: "checkout tests are flaky again this week" }),
      event({ id: "2", type: "gmail.message", occurredAt: "2026-08-14T00:01:00Z", title: "quarterly invoice sent to the client today" }),
    ];
    const texts = buildQueryTexts(events);
    expect(texts).toHaveLength(2);
    expect(texts.some((t) => t.includes("checkout tests"))).toBe(true);
    expect(texts.some((t) => t.includes("quarterly invoice"))).toBe(true);
  });

  it("merges overflow types into one group when there are more than 6 distinct types", () => {
    const events = Array.from({ length: 10 }, (_, i) =>
      event({ id: String(i), type: `type.${i}`, occurredAt: `2026-08-14T00:0${i}:00Z`, title: `event ${i}` }),
    );
    const texts = buildQueryTexts(events);
    expect(texts.length).toBeLessThanOrEqual(6);
  });

  it("orders events within a group newest-first", () => {
    const events = [
      event({ id: "1", type: "slack.message", occurredAt: "2026-08-14T00:00:00Z", title: "this is the older message about the deploy" }),
      event({ id: "2", type: "slack.message", occurredAt: "2026-08-15T00:00:00Z", title: "this is the newer message about the deploy" }),
    ];
    const [text] = buildQueryTexts(events);
    expect(text.indexOf("newer")).toBeLessThan(text.indexOf("older"));
  });

  it("drops a group whose assembled text is under the minimum length", () => {
    const events = [event({ id: "1", type: "slack.message", occurredAt: "2026-08-14T00:00:00Z", title: null, body: null })];
    expect(buildQueryTexts(events)).toEqual([]);
  });

  it("does not include attachment text in the query (events have no attachments field to begin with, by construction)", () => {
    const events = [
      event({
        id: "1",
        type: "slack.message",
        occurredAt: "2026-08-14T00:00:00Z",
        title: "hello team",
        body: "world, the deploy is finally done today",
      }),
    ];
    const [text] = buildQueryTexts(events);
    expect(text).toBe("hello team — world, the deploy is finally done today");
  });

  it("caps a single group's query text length", () => {
    const events = Array.from({ length: 200 }, (_, i) =>
      event({
        id: String(i),
        type: "slack.message",
        occurredAt: `2026-08-14T00:${String(i % 60).padStart(2, "0")}:00Z`,
        title: `message ${i}`,
        body: "x".repeat(400),
      }),
    );
    const [text] = buildQueryTexts(events);
    expect(text.length).toBeLessThanOrEqual(4_000);
  });
});
