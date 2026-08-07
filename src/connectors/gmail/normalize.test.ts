import { describe, expect, it, vi } from "vitest";

vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_ID", "test-client-id");
vi.stubEnv("GOOGLE_CONNECTOR_CLIENT_SECRET", "test-client-secret");

const { gmailConnector } = await import("./index");

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg1",
    threadId: "thread1",
    labelIds: ["INBOX"],
    internalDate: "1767600000000",
    payload: { headers: [{ name: "Subject", value: "Deploy review" }, { name: "From", value: 'Alice Smith <alice@example.com>' }] },
    body_excerpt: "Can someone review the deploy?",
    ...overrides,
  };
}

describe("gmailConnector.normalize", () => {
  it("maps a received message to email.received with actor/title/body from headers", () => {
    const drafts = gmailConnector.normalize({ occurredAt: new Date(1767600000000), payload: payload() });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({
      type: "email.received",
      actor: "alice@example.com",
      actorDisplay: "Alice Smith",
      actorEmail: "alice@example.com",
      resource: "gmail-thread:thread1",
      resourceType: "email_thread",
      title: "Deploy review",
      body: "Can someone review the deploy?",
      dedupeKey: "email.received:msg1",
    });
  });

  it("maps a SENT-labeled message to email.sent", () => {
    const drafts = gmailConnector.normalize({ occurredAt: new Date(), payload: payload({ labelIds: ["SENT"] }) });
    expect(drafts[0].type).toBe("email.sent");
    expect(drafts[0].dedupeKey).toBe("email.sent:msg1");
  });

  it("drops DRAFT/SPAM/TRASH/CHAT-labeled messages", () => {
    for (const label of ["DRAFT", "SPAM", "TRASH", "CHAT"]) {
      expect(gmailConnector.normalize({ occurredAt: new Date(), payload: payload({ labelIds: [label] }) })).toHaveLength(0);
    }
  });

  it("parses a From header with no display name", () => {
    const drafts = gmailConnector.normalize({
      occurredAt: new Date(),
      payload: payload({ payload: { headers: [{ name: "From", value: "bare@example.com" }] } }),
    });
    expect(drafts[0].actorEmail).toBe("bare@example.com");
    expect(drafts[0].actorDisplay).toBeUndefined();
  });

  it("leaves body undefined when no text was extracted", () => {
    const drafts = gmailConnector.normalize({ occurredAt: new Date(), payload: payload({ body_excerpt: undefined }) });
    expect(drafts[0].body).toBeUndefined();
  });

  it("clamps an overlong body to the normalized-event limit", () => {
    const drafts = gmailConnector.normalize({
      occurredAt: new Date(),
      payload: payload({ body_excerpt: "x".repeat(3000) }),
    });
    expect(drafts[0].body?.length).toBeLessThan(3000);
    expect(drafts[0].body?.endsWith("…[truncated]")).toBe(true);
  });

  it("groups by thread, not by message, via `resource`", () => {
    const a = gmailConnector.normalize({ occurredAt: new Date(), payload: payload({ id: "msg1", threadId: "threadA" }) });
    const b = gmailConnector.normalize({ occurredAt: new Date(), payload: payload({ id: "msg2", threadId: "threadA" }) });
    expect(a[0].resource).toBe(b[0].resource);
    expect(a[0].dedupeKey).not.toBe(b[0].dedupeKey); // but each message is still its own event
  });

  it("every emitted type matches the normalized_events CHECK constraint's regex", () => {
    for (const draft of gmailConnector.normalize({ occurredAt: new Date(), payload: payload() })) {
      expect(draft.type).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
    }
  });
});
