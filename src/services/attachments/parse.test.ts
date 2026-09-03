import { describe, expect, it } from "vitest";
import { parseAttachmentText } from "./parse";
import { MINIMAL_PDF, MINIMAL_PDF_LONG_TEXT } from "@/lib/pdf/__fixtures__/minimal-pdf";
import type { AttachmentPlan } from "./extract";

const pdfPlan: AttachmentPlan = { kind: "parse", parser: "pdf" };
const htmlPlan: AttachmentPlan = { kind: "parse", parser: "html" };
const textPlan: AttachmentPlan = { kind: "parse", parser: "text" };

describe("parseAttachmentText — non-pdf branches", () => {
  it("rejects a non-parse plan without touching bytes", async () => {
    const result = await parseAttachmentText({ kind: "skip", reason: "no_parser" }, Buffer.from(""), 1000);
    expect(result).toEqual({ ok: false, error: "not a parse plan" });
  });

  it("strips tags for an html plan and never sets pages", async () => {
    const result = await parseAttachmentText(htmlPlan, Buffer.from("<p>Hello <b>world</b></p>"), 1000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.text).toContain("Hello");
    expect(result.text).toContain("world");
    expect(result.pages).toBeUndefined();
  });

  it("passes bytes through as utf8 for a text plan", async () => {
    const result = await parseAttachmentText(textPlan, Buffer.from("plain text content"), 1000);
    expect(result).toEqual({ ok: true, text: "plain text content", truncated: false });
  });

  it("truncates a text plan over maxChars with the normalizeExtractedText marker", async () => {
    const result = await parseAttachmentText(textPlan, Buffer.from("a".repeat(100)), 10);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.text).toContain("…[truncated]");
  });
});

describe("parseAttachmentText — pdf branch", () => {
  it("returns pages with ascending page numbers, and text equal to the pages joined by blank lines", async () => {
    const result = await parseAttachmentText(pdfPlan, Buffer.from(MINIMAL_PDF_LONG_TEXT, "latin1"), 8000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toBeDefined();
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0].pageNumber).toBe(1);
    expect(result.pages![0].text).toContain("longer paragraph");
    expect(result.text).toBe(result.pages!.map((p) => p.text).join("\n\n"));
    expect(result.truncated).toBe(false);
  });

  it("drops a page below MIN_PAGE_CHARS as a divider page, producing no chunks", async () => {
    // MINIMAL_PDF's "Hello PDF" is only 9 chars — the same shortness that
    // makes it perfect for load.test.ts's outage guard makes it exactly the
    // kind of divider/cover page this budget-walk is supposed to drop.
    const result = await parseAttachmentText(pdfPlan, Buffer.from(MINIMAL_PDF, "latin1"), 8000);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pages).toEqual([]);
    expect(result.text).toBe("");
  });

  it("truncates and marks the overflow page when the budget is smaller than the page's text", async () => {
    const result = await parseAttachmentText(pdfPlan, Buffer.from(MINIMAL_PDF_LONG_TEXT, "latin1"), 5);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.truncated).toBe(true);
    expect(result.pages).toHaveLength(1);
    expect(result.pages![0].text.length).toBeLessThanOrEqual(5 + "\n…[truncated]".length);
  });

  it("never throws — a malformed PDF resolves to an error outcome instead", async () => {
    const result = await parseAttachmentText(pdfPlan, Buffer.from("this is not a pdf at all"), 8000);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(typeof result.error).toBe("string");
    expect(result.error.length).toBeGreaterThan(0);
  });
});
