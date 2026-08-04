import { describe, expect, it, vi } from "vitest";

vi.stubEnv("SLACK_CLIENT_ID", "test-client-id");
vi.stubEnv("SLACK_CLIENT_SECRET", "test-client-secret");
vi.stubEnv("SLACK_OAUTH_STATE_SECRET", "test-state-secret-at-least-16-bytes");

const { slackConnector } = await import("./index");

describe("slackConnector.normalize", () => {
  it("maps a plain message to a message.posted draft", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: { ts: "1700000000.000100", user: "U1", text: "hello", channel_id: "C123", channel_name: "general" },
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "message.posted",
      actor: "U1",
      resource: "slack-channel:C123",
      body: "hello",
      dedupeKey: "message.posted:C123:1700000000.000100",
    });
  });

  it("drops bookkeeping subtypes like channel_join", () => {
    const drafts = slackConnector.normalize({
      payload: { ts: "1700000000.000100", subtype: "channel_join", channel_id: "C123" },
    });
    expect(drafts).toHaveLength(0);
  });
});
