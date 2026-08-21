import "server-only";
import { normalizeExtractedText, stripHtml } from "@/connectors/google_drive/text";
import { loadPdfParse } from "@/lib/pdf/load";
import type { AttachmentPlan } from "./extract";

export type AttachmentParseOutcome =
  | { ok: true; text: string; truncated: boolean }
  | { ok: false; error: string };

/**
 * Executes a "parse" plan against already-downloaded bytes. Reuses the same
 * dynamic-import pattern already proven in
 * project-context/actions.ts:extractFileText (PDFParse with a
 * try/finally-destroy, mammoth.extractRawText({buffer})) rather than
 * reimplementing it — that function is stateless/client-triggered and this
 * one runs inside a background job, but the parsing itself is identical.
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
    let rawText: string;
    switch (plan.parser) {
      case "pdf": {
        const { PDFParse } = await loadPdfParse();
        const parser = new PDFParse({ data: bytes });
        try {
          rawText = (await parser.getText()).text;
        } finally {
          await parser.destroy();
        }
        break;
      }
      case "docx": {
        const mammoth = await import("mammoth");
        rawText = (await mammoth.extractRawText({ buffer: bytes })).value;
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
