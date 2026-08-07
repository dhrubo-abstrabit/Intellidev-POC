import type { NormalizedEventDraft, RawPayload } from "@/connectors/types";

// Matches the untruncated 200-event prompt in services/action-items/
// generate.ts + lib/llm/anthropic.ts: MAX_EVENTS_PER_RUN events are each
// rendered as "title — body" into a single user message with NO truncation
// anywhere downstream. At 8000 chars/body that's ~400k tokens worst case —
// over Haiku's context window, so an unclamped Drive backlog would hard-
// fail the LLM job. This clamp is what stands between the two.
export const MAX_BODY_CHARS = 2000;

export function utcHourBucket(modifiedTimeIso: string): string {
  return modifiedTimeIso.slice(0, 13); // "2026-08-06T14"
}

export function clampBody(body: string | undefined, maxChars: number = MAX_BODY_CHARS): string | undefined {
  if (!body) return undefined;
  return body.length <= maxChars ? body : `${body.slice(0, maxChars)}\n…[truncated]`;
}

interface DriveNormalizePayload {
  id: string;
  name: string;
  mimeType: string;
  version: string;
  createdTime: string;
  modifiedTime: string;
  trashed?: boolean;
  explicitlyTrashed?: boolean;
  webViewLink?: string;
  parents?: string[];
  size?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  // Attached by fetchSince (I/O-adjacent, mirrors Slack's text_resolved
  // pattern) so this function stays pure/no-I/O:
  _sourceId: string;
  _mode: "incremental" | "backfill";
  _floor?: string;
  _folderPath?: string;
  _folderSetTruncated?: boolean;
  text_excerpt?: string;
  text_source?: "export" | "download";
  text_mime_type?: string;
  text_skipped_reason?: string;
  text_truncated?: boolean;
  text_note?: string;
}

function selectType(file: DriveNormalizePayload): string | null {
  if (file.mimeType === "application/vnd.google-apps.folder") return null; // defense in depth; q already excludes folders
  if (file.mimeType === "application/vnd.google-apps.shortcut") return null; // its target is reported on its own, or wasn't shared
  if (!file.id || !file.modifiedTime || !file.version) return null; // can't key this payload — guard against a mask regression

  if (file.trashed) {
    // A file trashed long before the incremental floor existed isn't
    // "activity" — it only surfaces here because the backfill stream has no
    // floor-relative context.
    return file._mode === "backfill" ? null : "file.trashed";
  }
  // Prefer the _floor comparison over `createdTime === modifiedTime`: Docs
  // bumps modifiedTime on the very first keystroke, so the equality
  // heuristic misclassifies nearly every new Google Doc as an update.
  if (file._floor && file.createdTime >= file._floor) return "file.created";
  if (file.createdTime === file.modifiedTime) return "file.created";
  return "file.updated";
}

export function normalizeDriveEvent(raw: RawPayload): NormalizedEventDraft[] {
  const file = raw.payload as unknown as DriveNormalizePayload;
  const type = selectType(file);
  if (!type) return [];

  const title = file._folderPath ? `${file._folderPath}/${file.name}` : file.name;
  const clampedTitle = title.length > 200 ? `…/${title.slice(-197)}` : title;

  const dedupeKey =
    type === "file.updated"
      ? `file.updated:${file.id}:${utcHourBucket(file.modifiedTime)}`
      : `${type}:${file.id}`;

  return [
    {
      type,
      actor: file.lastModifyingUser?.emailAddress ?? file.owners?.[0]?.emailAddress,
      actorDisplay: file.lastModifyingUser?.displayName ?? file.owners?.[0]?.displayName,
      actorEmail: file.lastModifyingUser?.emailAddress ?? file.owners?.[0]?.emailAddress,
      resource: `gdrive-file:${file.id}`,
      resourceType: "file",
      resourceUrl: file.webViewLink ?? `https://drive.google.com/file/d/${file.id}/view`,
      title: clampedTitle,
      body: clampBody(file.text_excerpt),
      occurredAt: raw.occurredAt ?? new Date(file.modifiedTime),
      metadata: {
        file_id: file.id,
        mime_type: file.mimeType,
        source_id: file._sourceId,
        folder_path: file._folderPath,
        parents: file.parents,
        version: file.version,
        size: file.size,
        trashed: file.trashed ?? false,
        explicitly_trashed: file.explicitlyTrashed ?? false,
        text_source: file.text_source,
        text_mime_type: file.text_mime_type,
        text_skipped_reason: file.text_skipped_reason,
        text_truncated: file.text_truncated,
        text_note: file.text_note,
        folder_set_truncated: file._folderSetTruncated ?? false,
        mode: file._mode,
      },
      dedupeKey,
    },
  ];
}
