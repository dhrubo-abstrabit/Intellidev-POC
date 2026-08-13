import { describe, expect, it } from "vitest";
import { planAttachmentExtraction } from "./extract";

const budget = (overrides: Partial<{ maxBytes: number; extractionsSoFar: number; maxPerRun: number }> = {}) => ({
  maxBytes: 10 * 1024 * 1024,
  extractionsSoFar: 0,
  maxPerRun: 15,
  ...overrides,
});

describe("planAttachmentExtraction — mimeType routing", () => {
  it("parses application/pdf as pdf", () => {
    expect(planAttachmentExtraction({ mimeType: "application/pdf" }, budget())).toEqual({ kind: "parse", parser: "pdf" });
  });

  it("falls back to a .pdf filename extension when mimeType is generic/missing", () => {
    expect(planAttachmentExtraction({ mimeType: "application/octet-stream", filename: "spec.PDF" }, budget())).toEqual({
      kind: "parse",
      parser: "pdf",
    });
  });

  it("parses .docx (by mimeType or extension) as docx", () => {
    expect(
      planAttachmentExtraction(
        { mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" },
        budget(),
      ),
    ).toEqual({ kind: "parse", parser: "docx" });
    expect(planAttachmentExtraction({ filename: "notes.docx" }, budget())).toEqual({ kind: "parse", parser: "docx" });
  });

  it("skips legacy Office and xlsx/pptx with no_parser — mammoth handles .docx only", () => {
    for (const mimeType of [
      "application/msword",
      "application/vnd.ms-excel",
      "application/vnd.ms-powerpoint",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ]) {
      expect(planAttachmentExtraction({ mimeType }, budget())).toEqual({ kind: "skip", reason: "no_parser" });
    }
    expect(planAttachmentExtraction({ filename: "budget.xlsx" }, budget())).toEqual({ kind: "skip", reason: "no_parser" });
  });

  it("parses text/html as html and other plaintext-ish mimeTypes as text", () => {
    expect(planAttachmentExtraction({ mimeType: "text/html" }, budget())).toEqual({ kind: "parse", parser: "html" });
    expect(planAttachmentExtraction({ mimeType: "text/plain" }, budget())).toEqual({ kind: "parse", parser: "text" });
    expect(planAttachmentExtraction({ mimeType: "text/csv" }, budget())).toEqual({ kind: "parse", parser: "text" });
  });

  it("skips binary mimeTypes (image/video/audio/archives) — never unpacked", () => {
    for (const mimeType of ["image/png", "video/mp4", "audio/mpeg", "application/zip", "application/x-7z-compressed"]) {
      expect(planAttachmentExtraction({ mimeType }, budget())).toEqual({ kind: "skip", reason: "binary" });
    }
  });

  it("skips an unrecognized mimeType with unknown_mime", () => {
    expect(planAttachmentExtraction({ mimeType: "application/x-something-weird" }, budget())).toEqual({
      kind: "skip",
      reason: "unknown_mime",
    });
  });

  it("skips with unknown_mime when neither mimeType nor a recognized extension is present", () => {
    expect(planAttachmentExtraction({ filename: "mystery" }, budget())).toEqual({ kind: "skip", reason: "unknown_mime" });
  });
});

describe("planAttachmentExtraction — budget", () => {
  it("skips once the per-run extraction budget is exhausted", () => {
    expect(planAttachmentExtraction({ mimeType: "application/pdf" }, budget({ maxPerRun: 5, extractionsSoFar: 5 }))).toEqual({
      kind: "skip",
      reason: "budget",
    });
  });

  it("skips a parseable file larger than maxBytes", () => {
    expect(planAttachmentExtraction({ mimeType: "application/pdf", sizeBytes: 20 * 1024 * 1024 }, budget({ maxBytes: 1024 }))).toEqual({
      kind: "skip",
      reason: "too_large",
    });
  });

  it("does not apply the size cap to a file it was already going to skip for its type", () => {
    // A huge image must still report "binary", not "too_large" — the type-based
    // skip is more specific and should win.
    expect(planAttachmentExtraction({ mimeType: "image/png", sizeBytes: 50 * 1024 * 1024 }, budget({ maxBytes: 1024 }))).toEqual({
      kind: "skip",
      reason: "binary",
    });
  });
});
