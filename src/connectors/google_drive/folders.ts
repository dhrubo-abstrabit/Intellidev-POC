import "server-only";
import { googleFetch, GoogleBudgetExhaustedError } from "@/connectors/google/client";
import { buildFolderQuery, chunkParents, corporaParamsFor, FOLDER_FIELDS } from "./query";
import { MAX_DESCENDANT_FOLDERS } from "./cursor";
import type { FetchDeadline } from "@/connectors/types";

const MAX_FOLDER_DEPTH = 10;
const MAX_FOLDER_WALK_REQUESTS = 20;
const DRIVE_FILES_URL = "https://www.googleapis.com/drive/v3/files";

interface FolderListResponse {
  nextPageToken?: string;
  files?: Array<{ id: string; name: string; parents?: string[] }>;
}

export interface WalkResult {
  folders: Record<string, { n: string; p: string | null }>;
  truncated: boolean;
}

/**
 * Breadth-first walk of every folder nested under `rootId` (inclusive),
 * batching each level's parent ids into `in parents` OR-chunks. Bounded on
 * three axes — depth, total requests, and total folders found — so a
 * pathological tree degrades to "truncated: true" (surfaced into
 * normalize()'s metadata) rather than consuming the whole run's budget.
 * `rootName` seeds the root's own display name, since Drive's folder-query
 * results never include the folder being walked FROM, only its children.
 */
export async function walkDescendants(
  rootId: string,
  rootName: string,
  options: { accessToken: string; deadline: FetchDeadline; driveId: string | null },
): Promise<WalkResult> {
  const folders: Record<string, { n: string; p: string | null }> = { [rootId]: { n: rootName, p: null } };
  let frontier = [rootId];
  let requests = 0;
  let truncated = false;

  for (let depth = 0; depth < MAX_FOLDER_DEPTH && frontier.length > 0; depth++) {
    const nextFrontier: string[] = [];

    for (const parentChunk of chunkParents(frontier)) {
      if (requests >= MAX_FOLDER_WALK_REQUESTS || options.deadline.expired()) {
        truncated = true;
        break;
      }

      let pageToken: string | undefined;
      do {
        if (requests >= MAX_FOLDER_WALK_REQUESTS || options.deadline.expired()) {
          truncated = true;
          break;
        }
        const url = new URL(DRIVE_FILES_URL);
        url.searchParams.set("q", buildFolderQuery(parentChunk));
        url.searchParams.set("fields", FOLDER_FIELDS);
        url.searchParams.set("pageSize", "200");
        for (const [key, value] of Object.entries(corporaParamsFor(options.driveId))) {
          url.searchParams.set(key, String(value));
        }
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        let res: FolderListResponse;
        try {
          res = await googleFetch<FolderListResponse>(url.toString(), {
            accessToken: options.accessToken,
            deadline: options.deadline,
          });
        } catch (err) {
          if (err instanceof GoogleBudgetExhaustedError) {
            truncated = true;
            break;
          }
          throw err;
        }
        requests++;

        for (const folder of res.files ?? []) {
          if (folders[folder.id]) continue; // already visited (e.g. multi-parent folder)
          if (Object.keys(folders).length >= MAX_DESCENDANT_FOLDERS) {
            truncated = true;
            break;
          }
          const matchedParent = folder.parents?.find((p) => parentChunk.includes(p)) ?? parentChunk[0];
          folders[folder.id] = { n: folder.name, p: matchedParent };
          nextFrontier.push(folder.id);
        }

        pageToken = res.nextPageToken;
      } while (pageToken && !truncated);

      if (truncated) break;
    }

    if (truncated) break;
    frontier = nextFrontier;
  }

  if (frontier.length > 0) truncated = true; // hit MAX_FOLDER_DEPTH with more to walk

  return { folders, truncated };
}
