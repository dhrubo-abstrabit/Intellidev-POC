import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorConfigError } from "@/connectors/errors";
import type { ConnectorCredentials, FetchResult, RawPayload } from "@/connectors/types";
import type { GoogleCursor } from "./cursor";

// The three sub-connectors are stubbed wholesale: this module owns exactly
// the delegation, deadline-splitting and cursor-nesting logic, and each
// sub-connector's own fetch/normalize behaviour is already covered by its own
// tests. vi.hoisted because vi.mock factories are hoisted above imports.
const subs = vi.hoisted(() => ({
  gmailFetchSince: vi.fn(),
  gmailNormalize: vi.fn(),
  driveFetchSince: vi.fn(),
  driveNormalize: vi.fn(),
  chatFetchSince: vi.fn(),
  chatNormalize: vi.fn(),
}));

vi.mock("@/connectors/gmail", () => ({
  gmailConnector: { id: "gmail", fetchSince: subs.gmailFetchSince, normalize: subs.gmailNormalize },
}));
vi.mock("@/connectors/google_drive", () => ({
  googleDriveConnector: { id: "google_drive", fetchSince: subs.driveFetchSince, normalize: subs.driveNormalize },
}));
vi.mock("@/connectors/google_chat", () => ({
  googleChatConnector: { id: "google_chat", fetchSince: subs.chatFetchSince, normalize: subs.chatNormalize },
}));

import { googleConnector } from "./index";

const credentials: ConnectorCredentials = {
  connectionId: "conn-1",
  providerConfigKey: "google",
  externalAccountId: "sub-1",
  getAccessToken: async () => "t",
};

function subResult(overrides: Partial<FetchResult<unknown>> = {}): FetchResult<unknown> {
  return { rawPayloads: [], nextCursor: { touched: true }, hasMore: false, ...overrides };
}

function payload(id: string): RawPayload {
  return { providerEventId: id, payload: { id } };
}

function context(config: Record<string, unknown>, budgetMs = 45_000) {
  return { config, deadline: createDeadline(budgetMs) };
}

beforeEach(() => {
  vi.clearAllMocks();
  subs.gmailFetchSince.mockResolvedValue(subResult());
  subs.driveFetchSince.mockResolvedValue(subResult());
  subs.chatFetchSince.mockResolvedValue(subResult());
});

describe("googleConnector.fetchSince", () => {
  it("calls only the sub-connectors whose config is non-null", async () => {
    await googleConnector.fetchSince(credentials, null, context({ gmail: {}, drive: null, chat: null }));

    expect(subs.gmailFetchSince).toHaveBeenCalledTimes(1);
    expect(subs.driveFetchSince).not.toHaveBeenCalled();
    expect(subs.chatFetchSince).not.toHaveBeenCalled();
  });

  it("hands each sub-connector its OWN config slice and its OWN previous cursor", async () => {
    const previous = {
      provider: "google",
      v: 1,
      gmail: { provider: "gmail", v: 1, lastInternalDateMs: 42 },
      drive: null,
      chat: null,
    } as GoogleCursor;

    await googleConnector.fetchSince(credentials, previous, context({ gmail: { query: "from:me" }, drive: null, chat: null }));

    const [, cursorArg, contextArg] = subs.gmailFetchSince.mock.calls[0];
    expect(cursorArg).toEqual(previous.gmail);
    expect(contextArg.config).toMatchObject({ query: "from:me" });
    // A slice of the parent budget, never the parent deadline itself.
    expect(contextArg.deadline.remainingMs()).toBeGreaterThan(0);
    expect(contextArg.deadline.remainingMs()).toBeLessThanOrEqual(45_000);
  });

  it("leaves a disabled service's cursor slot exactly as it was", async () => {
    const previous = {
      provider: "google",
      v: 1,
      gmail: null,
      drive: { provider: "google_drive", v: 1, sources: { folderA: {} } },
      chat: { provider: "google_chat", v: 1, spaceCursors: { "spaces/A": "2026-01-01T00:00:00Z" } },
      // Sub-cursors are opaque to this connector — abbreviated here rather
      // than spelling out every field Drive's real cursor carries.
    } as unknown as GoogleCursor;

    const result = await googleConnector.fetchSince(
      credentials,
      previous,
      context({ gmail: {}, drive: null, chat: null }),
    );

    expect(result.nextCursor.gmail).toEqual({ touched: true });
    expect(result.nextCursor.drive).toEqual(previous.drive);
    expect(result.nextCursor.chat).toEqual(previous.chat);
  });

  it("merges each attempted service's returned cursor into its own slot", async () => {
    subs.gmailFetchSince.mockResolvedValue(subResult({ nextCursor: { from: "gmail" } }));
    subs.driveFetchSince.mockResolvedValue(subResult({ nextCursor: { from: "drive" } }));
    subs.chatFetchSince.mockResolvedValue(subResult({ nextCursor: { from: "chat" } }));

    const result = await googleConnector.fetchSince(credentials, null, context({ gmail: {}, drive: {}, chat: {} }));

    expect(result.nextCursor.gmail).toEqual({ from: "gmail" });
    expect(result.nextCursor.drive).toEqual({ from: "drive" });
    expect(result.nextCursor.chat).toEqual({ from: "chat" });
  });

  it("tags every raw payload with the service that produced it", async () => {
    subs.gmailFetchSince.mockResolvedValue(subResult({ rawPayloads: [payload("m1")] }));
    subs.chatFetchSince.mockResolvedValue(subResult({ rawPayloads: [payload("c1")] }));

    const result = await googleConnector.fetchSince(credentials, null, context({ gmail: {}, drive: null, chat: {} }));

    expect(result.rawPayloads).toHaveLength(2);
    expect(result.rawPayloads[0].payload).toEqual({ id: "m1", _service: "gmail" });
    expect(result.rawPayloads[1].payload).toEqual({ id: "c1", _service: "chat" });
    // providerEventId (the ingest idempotency key) must survive tagging.
    expect(result.rawPayloads[0].providerEventId).toBe("m1");
  });

  it("ORs hasMore across the sub-connectors", async () => {
    subs.driveFetchSince.mockResolvedValue(subResult({ hasMore: true }));
    const result = await googleConnector.fetchSince(credentials, null, context({ gmail: {}, drive: {}, chat: {} }));
    expect(result.hasMore).toBe(true);
  });

  it("records the last service it actually reached as the next run's rotation point", async () => {
    const result = await googleConnector.fetchSince(credentials, null, context({ gmail: {}, drive: {}, chat: {} }));
    expect(result.nextCursor.lastPriorityService).toBe("chat");
  });

  it("queues the previous run's last service behind the ones it starved", async () => {
    // A previous run that only got as far as Gmail before its budget ran
    // out: Drive and Chat must lead this time, with Gmail bringing up the
    // rear, or a big Gmail backlog would starve them forever.
    const previous: GoogleCursor = {
      provider: "google",
      v: 1,
      gmail: null,
      drive: null,
      chat: null,
      lastPriorityService: "gmail",
    };

    const result = await googleConnector.fetchSince(credentials, previous, context({ gmail: {}, drive: {}, chat: {} }));

    const [driveOrder] = subs.driveFetchSince.mock.invocationCallOrder;
    const [chatOrder] = subs.chatFetchSince.mock.invocationCallOrder;
    const [gmailOrder] = subs.gmailFetchSince.mock.invocationCallOrder;
    expect(driveOrder).toBeLessThan(chatOrder);
    expect(chatOrder).toBeLessThan(gmailOrder);
    expect(result.nextCursor.lastPriorityService).toBe("gmail");
  });

  it("attempts nothing and reports hasMore when the budget is already spent", async () => {
    const previous = {
      provider: "google",
      v: 1,
      gmail: { provider: "gmail", v: 1, lastInternalDateMs: 42 },
      drive: null,
      chat: null,
      lastPriorityService: "gmail",
    } as GoogleCursor;

    const result = await googleConnector.fetchSince(credentials, previous, context({ gmail: {}, drive: {}, chat: {} }, 500));

    expect(subs.gmailFetchSince).not.toHaveBeenCalled();
    expect(result.hasMore).toBe(true);
    expect(result.rawPayloads).toEqual([]);
    expect(result.nextCursor).toEqual(previous); // nothing touched, priority not re-credited
  });

  it("no-ops (without clearing cursors) when every service is disabled", async () => {
    const previous = {
      provider: "google",
      v: 1,
      gmail: { provider: "gmail", v: 1, lastInternalDateMs: 42 },
      drive: null,
      chat: null,
    } as GoogleCursor;

    const result = await googleConnector.fetchSince(credentials, previous, context({ gmail: null, drive: null, chat: null }));

    expect(result).toEqual({ rawPayloads: [], nextCursor: previous, hasMore: false });
    expect(subs.gmailFetchSince).not.toHaveBeenCalled();
  });

  it("throws ConnectorConfigError on a config it cannot interpret", async () => {
    await expect(
      googleConnector.fetchSince(credentials, null, context({ chat: { spaceIds: ["not a space url"] } })),
    ).rejects.toBeInstanceOf(ConnectorConfigError);
  });
});

describe("googleConnector.normalize", () => {
  it("delegates to the sub-connector named by the _service tag", () => {
    subs.driveNormalize.mockReturnValue([{ type: "file.updated", occurredAt: new Date(0), dedupeKey: "d1" }]);

    const drafts = googleConnector.normalize({ payload: { id: "f1", _service: "drive" } });

    expect(subs.driveNormalize).toHaveBeenCalledTimes(1);
    expect(subs.gmailNormalize).not.toHaveBeenCalled();
    expect(drafts).toHaveLength(1);
  });

  it("stamps metadata.service without dropping the sub-connector's own metadata", () => {
    subs.gmailNormalize.mockReturnValue([
      { type: "email.received", occurredAt: new Date(0), dedupeKey: "m1", metadata: { thread_id: "t1" } },
    ]);

    const drafts = googleConnector.normalize({ payload: { id: "m1", _service: "gmail" } });

    expect(drafts[0].metadata).toEqual({ thread_id: "t1", service: "gmail" });
  });

  it("returns no drafts for an untagged payload rather than guessing", () => {
    expect(googleConnector.normalize({ payload: { id: "x" } })).toEqual([]);
    expect(googleConnector.normalize({ payload: { id: "x", _service: "calendar" } })).toEqual([]);
    expect(subs.gmailNormalize).not.toHaveBeenCalled();
  });
});
