import { describe, expect, it } from "vitest";
import { createDeadline } from "@/connectors/deadline";
import { normalizeExtractedText, planTextExtraction, stripHtml } from "./text";

const okDeadline = () => createDeadline(60_000);
const budget = (overrides: Partial<{ extractText: boolean; maxTextFetchesPerRun: number; textFetchesSoFar: number }> = {}) => ({
  extractText: true,
  maxTextFetchesPerRun: 25,
  textFetchesSoFar: 0,
  ...overrides,
});

describe("planTextExtraction — mimeType routing", () => {
  it("exports Google Docs and Slides as text/plain", () => {
    expect(planTextExtraction({ mimeType: "application/vnd.google-apps.document" }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
      kind: "export",
      exportMimeType: "text/plain",
    });
    expect(
      planTextExtraction({ mimeType: "application/vnd.google-apps.presentation" }, budget(), { isBoundaryFile: false, deadline: okDeadline() }),
    ).toEqual({ kind: "export", exportMimeType: "text/plain" });
  });

  it("exports Sheets as text/csv (NOT text/plain — that 400s) and notes first_sheet_only", () => {
    const plan = planTextExtraction({ mimeType: "application/vnd.google-apps.spreadsheet" }, budget(), {
      isBoundaryFile: false,
      deadline: okDeadline(),
    });
    expect(plan).toEqual({ kind: "export", exportMimeType: "text/csv", note: "first_sheet_only" });
  });

  it("skips unsupported Google-native types (script, drawing, form, site, jam, map)", () => {
    for (const mimeType of [
      "application/vnd.google-apps.script",
      "application/vnd.google-apps.drawing",
      "application/vnd.google-apps.form",
      "application/vnd.google-apps.site",
      "application/vnd.google-apps.jam",
      "application/vnd.google-apps.map",
    ]) {
      expect(planTextExtraction({ mimeType }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
        kind: "skip",
        reason: "unsupported_google_type",
      });
    }
  });

  it("skips PDFs and Office binaries with no_parser", () => {
    for (const mimeType of [
      "application/pdf",
      "application/msword",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ]) {
      expect(planTextExtraction({ mimeType }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
        kind: "skip",
        reason: "no_parser",
      });
    }
  });

  it("downloads genuinely-plaintext mimeTypes via alt=media", () => {
    expect(planTextExtraction({ mimeType: "text/plain" }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
      kind: "download",
    });
    expect(planTextExtraction({ mimeType: "text/html" }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
      kind: "download",
    });
  });

  it("skips binary mimeTypes (image/video/audio/archives)", () => {
    for (const mimeType of ["image/png", "video/mp4", "audio/mpeg", "application/zip"]) {
      expect(planTextExtraction({ mimeType }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
        kind: "skip",
        reason: "binary",
      });
    }
  });

  it("skips an unrecognized mimeType with unknown_mime", () => {
    expect(planTextExtraction({ mimeType: "application/x-something-weird" }, budget(), { isBoundaryFile: false, deadline: okDeadline() })).toEqual({
      kind: "skip",
      reason: "unknown_mime",
    });
  });
});

describe("planTextExtraction — pre-flight skips", () => {
  it("skips when extractText is disabled", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain" }, budget({ extractText: false }), { isBoundaryFile: false, deadline: okDeadline() }),
    ).toEqual({ kind: "skip", reason: "disabled" });
  });

  it("skips a trashed file", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain", trashed: true }, budget(), { isBoundaryFile: false, deadline: okDeadline() }),
    ).toEqual({ kind: "skip", reason: "trashed" });
  });

  it("skips a file with no download permission", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain", capabilities: { canDownload: false } }, budget(), {
        isBoundaryFile: false,
        deadline: okDeadline(),
      }),
    ).toEqual({ kind: "skip", reason: "no_download_permission" });
  });

  it("skips a file larger than the download cap", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain", size: String(300 * 1024) }, budget(), { isBoundaryFile: false, deadline: okDeadline() }),
    ).toEqual({ kind: "skip", reason: "too_large" });
  });

  it("skips when the per-run text-fetch budget is exhausted", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain" }, budget({ maxTextFetchesPerRun: 5, textFetchesSoFar: 5 }), {
        isBoundaryFile: false,
        deadline: okDeadline(),
      }),
    ).toEqual({ kind: "skip", reason: "budget" });
  });

  it("skips a boundary file already ingested at the previous floor", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain" }, budget(), { isBoundaryFile: true, deadline: okDeadline() }),
    ).toEqual({ kind: "skip", reason: "boundary_already_ingested" });
  });

  it("skips when the deadline is nearly exhausted", () => {
    expect(
      planTextExtraction({ mimeType: "text/plain" }, budget(), { isBoundaryFile: false, deadline: createDeadline(100) }),
    ).toEqual({ kind: "skip", reason: "deadline" });
  });
});

describe("stripHtml", () => {
  it("removes tags and script/style content, decodes basic entities", () => {
    expect(stripHtml("<html><body><script>evil()</script><p>Hello &amp; welcome</p></body></html>")).toBe("Hello & welcome");
  });
});

describe("normalizeExtractedText", () => {
  it("normalizes CRLF and collapses excess blank lines", () => {
    const { text } = normalizeExtractedText("a\r\n\r\n\r\n\r\nb", 1000);
    expect(text).toBe("a\n\nb");
  });

  it("does not truncate text within the limit", () => {
    const { text, truncated } = normalizeExtractedText("short text", 1000);
    expect(text).toBe("short text");
    expect(truncated).toBe(false);
  });

  it("truncates on a whitespace boundary and marks it truncated", () => {
    const long = `${"word ".repeat(100)}TAIL`;
    const { text, truncated } = normalizeExtractedText(long, 50);
    expect(truncated).toBe(true);
    expect(text.endsWith("…[truncated]")).toBe(true);
    expect(text).not.toContain("TAIL");
  });
});
