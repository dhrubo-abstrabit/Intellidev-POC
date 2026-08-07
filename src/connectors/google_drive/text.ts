import "server-only";
import { GoogleBudgetExhaustedError } from "@/connectors/google/client";
import type { FetchDeadline } from "@/connectors/types";

export type TextSkipReason =
  | "disabled"
  | "unsupported_google_type"
  | "no_parser"
  | "binary"
  | "unknown_mime"
  | "no_download_permission"
  | "trashed"
  | "too_large"
  | "budget"
  | "boundary_already_ingested"
  | "deadline";

export type TextPlan =
  | { kind: "export"; exportMimeType: string; note?: string }
  | { kind: "download" }
  | { kind: "skip"; reason: TextSkipReason };

// Google-native files have no `size` field at all (they're not stored as a
// blob) — this cap only applies to the "download" path (alt=media), which
// is exactly the binary/plaintext files that DO report a size.
const DOWNLOAD_MAX_BYTES = 256 * 1024;
const TEXT_RESERVE_MS = 4000;

const DOWNLOADABLE_TEXT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "text/csv",
  "text/tab-separated-values",
  "application/json",
  "application/xml",
  "text/xml",
  "text/html",
]);

interface DriveFileForPlan {
  mimeType: string;
  trashed?: boolean;
  size?: string;
  capabilities?: { canDownload?: boolean };
}

export interface TextExtractionBudget {
  extractText: boolean;
  maxTextFetchesPerRun: number;
  textFetchesSoFar: number;
}

/**
 * Pure decision table — the whole mimeType routing plus every pre-flight
 * skip lives here so it's a unit test, not something only exercisable
 * against the live API. Order matters: cheap/certain skips first.
 */
export function planTextExtraction(
  file: DriveFileForPlan,
  budget: TextExtractionBudget,
  options: { isBoundaryFile: boolean; deadline: FetchDeadline },
): TextPlan {
  if (!budget.extractText) return { kind: "skip", reason: "disabled" };
  if (file.trashed) return { kind: "skip", reason: "trashed" };
  if (options.isBoundaryFile) return { kind: "skip", reason: "boundary_already_ingested" };
  if (budget.textFetchesSoFar >= budget.maxTextFetchesPerRun) return { kind: "skip", reason: "budget" };
  if (options.deadline.remainingMs() < TEXT_RESERVE_MS) return { kind: "skip", reason: "deadline" };
  if (file.capabilities?.canDownload === false) return { kind: "skip", reason: "no_download_permission" };

  switch (file.mimeType) {
    case "application/vnd.google-apps.document":
    case "application/vnd.google-apps.presentation":
      return { kind: "export", exportMimeType: "text/plain" };
    case "application/vnd.google-apps.spreadsheet":
      // text/plain is NOT a supported Sheets export and 400s — text/csv is
      // the only plaintext-ish export, and only covers the first sheet.
      return { kind: "export", exportMimeType: "text/csv", note: "first_sheet_only" };
    case "application/vnd.google-apps.script":
    case "application/vnd.google-apps.drawing":
    case "application/vnd.google-apps.form":
    case "application/vnd.google-apps.site":
    case "application/vnd.google-apps.jam":
    case "application/vnd.google-apps.map":
      return { kind: "skip", reason: "unsupported_google_type" };
    case "application/pdf":
    case "application/msword":
    case "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    case "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet":
    case "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    case "application/vnd.ms-excel":
    case "application/vnd.ms-powerpoint":
      // No parser dependency exists in this project, and Drive's "copy then
      // export" conversion trick would mutate the user's own Drive — out of
      // scope for a v1.
      return { kind: "skip", reason: "no_parser" };
    default:
      break;
  }

  if (DOWNLOADABLE_TEXT_MIME_TYPES.has(file.mimeType)) {
    if (file.size && Number(file.size) > DOWNLOAD_MAX_BYTES) return { kind: "skip", reason: "too_large" };
    return { kind: "download" };
  }
  if (/^(image|video|audio)\//.test(file.mimeType) || /zip|x-tar|x-7z|x-rar/.test(file.mimeType)) {
    return { kind: "skip", reason: "binary" };
  }
  return { kind: "skip", reason: "unknown_mime" };
}

/** Strips tags from a downloaded text/html file. Deliberately not a real
 * HTML parser (none is in the dependency tree) — good enough for "give the
 * LLM the words", not for structure-sensitive extraction. Also used by
 * gmail/index.ts for HTML-only email bodies. */
export function stripHtml(html: string): string {
  return html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalizes whatever text was extracted before it's stored: BOM/CRLF
 * cleanup, collapsing excess blank lines, and a whitespace-boundary
 * truncation with a marker so downstream readers know it's partial. */
export function normalizeExtractedText(raw: string, maxChars: number): { text: string; truncated: boolean } {
  let text = raw.replace(/^﻿/, "").replace(/\r\n/g, "\n");
  text = text.replace(/\n{3,}/g, "\n\n").trim();
  if (text.length <= maxChars) return { text, truncated: false };
  const cut = text.slice(0, maxChars);
  const lastBreak = Math.max(cut.lastIndexOf(" "), cut.lastIndexOf("\n"));
  const truncated = (lastBreak > maxChars * 0.5 ? cut.slice(0, lastBreak) : cut).trimEnd();
  return { text: `${truncated}\n…[truncated]`, truncated: true };
}

/**
 * Executes an export/download plan. Non-retryable provider errors (an
 * over-size export, an unsupported conversion, a transient failure) all
 * resolve to `null` rather than throwing — one weird file must never fail
 * the whole sync. Doesn't route through googleFetch: export/download bodies
 * are plain text/CSV, not JSON, so this does its own minimal fetch+deadline
 * check instead of fighting that helper's JSON-parsing assumption. A single
 * attempt only — retrying a slow per-file request would eat the budget
 * meant for OTHER files in the same run.
 */
export async function fetchFileText(
  plan: TextPlan,
  fileId: string,
  options: { accessToken: string; deadline: FetchDeadline },
): Promise<string | null> {
  if (plan.kind === "skip") return null;
  if (options.deadline.expired()) throw new GoogleBudgetExhaustedError();

  const url =
    plan.kind === "export"
      ? `https://www.googleapis.com/drive/v3/files/${fileId}/export?mimeType=${encodeURIComponent(plan.exportMimeType)}&supportsAllDrives=true`
      : `https://www.googleapis.com/drive/v3/files/${fileId}?alt=media&supportsAllDrives=true`;

  try {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${options.accessToken}` } });
    if (!res.ok) {
      // e.g. 403 exportSizeLimitExceeded, 400 unsupported conversion — one
      // weird file must never fail the whole sync, but a silent empty body
      // with no trace is undebuggable, so at least log it.
      console.warn(`[google_drive] text ${plan.kind} failed for file ${fileId}: HTTP ${res.status}`);
      return null;
    }
    return await res.text();
  } catch (err) {
    console.warn(`[google_drive] text ${plan.kind} threw for file ${fileId}:`, err);
    return null; // network error on one file — never fails the run
  }
}
