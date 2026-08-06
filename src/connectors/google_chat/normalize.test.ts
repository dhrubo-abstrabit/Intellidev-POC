import { describe, expect, it, vi } from "vitest";

vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_SECRET", "test-client-secret");

const { googleChatConnector } = await import("./index");

describe("googleChatConnector.normalize", () => {
  it("maps a message with text to a message.posted draft with a stable dedupeKey", () => {
    const occurredAt = new Date("2026-01-01T12:00:00Z");
    const drafts = googleChatConnector.normalize({
      occurredAt,
      payload: {
        name: "spaces/AAAA/messages/BBBB.BBBB",
        sender: { name: "users/104871234567890123456", type: "HUMAN" },
        text: "Can someone review the deploy?",
        space_name: "spaces/AAAA",
        thread: { name: "spaces/AAAA/threads/CCCC" },
      },
    });

    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "message.posted",
      resource: "gchat-space:spaces/AAAA",
      body: "Can someone review the deploy?",
      dedupeKey: "message.posted:spaces/AAAA/messages/BBBB.BBBB",
    });
  });

  it("falls back to raw sender.name when no directory resolution was attached (resolution off, failed, or a non-HUMAN sender)", () => {
    // Google's User resource docs state that under USER auth (the flow
    // this connector uses), Chat's own API returns only `name`/`type` on
    // `sender` — no displayName, no email. fetchSince's People API lookup
    // (directory.ts) is what fills sender_display_name/sender_email before
    // normalize() ever sees the payload; when that didn't happen (disabled
    // via config, the lookup failed, or this sender was skipped), actor
    // falls back to the raw `users/<id>` string rather than guessing.
    const drafts = googleChatConnector.normalize({
      occurredAt: new Date(),
      payload: {
        name: "spaces/AAAA/messages/BBBB",
        sender: { name: "users/104871234567890123456", type: "HUMAN" },
        text: "hi",
        space_name: "spaces/AAAA",
      },
    });
    expect(drafts[0].actor).toBe("users/104871234567890123456");
    expect(drafts[0].actorDisplay).toBeUndefined();
    expect(drafts[0].actorEmail).toBeUndefined();
  });

  it("uses the resolved display name/email attached by fetchSince's directory lookup, when present", () => {
    const drafts = googleChatConnector.normalize({
      occurredAt: new Date(),
      payload: {
        name: "spaces/AAAA/messages/BBBB",
        sender: { name: "users/104871234567890123456", type: "HUMAN" },
        text: "hi",
        space_name: "spaces/AAAA",
        sender_display_name: "Alice Smith",
        sender_email: "alice@example.com",
      },
    });
    expect(drafts[0].actor).toBe("users/104871234567890123456"); // actor stays the stable id
    expect(drafts[0].actorDisplay).toBe("Alice Smith");
    expect(drafts[0].actorEmail).toBe("alice@example.com");
  });

  it("skips a card-only message with no text and no formattedText", () => {
    const drafts = googleChatConnector.normalize({
      occurredAt: new Date(),
      payload: { name: "spaces/AAAA/messages/BBBB", space_name: "spaces/AAAA" },
    });
    expect(drafts).toHaveLength(0);
  });

  it("falls back to formattedText when text is absent", () => {
    const drafts = googleChatConnector.normalize({
      occurredAt: new Date(),
      payload: { name: "spaces/AAAA/messages/BBBB", formattedText: "<b>hi</b>", space_name: "spaces/AAAA" },
    });
    expect(drafts[0].body).toBe("<b>hi</b>");
  });

  it("every emitted type matches the normalized_events CHECK constraint's regex", () => {
    const drafts = googleChatConnector.normalize({
      occurredAt: new Date(),
      payload: { name: "spaces/AAAA/messages/BBBB", text: "hi", space_name: "spaces/AAAA" },
    });
    for (const draft of drafts) {
      expect(draft.type).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});
