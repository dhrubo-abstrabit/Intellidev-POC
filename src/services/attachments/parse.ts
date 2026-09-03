import "server-only";
import { normalizeExtractedText, stripHtml } from "@/connectors/google_drive/text";
import { createDocxLoader, createPdfLoader } from "@/lib/pdf/load";
import type { AttachmentPlan } from "./extract";

export type AttachmentParseOutcome =
  | {
      ok: true;
      text: string;
      truncated: boolean;
      /** Present only for parser:"pdf" — mammoth has no pagination, so a
       * docx/html/text outcome never carries this. Reflects exactly what
       * survived into `text` (in the same order, joined by "\n\n"), so a
       * caller can stamp per-chunk page_number by re-chunking each page's
       * text independently rather than re-deriving offsets into `text`. */
      pages?: { pageNumber: number; text: string }[];
    }
  | { ok: false; error: string };

// A page whose normalized text is shorter than this is treated as a divider
// / near-empty page (a cover sheet, a page number by itself) and dropped
// rather than becoming its own near-empty chunk downstream.
const MIN_PAGE_CHARS = 30;

/**
 * Executes a "parse" plan against already-downloaded bytes, via the
 * LangChain loaders in src/lib/pdf/load.ts (PDFLoader/DocxLoader — both
 * wrap the same pdf-parse/mammoth calls this function used to make
 * directly, but PDFLoader additionally splits output per page, which the
 * pdf branch below exploits for page-number provenance).
 *
 * Never throws: a malformed PDF or a mammoth parse error must not fail the
 * whole attachments job run, same contract as
 * connectors/google_drive/text.ts's fetchFileText ("one weird file must
 * never fail the whole run") extended one step further to parsing. Returns
 * the actual error message on failure (not just a generic label) so
 * event_attachments.error is diagnosable straight from the DB — a parse can
 * fail for reasons specific to the file (encrypted PDF, corrupt bytes) that
 * "parse failed (pdf)" alone doesn't distinguish.
 */
export async function parseAttachmentText(plan: AttachmentPlan, bytes: Buffer, maxChars: number): Promise<AttachmentParseOutcome> {
  if (plan.kind !== "parse") return { ok: false, error: "not a parse plan" };

  try {
    if (plan.parser === "pdf") {
      // Uint8Array.from(), not `new Blob([bytes])` directly: Buffer's
      // underlying ArrayBufferLike admits SharedArrayBuffer, which BlobPart
      // rejects — .from() always allocates a fresh, plain ArrayBuffer.
      const loader = await createPdfLoader(new Blob([Uint8Array.from(bytes)]));
      const docs = await loader.load();

      // Clean each page's text (BOM/CRLF/blank-line normalization only — no
      // truncation yet, hence maxChars: Infinity) before budgeting across
      // pages, so a divider page's normalized length is what MIN_PAGE_CHARS
      // actually judges.
      const normalizedPages: { pageNumber: number; text: string }[] = [];
      docs.forEach((doc, index) => {
        const pageNumber = (doc.metadata as { loc?: { pageNumber?: number } }).loc?.pageNumber ?? index + 1;
        const { text } = normalizeExtractedText(doc.pageContent, Number.POSITIVE_INFINITY);
        if (text.length >= MIN_PAGE_CHARS) normalizedPages.push({ pageNumber, text });
      });

      // Walk pages in order against the caller's maxChars budget: pages that
      // fully fit are kept whole, the first page that overflows gets
      // truncated (with normalizeExtractedText's own boundary + marker
      // logic) and ends the walk, later pages are dropped entirely. Global
      // budget, not per-page, so a document with many short pages isn't
      // penalized relative to one long page.
      const pages: { pageNumber: number; text: string }[] = [];
      let remaining = maxChars;
      let truncated = false;
      for (const page of normalizedPages) {
        if (remaining <= 0) {
          truncated = true;
          break;
        }
        if (page.text.length <= remaining) {
          pages.push(page);
          remaining -= page.text.length;
        } else {
          const { text: cut } = normalizeExtractedText(page.text, remaining);
          pages.push({ pageNumber: page.pageNumber, text: cut });
          truncated = true;
          break;
        }
      }

      return { ok: true, text: pages.map((p) => p.text).join("\n\n"), truncated, pages };
    }

    let rawText: string;
    switch (plan.parser) {
      case "docx": {
        const loader = await createDocxLoader(new Blob([Uint8Array.from(bytes)]));
        const docs = await loader.load();
        rawText = docs[0]?.pageContent ?? "";
        break;
      }
      case "html":
        rawText = stripHtml(bytes.toString("utf8"));
        break;
      case "text":
        rawText = bytes.toString("utf8");
        break;
    }
    const { text, truncated } = normalizeExtractedText(rawText, maxChars);
    return { ok: true, text, truncated };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[attachments] parse failed (${plan.parser}):`, err);
    return { ok: false, error: message };
  }
}
