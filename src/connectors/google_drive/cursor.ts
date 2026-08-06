/**
 * Cursor shape and the pure math around it — floor advancement, boundary
 * tracking, folder-set diffing. All pure so the highest-risk logic in this
 * connector (truncation-safe resume) is directly unit-testable.
 */

export interface DriveFileSummary {
  id: string;
  version: string;
  modifiedTime: string;
}

export interface GoogleDriveSourceCursor {
  /** RFC3339 UTC. INCLUSIVE lower bound for `modifiedTime >= …` — inclusive
   * so files sharing the boundary timestamp can never fall through a
   * deadline-truncated run; the resulting one-file overlap is absorbed by
   * raw_events' dedupe index. Advanced ONLY past files that were fully
   * processed (metadata fetched, text extraction attempted). */
  modifiedTimeFloor: string;
  /** `${fileId}:${version}` for every file whose modifiedTime equals the
   * new floor — the files an inclusive floor will re-list next run. Used to
   * skip their (expensive) text extraction on the re-list; dropping an
   * entry only costs a redundant export, never correctness. */
  boundary: string[];
  /** Cached descendant folder set including the source root itself. Keys
   * are folder ids; `n`=name, `p`=direct parent id (null for the root). */
  folders: Record<string, { n: string; p: string | null }>;
  folderSetRefreshedAt: string;
  /** True when the walk hit a cap — files in unvisited folders are
   * silently missing, so this is surfaced into normalize()'s metadata. */
  folderSetTruncated: boolean;
  /** Shared drive id this source lives in, or null for My Drive. */
  driveId: string | null;
  /** True when driveId === this source's own id — i.e. the pasted url was
   * a shared drive ROOT, which corpora=drive scopes exactly with no parent
   * clause needed at all. */
  isSharedDriveRoot: boolean;
  /** Folder ids discovered after the first walk (new subfolders, or
   * existing ones moved into scope) whose pre-existing files predate
   * modifiedTimeFloor and would otherwise be invisible forever. Drained via
   * a separate backfill query against a FROZEN backfillFloor. */
  pendingBackfillFolderIds: string[];
  /** RFC3339. Frozen at first sync (`now - initialLookbackDays`) —
   * deliberately never re-derived from a later config edit, so widening
   * the lookback window is an explicit decision, not a silent replay. */
  backfillFloor: string;
  /** Set when resolving the source 404s/403s — suppresses re-probing a
   * deleted/unshared folder every run; cleared on the next success. */
  unresolvedSince?: string;
}

export interface GoogleDriveCursor {
  provider: "google_drive";
  v: 1;
  sources: Record<string, GoogleDriveSourceCursor>;
}

export const FOLDER_SET_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
export const MAX_BOUNDARY_ENTRIES = 32;
export const MAX_DESCENDANT_FOLDERS = 500;
export const MAX_PENDING_BACKFILL_FOLDERS = 500;

export function emptyCursor(): GoogleDriveCursor {
  return { provider: "google_drive", v: 1, sources: {} };
}

/** Any shape not recognized (absent, a stale version, corrupted jsonb) is
 * treated as "no cursor yet" rather than a hard failure — a from-scratch
 * bootstrap is idempotent (raw_events' dedupe index absorbs re-ingestion),
 * just slower once, which is a far better failure mode than throwing out of
 * a sync job nobody is watching. */
export function parseCursor(raw: unknown): GoogleDriveCursor {
  if (raw && typeof raw === "object" && (raw as { v?: unknown }).v === 1 && (raw as { provider?: unknown }).provider === "google_drive") {
    const sources = (raw as { sources?: unknown }).sources;
    if (sources && typeof sources === "object") {
      return { provider: "google_drive", v: 1, sources: sources as GoogleDriveCursor["sources"] };
    }
  }
  return emptyCursor();
}

export function emptySourceCursor(nowIso: string, backfillFloor: string): GoogleDriveSourceCursor {
  return {
    modifiedTimeFloor: nowIso,
    boundary: [],
    folders: {},
    folderSetRefreshedAt: new Date(0).toISOString(),
    folderSetTruncated: false,
    driveId: null,
    isSharedDriveRoot: false,
    pendingBackfillFolderIds: [],
    backfillFloor,
  };
}

/** Drops cursor entries for sources no longer in config — a stale entry
 * for a removed source would just accumulate forever otherwise. */
export function pruneCursorSources(cursor: GoogleDriveCursor, configuredIds: string[]): GoogleDriveCursor {
  const configured = new Set(configuredIds);
  const sources: GoogleDriveCursor["sources"] = {};
  for (const [id, sourceCursor] of Object.entries(cursor.sources)) {
    if (configured.has(id)) sources[id] = sourceCursor;
  }
  return { ...cursor, sources };
}

export function isFolderSetStale(refreshedAtIso: string, nowMs: number, ttlMs: number = FOLDER_SET_TTL_MS): boolean {
  const refreshedAtMs = Date.parse(refreshedAtIso);
  if (Number.isNaN(refreshedAtMs)) return true;
  return nowMs - refreshedAtMs >= ttlMs;
}

/**
 * Advances the floor past every FULLY PROCESSED file, and records which
 * files sit exactly at the new floor (the "boundary") so a re-list of them
 * next run can skip re-extracting their text. Does nothing (returns the
 * previous floor unchanged) if no files were processed this run — a
 * deadline-truncated run with zero progress must not silently reset state.
 */
export function advanceFloor(options: {
  previousFloor: string;
  processedFiles: DriveFileSummary[];
}): { floor: string; boundary: string[] } {
  if (options.processedFiles.length === 0) {
    return { floor: options.previousFloor, boundary: [] };
  }
  const maxModifiedTime = options.processedFiles.reduce(
    (max, f) => (f.modifiedTime > max ? f.modifiedTime : max),
    options.processedFiles[0].modifiedTime,
  );
  const boundary = options.processedFiles
    .filter((f) => f.modifiedTime === maxModifiedTime)
    .map((f) => `${f.id}:${f.version}`)
    .slice(0, MAX_BOUNDARY_ENTRIES);
  return { floor: maxModifiedTime, boundary };
}

/** Which folder ids are newly visible since the last walk — these feed the
 * backfill queue, since their pre-existing files predate the incremental
 * floor and would otherwise never be seen. */
export function diffFolderSet(
  previous: Record<string, unknown>,
  next: Record<string, unknown>,
): { added: string[]; removed: string[] } {
  const previousIds = new Set(Object.keys(previous));
  const nextIds = new Set(Object.keys(next));
  return {
    added: [...nextIds].filter((id) => !previousIds.has(id)),
    removed: [...previousIds].filter((id) => !nextIds.has(id)),
  };
}

/** Builds "Parent/Child/name.ext" from the cached folder map. Cycle-guarded
 * because a truncated/corrupted map could otherwise loop forever — Drive
 * itself shouldn't produce a parent cycle, but this function must not
 * assume its input is trustworthy. Returns undefined (never throws) so
 * normalize() can fall back to the bare file name. */
export function buildFolderPath(folders: Record<string, { n: string; p: string | null }>, folderId: string | undefined): string | undefined {
  if (!folderId) return undefined;
  const segments: string[] = [];
  const visited = new Set<string>();
  let currentId: string | null = folderId;
  while (currentId) {
    if (visited.has(currentId)) return undefined; // cycle — bail rather than loop
    visited.add(currentId);
    const entry: { n: string; p: string | null } | undefined = folders[currentId];
    if (!entry) break; // walked off the edge of what we have cached
    segments.unshift(entry.n);
    currentId = entry.p;
  }
  return segments.length > 0 ? segments.join("/") : undefined;
}
