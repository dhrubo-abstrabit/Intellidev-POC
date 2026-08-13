import "server-only";
import { DOWNLOADABLE_TEXT_MIME_TYPES } from "@/connectors/google_drive/text";
import type { TextSkipReason } from "@/connectors/google_drive/text";

export type { TextSkipReason };

export type AttachmentParser = "pdf" | "docx" | "text" | "html";

export type AttachmentPlan =
  | { kind: "parse"; parser: AttachmentParser }
  | { kind: "skip"; reason: TextSkipReason };

export interface AttachmentExtractionBudget {
  /** Hard byte cap on what gets downloaded+parsed — a giant "text" file
   * would otherwise sit in memory in full (mirrors Drive's
   * DOWNLOAD_MAX_BYTES; kept separate rather than shared since the two
   * connectors' size tradeoffs can diverge independently). */
  maxBytes: number;
  extractionsSoFar: number;
  maxPerRun: number;
}

const OFFICE_NO_PARSER_MIME_TYPES = new Set([
  "application/msword",
  "application/vnd.ms-excel",
  "application/vnd.ms-powerpoint",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation",
]);
const OFFICE_NO_PARSER_EXTENSIONS = /\.(doc|xls|xlsx|ppt|pptx)$/;

/**
 * Pure decision table — same shape and rationale as
 * connectors/google_drive/text.ts's planTextExtraction: keep every routing
 * and skip decision unit-testable without a live download. Shared across
 * Slack/Gmail/Chat attachments (Drive files go through their own
 * planTextExtraction instead — this table exists specifically for
 * event_attachments rows).
 *
 * Mime type is trusted when present, but providers aren't always careful
 * about it (a Slack upload can arrive with a generic
 * "application/octet-stream" mimetype) — filename extension is checked as a
 * fallback for the two parseable formats we actually have parsers for.
 */
export function planAttachmentExtraction(
  attachment: { mimeType?: string; filename?: string; sizeBytes?: number },
  budget: AttachmentExtractionBudget,
): AttachmentPlan {
  if (budget.extractionsSoFar >= budget.maxPerRun) return { kind: "skip", reason: "budget" };

  const mimeType = attachment.mimeType?.toLowerCase().trim() ?? "";
  const name = attachment.filename?.toLowerCase().trim() ?? "";

  let parser: AttachmentParser | undefined;
  let skipReason: TextSkipReason | undefined;

  if (mimeType === "application/pdf" || name.endsWith(".pdf")) {
    parser = "pdf";
  } else if (
    mimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
    name.endsWith(".docx")
  ) {
    parser = "docx";
  } else if (OFFICE_NO_PARSER_MIME_TYPES.has(mimeType) || OFFICE_NO_PARSER_EXTENSIONS.test(name)) {
    // mammoth handles .docx only and pdf-parse handles PDF only — no legacy
    // Office or xlsx/pptx parser exists in this project, same gap
    // planTextExtraction documents for Drive.
    skipReason = "no_parser";
  } else if (mimeType === "text/html") {
    parser = "html";
  } else if (DOWNLOADABLE_TEXT_MIME_TYPES.has(mimeType)) {
    parser = "text";
  } else if (/^(image|video|audio)\//.test(mimeType) || /zip|x-tar|x-7z|x-rar/.test(mimeType)) {
    // Archives are deliberately never unpacked — a zip is "binary" here, not
    // a container to recurse into (avoids a zip-bomb surface).
    skipReason = "binary";
  } else {
    skipReason = "unknown_mime";
  }

  if (skipReason) return { kind: "skip", reason: skipReason };
  if (attachment.sizeBytes && attachment.sizeBytes > budget.maxBytes) return { kind: "skip", reason: "too_large" };
  return { kind: "parse", parser: parser! };
}
