import { describe, expect, it } from "vitest";
import { clampBody, MAX_BODY_CHARS, normalizeDriveEvent, utcHourBucket } from "./normalize";

function payload(overrides: Record<string, unknown> = {}) {
  return {
    id: "file1",
    name: "Notes.gdoc",
    mimeType: "application/vnd.google-apps.document",
    version: "3",
    createdTime: "2026-01-01T00:00:00.000Z",
    modifiedTime: "2026-01-05T00:00:00.000Z",
    _sourceId: "source1",
    _mode: "incremental" as const,
    ...overrides,
  };
}

describe("normalizeDriveEvent — type selection", () => {
  it("classifies as file.created when createdTime is at/after the floor", () => {
    const drafts = normalizeDriveEvent({
      payload: payload({ _floor: "2026-01-04T00:00:00.000Z", createdTime: "2026-01-05T00:00:00.000Z" }),
    });
    expect(drafts[0].type).toBe("file.created");
  });

  it("falls back to createdTime === modifiedTime when no _floor is present", () => {
    const drafts = normalizeDriveEvent({
      payload: payload({ createdTime: "2026-01-05T00:00:00.000Z", modifiedTime: "2026-01-05T00:00:00.000Z", _floor: undefined }),
    });
    expect(drafts[0].type).toBe("file.created");
  });

  it("classifies as file.updated when createdTime predates the floor", () => {
    const drafts = normalizeDriveEvent({
      payload: payload({ _floor: "2026-01-04T00:00:00.000Z", createdTime: "2026-01-01T00:00:00.000Z" }),
    });
    expect(drafts[0].type).toBe("file.updated");
  });

  it("classifies a trashed file in the incremental stream as file.trashed", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ trashed: true }) });
    expect(drafts[0].type).toBe("file.trashed");
  });

  it("drops a trashed file seen only via the backfill stream — not real activity", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ trashed: true, _mode: "backfill" }) });
    expect(drafts).toHaveLength(0);
  });

  it("skips folders (defense in depth — the query already excludes them)", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ mimeType: "application/vnd.google-apps.folder" }) });
    expect(drafts).toHaveLength(0);
  });

  it("skips shortcuts", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ mimeType: "application/vnd.google-apps.shortcut" }) });
    expect(drafts).toHaveLength(0);
  });

  it("skips a payload missing an identity field rather than throwing", () => {
    expect(normalizeDriveEvent({ payload: payload({ version: undefined }) })).toHaveLength(0);
  });
});

describe("normalizeDriveEvent — dedupeKey coalescing", () => {
  // createdTime (2026-01-01, from the payload() default) predates _floor
  // here, which is what makes selectType classify these as file.updated
  // rather than file.created.
  it("two file.updated events for the same file in the same UTC hour share a dedupeKey", () => {
    const a = normalizeDriveEvent({ payload: payload({ modifiedTime: "2026-01-05T14:05:00.000Z", _floor: "2026-01-05T00:00:00.000Z" }) });
    const b = normalizeDriveEvent({ payload: payload({ modifiedTime: "2026-01-05T14:55:00.000Z", _floor: "2026-01-05T00:00:00.000Z" }) });
    expect(a[0].dedupeKey).toBe(b[0].dedupeKey);
  });

  it("file.updated events an hour apart do NOT share a dedupeKey", () => {
    const a = normalizeDriveEvent({ payload: payload({ modifiedTime: "2026-01-05T14:05:00.000Z", _floor: "2026-01-05T00:00:00.000Z" }) });
    const b = normalizeDriveEvent({ payload: payload({ modifiedTime: "2026-01-05T15:05:00.000Z", _floor: "2026-01-05T00:00:00.000Z" }) });
    expect(a[0].dedupeKey).not.toBe(b[0].dedupeKey);
  });

  it("file.created and file.trashed dedupeKeys are unbucketed (not time-based)", () => {
    const created = normalizeDriveEvent({ payload: payload({ _floor: "2026-01-01T00:00:00.000Z" }) });
    expect(created[0].dedupeKey).toBe("file.created:file1");
    const trashed = normalizeDriveEvent({ payload: payload({ trashed: true }) });
    expect(trashed[0].dedupeKey).toBe("file.trashed:file1");
  });
});

describe("normalizeDriveEvent — field mapping", () => {
  it("builds a folder-path-prefixed title when _folderPath is present", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ _folderPath: "Project/Docs" }) });
    expect(drafts[0].title).toBe("Project/Docs/Notes.gdoc");
  });

  it("falls back to the bare file name with no folder path", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ _folderPath: undefined }) });
    expect(drafts[0].title).toBe("Notes.gdoc");
  });

  it("clamps the body to MAX_BODY_CHARS", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ text_excerpt: "x".repeat(MAX_BODY_CHARS + 500) }) });
    expect(drafts[0].body?.length).toBeLessThanOrEqual(MAX_BODY_CHARS + "\n…[truncated]".length);
    expect(drafts[0].body?.endsWith("…[truncated]")).toBe(true);
  });

  it("leaves body undefined when no text was extracted", () => {
    const drafts = normalizeDriveEvent({ payload: payload({ text_excerpt: undefined }) });
    expect(drafts[0].body).toBeUndefined();
  });

  it("every emitted type matches the normalized_events CHECK constraint's regex", () => {
    for (const overrides of [{}, { trashed: true }]) {
      for (const draft of normalizeDriveEvent({ payload: payload(overrides) })) {
        expect(draft.type).toMatch(/^[a-z][a-z0-9_]*\.[a-z][a-z0-9_]*$/);
      }
    }
  });
});

describe("utcHourBucket / clampBody", () => {
  it("utcHourBucket produces an hour-precision key", () => {
    expect(utcHourBucket("2026-08-06T14:37:00.000Z")).toBe("2026-08-06T14");
  });

  it("clampBody passes short text through unchanged", () => {
    expect(clampBody("hello")).toBe("hello");
  });

  it("clampBody returns undefined for undefined input", () => {
    expect(clampBody(undefined)).toBeUndefined();
  });
});
