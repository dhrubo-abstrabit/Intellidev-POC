import { describe, expect, it } from "vitest";
import { mockConnector } from "./index";

describe("mockConnector", () => {
  it("generates a deterministic batch and advances the cursor", async () => {
    const first = await mockConnector.fetchSince({ tokens: {}, externalAccountId: "mock" }, null);
    expect(first.rawPayloads).toHaveLength(5);
    expect(first.nextCursor).toEqual({ seq: 5 });

    const second = await mockConnector.fetchSince({ tokens: {}, externalAccountId: "mock" }, first.nextCursor);
    expect(second.rawPayloads).toHaveLength(5);
    expect(second.nextCursor).toEqual({ seq: 10 });

    // No overlap between batches — every providerEventId is unique across pages.
    const firstIds = new Set(first.rawPayloads.map((p) => p.providerEventId));
    const secondIds = second.rawPayloads.map((p) => p.providerEventId);
    for (const id of secondIds) expect(firstIds.has(id)).toBe(false);
  });

  it("normalize maps a raw payload to a message.posted draft with a stable dedupeKey", () => {
    const drafts = mockConnector.normalize({
      payload: { seq: 0, author: "U_ALICE", text: "hi", channel_id: "mock-general", channel_name: "general" },
    });
    expect(drafts).toHaveLength(1);
    expect(drafts[0].dedupeKey).toBe("message.posted:mock-general:0");
  });
});
