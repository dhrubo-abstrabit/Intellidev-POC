/**
 * Pure builders for every Drive v3 request this connector makes. Kept
 * separate from index.ts so the exact `q` string, `corpora`/`driveId`
 * matrix, and field masks are unit-testable without any network access.
 */

// The default File projection omits every field this connector's identity,
// dedupe, and event-type logic depends on (version, webViewLink, parents,
// lastModifyingUser, modifiedTime) — an explicit mask is mandatory. Notably
// `exportLinks` is excluded: it's a fat ~12-entry mimeType->URL map per
// Google-native file, and this connector constructs export URLs itself.
export const FILE_FIELDS =
  "id,name,mimeType,createdTime,modifiedTime,version,trashed,explicitlyTrashed," +
  "size,webViewLink,parents,driveId,shortcutDetails(targetId,targetMimeType)," +
  "lastModifyingUser(displayName,emailAddress),owners(displayName,emailAddress)," +
  "capabilities(canDownload)";

export const LIST_FIELDS = `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`;
export const FOLDER_FIELDS = "nextPageToken,files(id,name,parents)";
export const RESOLVE_FIELDS = "id,name,mimeType,trashed,driveId,capabilities(canListChildren)";

/** Drive's `q` grammar quotes string literals with single quotes and
 * escapes an embedded quote with a backslash — this is the ONLY place a
 * folder/file id is interpolated into a query string, so every caller must
 * route through this, even though source-url.ts's charset gate already
 * excludes the quote character as defense in depth. */
export function escapeDriveQueryLiteral(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

export const MAX_PARENTS_IN_QUERY = 30;

export function chunkParents(ids: string[], size = MAX_PARENTS_IN_QUERY): string[][] {
  const chunks: string[][] = [];
  for (let i = 0; i < ids.length; i += size) chunks.push(ids.slice(i, i + size));
  return chunks;
}

export interface CorporaParams {
  corpora: "user" | "drive";
  driveId?: string;
  includeItemsFromAllDrives?: true;
  supportsAllDrives: true;
}

/** `corpora=allDrives` is NEVER used anywhere in this connector — Google
 * documents `orderBy` as unsupported/ignored under it, and this connector's
 * whole truncation-safety argument depends on `orderBy=modifiedTime`
 * actually being honored (see index.ts). */
export function corporaParamsFor(driveId: string | null): CorporaParams {
  if (driveId) {
    return { corpora: "drive", driveId, includeItemsFromAllDrives: true, supportsAllDrives: true };
  }
  return { corpora: "user", supportsAllDrives: true };
}

/**
 * Builds the incremental `q` for the ordered, ascending-modifiedTime file
 * stream. `parentIds: null` means "no parent clause" — used for a
 * shared-drive root (corpora=drive already scopes it exactly) and for the
 * "broad" tier when a source's descendant-folder set is too large to fit
 * as an OR-clause (see index.ts's tier selection) — that tier instead
 * relies on client-side filtering against the cached folder set.
 */
export function buildIncrementalQuery(options: { floorIso: string; parentIds: string[] | null }): string {
  const clauses = [
    `modifiedTime >= '${escapeDriveQueryLiteral(options.floorIso)}'`,
    "mimeType != 'application/vnd.google-apps.folder'",
  ];
  if (options.parentIds && options.parentIds.length > 0) {
    const parentClause = options.parentIds.map((id) => `'${escapeDriveQueryLiteral(id)}' in parents`).join(" or ");
    clauses.push(`(${parentClause})`);
  }
  // Deliberately no `trashed = false` — a trashing that bumps modifiedTime
  // is how this connector's `file.trashed` event is detected at all (Drive
  // v3 has no cheaper deletion signal without switching to changes.list).
  return clauses.join(" and ");
}

/** `q` for one level of the descendant-folder BFS walk. */
export function buildFolderQuery(parentIds: string[]): string {
  const parentClause = parentIds.map((id) => `'${escapeDriveQueryLiteral(id)}' in parents`).join(" or ");
  return `mimeType = 'application/vnd.google-apps.folder' and trashed = false and (${parentClause})`;
}

/** `q` for the backfill stream over newly-discovered folders — order
 * doesn't matter here (the floor is frozen), so multiple parent chunks can
 * run independently without the truncation-safety concerns that rule out
 * chunking the incremental stream. */
export function buildBackfillQuery(options: { floorIso: string; parentIds: string[] }): string {
  const parentClause = options.parentIds.map((id) => `'${escapeDriveQueryLiteral(id)}' in parents`).join(" or ");
  return [
    `modifiedTime >= '${escapeDriveQueryLiteral(options.floorIso)}'`,
    "mimeType != 'application/vnd.google-apps.folder'",
    `(${parentClause})`,
  ].join(" and ");
}
