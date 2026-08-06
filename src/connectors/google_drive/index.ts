import "server-only";
import { googleAuthorizeUrl, exchangeGoogleCode, refreshGoogleTokens, revokeGoogleToken } from "@/connectors/google/oauth";
import { googleFetch, GoogleBudgetExhaustedError } from "@/connectors/google/client";
import { DRIVE_SCOPES } from "@/connectors/google/scopes";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorConfigError } from "@/connectors/errors";
import { googleDriveConfigSchema } from "./config";
import { buildIncrementalQuery, buildBackfillQuery, corporaParamsFor, chunkParents, LIST_FIELDS, RESOLVE_FIELDS, MAX_PARENTS_IN_QUERY } from "./query";
import {
  parseCursor,
  emptySourceCursor,
  pruneCursorSources,
  advanceFloor,
  diffFolderSet,
  buildFolderPath,
  isFolderSetStale,
  FOLDER_SET_TTL_MS,
  MAX_PENDING_BACKFILL_FOLDERS,
} from "./cursor";
import type { GoogleDriveCursor, GoogleDriveSourceCursor } from "./cursor";
import { walkDescendants } from "./folders";
import { planTextExtraction, fetchFileText, normalizeExtractedText, stripHtml } from "./text";
import { normalizeDriveEvent } from "./normalize";
import type {
  Connector,
  ConnectorCredentials,
  FetchContext,
  FetchDeadline,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

// Reserved headroom at every loop boundary for the caller's raw_events/
// normalized_events writes and cursor upsert that happen after fetchSince
// returns.
const RESERVE_MS = 6_000;
const MAX_LIST_PAGES = 10;
const MAX_FILES_PER_RUN = 200;
const MAX_BACKFILL_PAGES = 10;
const MAX_BACKFILL_FOLDERS_PER_RUN = 10;

interface DriveFileResolveInfo {
  id: string;
  name: string;
  mimeType: string;
  trashed?: boolean;
  driveId?: string;
}

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  createdTime: string;
  modifiedTime: string;
  version: string;
  trashed?: boolean;
  explicitlyTrashed?: boolean;
  size?: string;
  webViewLink?: string;
  parents?: string[];
  driveId?: string;
  lastModifyingUser?: { displayName?: string; emailAddress?: string };
  owners?: Array<{ displayName?: string; emailAddress?: string }>;
  capabilities?: { canDownload?: boolean };
}

interface DriveListResponse {
  nextPageToken?: string;
  incompleteSearch?: boolean;
  files?: DriveFile[];
}

async function resolveSource(sourceId: string, accessToken: string, deadline: FetchDeadline): Promise<DriveFileResolveInfo | null> {
  try {
    return await googleFetch<DriveFileResolveInfo>(
      `${DRIVE_FILES_URL}/${sourceId}?supportsAllDrives=true&fields=${RESOLVE_FIELDS}`,
      { accessToken, deadline, maxAttempts: 2 },
    );
  } catch {
    return null;
  }
}

export const googleDriveConnector: Connector<GoogleDriveCursor> = {
  id: "google_drive",
  displayName: "Google Drive",
  requiresOAuth: true,

  getAuthorizeUrl(state: string): string {
    return googleAuthorizeUrl({ provider: "google_drive", scopes: DRIVE_SCOPES, state });
  },

  async exchangeCode(code: string): Promise<ConnectorCredentials> {
    return exchangeGoogleCode("google_drive", code, DRIVE_SCOPES);
  },

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return false;
    try {
      await googleFetch(`https://www.googleapis.com/drive/v3/about?fields=user(displayName,emailAddress)`, {
        accessToken,
        deadline: createDeadline(10_000),
        maxAttempts: 1,
      });
      return true;
    } catch {
      return false;
    }
  },

  async refreshTokens(credentials: ConnectorCredentials): Promise<ConnectorCredentials> {
    return refreshGoogleTokens(credentials);
  },

  async fetchSince(
    credentials: ConnectorCredentials,
    cursor: GoogleDriveCursor | null,
    context: FetchContext,
  ): Promise<FetchResult<GoogleDriveCursor>> {
    const parsedConfig = googleDriveConfigSchema.safeParse(context.config);
    if (!parsedConfig.success) {
      throw new ConnectorConfigError(
        `Google Drive configuration is invalid: ${parsedConfig.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const config = parsedConfig.data;
    const accessToken = credentials.tokens.access_token as string;

    const driveCursor = pruneCursorSources(parseCursor(cursor), config.sources);
    const payloadsByProviderEventId = new Map<string, RawPayload>();
    let hasMore = false;
    let textFetchesSoFar = 0;

    for (const sourceId of config.sources) {
      if (context.deadline.remainingMs() < RESERVE_MS) {
        hasMore = true;
        break;
      }

      const nowIso = new Date().toISOString();
      let sourceCursor: GoogleDriveSourceCursor =
        driveCursor.sources[sourceId] ??
        emptySourceCursor(nowIso, new Date(Date.now() - config.initialLookbackDays * 24 * 60 * 60 * 1000).toISOString());

      // A source that failed to resolve last time isn't re-probed on every
      // single run — that would waste a request on an id that's still
      // deleted/unshared — but it IS re-tried once the folder-set TTL has
      // passed, in case access was restored.
      if (sourceCursor.unresolvedSince && !isFolderSetStale(sourceCursor.unresolvedSince, Date.now(), FOLDER_SET_TTL_MS)) {
        driveCursor.sources[sourceId] = sourceCursor;
        continue;
      }

      if (Object.keys(sourceCursor.folders).length === 0 || isFolderSetStale(sourceCursor.folderSetRefreshedAt, Date.now())) {
        const resolved = await resolveSource(sourceId, accessToken, context.deadline);
        if (!resolved || resolved.trashed || resolved.mimeType !== "application/vnd.google-apps.folder") {
          sourceCursor = { ...sourceCursor, unresolvedSince: nowIso };
          driveCursor.sources[sourceId] = sourceCursor;
          continue;
        }

        const driveId = resolved.driveId ?? null;
        const isSharedDriveRoot = driveId === sourceId;
        try {
          const walked = await walkDescendants(sourceId, resolved.name, { accessToken, deadline: context.deadline, driveId });
          const { added } = diffFolderSet(sourceCursor.folders, walked.folders);
          const pendingBackfillFolderIds = [...new Set([...sourceCursor.pendingBackfillFolderIds, ...added])].slice(
            0,
            MAX_PENDING_BACKFILL_FOLDERS,
          );
          sourceCursor = {
            ...sourceCursor,
            folders: walked.folders,
            folderSetRefreshedAt: nowIso,
            folderSetTruncated: walked.truncated,
            driveId,
            isSharedDriveRoot,
            pendingBackfillFolderIds,
            unresolvedSince: undefined,
          };
        } catch (err) {
          if (err instanceof GoogleBudgetExhaustedError) {
            driveCursor.sources[sourceId] = sourceCursor;
            hasMore = true;
            break;
          }
          throw err;
        }
      }

      // --- A) incremental ordered stream ---------------------------------
      const folderIds = Object.keys(sourceCursor.folders);
      const useParentClause = !sourceCursor.isSharedDriveRoot && folderIds.length <= MAX_PARENTS_IN_QUERY;
      const processed: { id: string; version: string; modifiedTime: string }[] = [];
      let pageToken: string | undefined;
      let pages = 0;
      let stoppedEarly = false;

      try {
        do {
          if (context.deadline.remainingMs() < RESERVE_MS || payloadsByProviderEventId.size >= MAX_FILES_PER_RUN) {
            stoppedEarly = true;
            break;
          }

          const url = new URL(DRIVE_FILES_URL);
          url.searchParams.set(
            "q",
            buildIncrementalQuery({ floorIso: sourceCursor.modifiedTimeFloor, parentIds: useParentClause ? folderIds : null }),
          );
          url.searchParams.set("fields", LIST_FIELDS);
          url.searchParams.set("orderBy", "modifiedTime");
          url.searchParams.set("pageSize", "100");
          for (const [key, value] of Object.entries(corporaParamsFor(sourceCursor.driveId))) url.searchParams.set(key, String(value));
          if (pageToken) url.searchParams.set("pageToken", pageToken);

          const res = await googleFetch<DriveListResponse>(url.toString(), { accessToken, deadline: context.deadline });
          if (res.incompleteSearch) {
            console.warn(`[google_drive] incompleteSearch for source ${sourceId} — this run's results may be partial`);
          }

          for (const file of res.files ?? []) {
            if (context.deadline.remainingMs() < RESERVE_MS) {
              stoppedEarly = true;
              break;
            }
            if (!useParentClause && !sourceCursor.isSharedDriveRoot) {
              const inScope = (file.parents ?? []).some((p) => folderIds.includes(p));
              if (!inScope) continue;
            }

            const isBoundaryFile = sourceCursor.boundary.includes(`${file.id}:${file.version}`);
            const plan = planTextExtraction(
              file,
              { extractText: config.extractText, maxTextFetchesPerRun: config.maxTextFetchesPerRun, textFetchesSoFar },
              { isBoundaryFile, deadline: context.deadline },
            );

            let textExcerpt: string | undefined;
            let textSource: "export" | "download" | undefined;
            let textTruncated: boolean | undefined;
            let textNote: string | undefined;
            if (plan.kind !== "skip") {
              textFetchesSoFar++;
              const rawText = await fetchFileText(plan, file.id, { accessToken, deadline: context.deadline });
              if (rawText !== null) {
                const cleaned = plan.kind === "download" && file.mimeType === "text/html" ? stripHtml(rawText) : rawText;
                const { text, truncated } = normalizeExtractedText(cleaned, config.maxTextChars);
                textExcerpt = text;
                textTruncated = truncated;
                textSource = plan.kind;
                if (plan.kind === "export" && plan.note) textNote = plan.note;
              }
            }

            const providerEventId = `${file.id}:${file.version}`;
            payloadsByProviderEventId.set(providerEventId, {
              providerEventId,
              occurredAt: new Date(file.modifiedTime),
              payload: {
                ...file,
                _sourceId: sourceId,
                _mode: "incremental",
                _floor: sourceCursor.modifiedTimeFloor,
                _folderPath: buildFolderPath(sourceCursor.folders, file.parents?.[0]),
                _folderSetTruncated: sourceCursor.folderSetTruncated,
                text_excerpt: textExcerpt,
                text_source: textSource,
                text_mime_type: plan.kind === "export" ? plan.exportMimeType : file.mimeType,
                text_skipped_reason: plan.kind === "skip" ? plan.reason : undefined,
                text_truncated: textTruncated,
                text_note: textNote,
              },
            });
            processed.push({ id: file.id, version: file.version, modifiedTime: file.modifiedTime });
          }

          if (stoppedEarly) break;
          pageToken = res.nextPageToken;
          pages++;
        } while (pageToken && pages < MAX_LIST_PAGES);

        if (pageToken) stoppedEarly = true; // more pages exist but we stopped (page cap or loop exit)
      } catch (err) {
        if (err instanceof GoogleBudgetExhaustedError) {
          stoppedEarly = true;
        } else {
          // One source's listing failing (e.g. a permission change) must
          // not abort the whole sync — mirrors slack/index.ts's per-channel
          // handling.
          console.warn(`[google_drive] source ${sourceId} incremental listing failed, skipping:`, err);
        }
      }

      const { floor, boundary } = advanceFloor({ previousFloor: sourceCursor.modifiedTimeFloor, processedFiles: processed });
      sourceCursor = { ...sourceCursor, modifiedTimeFloor: floor, boundary };
      if (stoppedEarly) hasMore = true;

      // --- B) backfill queue for newly-discovered folders -----------------
      if (sourceCursor.pendingBackfillFolderIds.length > 0 && context.deadline.remainingMs() >= RESERVE_MS) {
        const idsToProcess = sourceCursor.pendingBackfillFolderIds.slice(0, MAX_BACKFILL_FOLDERS_PER_RUN);
        const stillPending = new Set(sourceCursor.pendingBackfillFolderIds.slice(MAX_BACKFILL_FOLDERS_PER_RUN));
        let backfillBudgetExhausted = false;

        for (const parentChunk of chunkParents(idsToProcess)) {
          if (backfillBudgetExhausted) {
            for (const id of parentChunk) stillPending.add(id);
            continue;
          }

          let backfillPageToken: string | undefined;
          let backfillPages = 0;
          let drainedFully = true;
          try {
            do {
              if (context.deadline.remainingMs() < RESERVE_MS) {
                drainedFully = false;
                break;
              }
              const url = new URL(DRIVE_FILES_URL);
              url.searchParams.set("q", buildBackfillQuery({ floorIso: sourceCursor.backfillFloor, parentIds: parentChunk }));
              url.searchParams.set("fields", LIST_FIELDS);
              url.searchParams.set("pageSize", "100");
              for (const [key, value] of Object.entries(corporaParamsFor(sourceCursor.driveId))) url.searchParams.set(key, String(value));
              if (backfillPageToken) url.searchParams.set("pageToken", backfillPageToken);

              const res = await googleFetch<DriveListResponse>(url.toString(), { accessToken, deadline: context.deadline });
              for (const file of res.files ?? []) {
                const providerEventId = `${file.id}:${file.version}`;
                if (payloadsByProviderEventId.has(providerEventId)) continue; // already seen via the incremental stream
                payloadsByProviderEventId.set(providerEventId, {
                  providerEventId,
                  occurredAt: new Date(file.modifiedTime),
                  payload: {
                    ...file,
                    _sourceId: sourceId,
                    _mode: "backfill",
                    _folderPath: buildFolderPath(sourceCursor.folders, file.parents?.[0]),
                    _folderSetTruncated: sourceCursor.folderSetTruncated,
                  },
                });
              }
              backfillPageToken = res.nextPageToken;
              backfillPages++;
            } while (backfillPageToken && backfillPages < MAX_BACKFILL_PAGES);
            if (backfillPageToken) drainedFully = false; // hit the page cap with more left
          } catch (err) {
            drainedFully = false;
            if (err instanceof GoogleBudgetExhaustedError) {
              backfillBudgetExhausted = true;
            } else {
              console.warn(`[google_drive] backfill for source ${sourceId} failed on a folder chunk:`, err);
            }
          }
          if (!drainedFully) {
            for (const id of parentChunk) stillPending.add(id);
          }
        }

        sourceCursor = { ...sourceCursor, pendingBackfillFolderIds: [...stillPending] };
        if (stillPending.size > 0) hasMore = true;
      } else if (sourceCursor.pendingBackfillFolderIds.length > 0) {
        hasMore = true; // ran out of budget before even starting the backfill drain
      }

      driveCursor.sources[sourceId] = sourceCursor;
    }

    return { rawPayloads: [...payloadsByProviderEventId.values()], nextCursor: driveCursor, hasMore };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    return normalizeDriveEvent(raw);
  },

  async disconnect(credentials: ConnectorCredentials): Promise<void> {
    await revokeGoogleToken(credentials).catch(() => {});
  },
};
