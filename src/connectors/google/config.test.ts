import { describe, expect, it } from "vitest";
import { googleConfigSchema, googleConfigEntry, GOOGLE_CONFIG_SECTIONS, type GoogleConfig } from "./config";

const DRIVE_FOLDER_URL = "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz";

describe("googleConfigSchema", () => {
  it("defaults every sub-service to disabled", () => {
    expect(googleConfigSchema.parse({})).toEqual({
      gmail: null,
      drive: null,
      chat: null,
      processAttachments: true,
      maxAttachmentsPerRun: 15,
    });
  });

  it("accepts a partially-enabled config and fills in that service's own defaults", () => {
    const parsed = googleConfigSchema.parse({ gmail: null, drive: { sources: [DRIVE_FOLDER_URL] }, chat: null });
    expect(parsed.gmail).toBeNull();
    expect(parsed.chat).toBeNull();
    expect(parsed.drive).toMatchObject({
      sources: ["1AbCdEfGhIjKlMnOpQrStUvWxYz"],
      initialLookbackDays: 30,
      extractText: true,
    });
  });

  it("keeps each sub-schema's own validation — a bad Drive source still fails", () => {
    expect(googleConfigSchema.safeParse({ drive: { sources: ["not a folder url"] } }).success).toBe(false);
  });

  it("rejects a sub-config that isn't an object or null", () => {
    expect(googleConfigSchema.safeParse({ gmail: "on" }).success).toBe(false);
  });
});

describe("googleConfigEntry.isConfigured", () => {
  function configured(config: Partial<GoogleConfig>): boolean {
    return googleConfigEntry.isConfigured!(googleConfigSchema.parse(config));
  }

  it("is false when nothing is enabled", () => {
    expect(configured({})).toBe(false);
  });

  it("is true as soon as ONE enabled service is itself configured", () => {
    // Gmail's own isConfigured is unconditionally true (an empty query is a
    // legitimate "sync everything").
    expect(configured({ gmail: {} as never })).toBe(true);
    expect(configured({ drive: { sources: [DRIVE_FOLDER_URL] } as never })).toBe(true);
  });

  it("is false for an enabled-but-unscoped service", () => {
    // Drive with no folders and Chat with no spaces can't sync anything, so
    // the integration stays 'pending' rather than flipping to 'connected'.
    expect(configured({ drive: {} as never, chat: {} as never })).toBe(false);
  });
});

describe("googleConfigEntry.pruneCursorOnScopeChange", () => {
  const prune = googleConfigEntry.pruneCursorOnScopeChange!;
  const cursor = {
    provider: "google",
    v: 1,
    gmail: { provider: "gmail", v: 1, lastInternalDateMs: 42 },
    drive: { provider: "google_drive", v: 1, sources: {} },
    chat: { provider: "google_chat", v: 1, spaceCursors: {} },
  };

  function config(overrides: Record<string, unknown>): GoogleConfig {
    return googleConfigSchema.parse({ gmail: {}, drive: { sources: [DRIVE_FOLDER_URL] }, chat: {}, ...overrides });
  }

  it("returns null (fall back to deleting the row) when there is no cursor", () => {
    expect(prune(config({}), config({}), null)).toBeNull();
  });

  it("drops only the sub-cursor whose own scope changed", () => {
    const previous = config({ gmail: { query: "from:a" } });
    const next = config({ gmail: { query: "from:b" } });

    const pruned = prune(previous, next, cursor);

    expect(pruned).toEqual({ ...cursor, gmail: null });
  });

  it("keeps every sub-cursor when only a non-scope field changed", () => {
    const previous = config({ gmail: { maxBodyChars: 1000 } });
    const next = config({ gmail: { maxBodyChars: 2000 } });

    expect(prune(previous, next, cursor)).toEqual(cursor);
  });

  it("drops a service's cursor when it is toggled off or back on", () => {
    const previous = config({});
    const next = config({ chat: null });

    expect(prune(previous, next, cursor)).toEqual({ ...cursor, chat: null });
  });

  it("treats a pre-merge / malformed previous config as 'nothing was enabled'", () => {
    // A legacy row's flat config ({spaceIds:[...]}) has no gmail/drive/chat
    // keys at all — every service reads as newly enabled, so every slot is
    // dropped rather than resumed against a scope that never applied.
    const pruned = prune({ spaceIds: ["spaces/AAAA"] } as unknown as GoogleConfig, config({}), cursor);
    expect(pruned).toEqual({ ...cursor, gmail: null, drive: null, chat: null });
  });
});

describe("GOOGLE_CONFIG_SECTIONS", () => {
  it("covers all three sub-services and reuses each connector's own field specs", () => {
    expect(GOOGLE_CONFIG_SECTIONS.map((section) => section.key)).toEqual(["gmail", "drive", "chat"]);
    for (const section of GOOGLE_CONFIG_SECTIONS) {
      expect(section.fields.length).toBeGreaterThan(0);
    }
    expect(GOOGLE_CONFIG_SECTIONS.find((s) => s.key === "drive")!.fields.some((f) => f.key === "sources")).toBe(true);
  });
});
