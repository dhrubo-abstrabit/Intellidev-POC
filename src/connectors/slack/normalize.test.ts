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

  it("carries the display name fetchSince resolved into actorDisplay", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        ts: "1700000000.000100",
        user: "U1",
        text: "hello",
        channel_id: "C123",
        channel_name: "general",
        user_display_name: "Priya Patel",
      },
    });

    expect(drafts[0]).toMatchObject({ actor: "U1", actorDisplay: "Priya Patel" });
  });

  it("leaves actorDisplay undefined when the directory lookup found nothing", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: { ts: "1700000000.000100", user: "U1", text: "hello", channel_id: "C123" },
    });

    expect(drafts[0].actorDisplay).toBeUndefined();
  });

  it("prefers the fetchSince-resolved text over the raw mention syntax", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        ts: "1700000000.000100",
        user: "U1",
        text: "<@U2> can you check this?",
        text_resolved: "@Priya Patel can you check this?",
        channel_id: "C123",
      },
    });

    expect(drafts[0].body).toBe("@Priya Patel can you check this?");
  });

  it("falls back to the raw text when fetchSince didn't resolve it", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: { ts: "1700000000.000100", user: "U1", text: "<@U2> hello", channel_id: "C123" },
    });

    expect(drafts[0].body).toBe("<@U2> hello");
  });

  it("keeps a file_share message and carries its files[] as attachment drafts — regression test for the old `if (message.subtype) return []` blanket drop", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        ts: "1700000000.000100",
        user: "U1",
        text: "here's the spec",
        subtype: "file_share",
        channel_id: "C123",
        channel_name: "general",
        files: [
          {
            id: "F123",
            name: "spec.pdf",
            title: "spec.pdf",
            mimetype: "application/pdf",
            size: 4096,
            mode: "hosted",
            url_private_download: "https://files.slack.com/files-pri/T123-F123/spec.pdf",
          },
        ],
      },
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0].body).toBe("here's the spec");
    expect(drafts[0].attachments).toEqual([
      {
        providerAttachmentId: "F123",
        filename: "spec.pdf",
        mimeType: "application/pdf",
        sizeBytes: 4096,
        downloadRef: { url_private_download: "https://files.slack.com/files-pri/T123-F123/spec.pdf" },
      },
    ]);
  });

  it("still drops genuine bookkeeping subtypes like channel_topic", () => {
    const drafts = slackConnector.normalize({
      payload: { ts: "1700000000.000100", subtype: "channel_topic", channel_id: "C123" },
    });
    expect(drafts).toHaveLength(0);
  });

  it("excludes tombstoned and externally-linked files — nothing to download", () => {
    const drafts = slackConnector.normalize({
      providerEventId: "C123:1700000000.000100",
      occurredAt: new Date("2026-01-01T00:00:00Z"),
      payload: {
        ts: "1700000000.000100",
        user: "U1",
        subtype: "file_share",
        channel_id: "C123",
        files: [
          { id: "F1", mode: "tombstone", url_private_download: "https://files.slack.com/x" },
          { id: "F2", mode: "external" },
        ],
      },
    });
    expect(drafts[0].attachments).toBeUndefined();
  });
});
