import "server-only";
import { googleFetch } from "@/connectors/google/client";
import type { FetchDeadline } from "@/connectors/types";

const PEOPLE_API_BATCH_GET_URL = "https://people.googleapis.com/v1/people:batchGet";

// A nice-to-have enrichment, not core sync correctness — capped well below
// any real space's participant count so it can never consume a meaningful
// share of a run's request/time budget. One batchGet call covers the whole
// cap (People API's batchGet accepts far more than this per request), so
// this is one extra request per run, not one per sender.
const MAX_LOOKUPS_PER_RUN = 30;

export interface ResolvedPerson {
  displayName?: string;
  email?: string;
}

interface BatchGetResponse {
  responses?: Array<{
    requestedResourceName?: string;
    person?: {
      names?: Array<{ displayName?: string }>;
      emailAddresses?: Array<{ value?: string }>;
    };
  }>;
}

function toPersonResourceName(senderName: string): string {
  // Chat's `sender.name` ("users/<id>") and the People API's directory
  // resource name ("people/<id>") share the same numeric id for
  // Workspace-internal senders — this is the documented way Chat apps are
  // expected to resolve a sender's profile.
  return `people/${senderName.replace(/^users\//, "")}`;
}

/**
 * Resolves Chat message senders to a display name/email via the People
 * API's directory resource, in ONE batched request rather than one per
 * sender. Requires the `directory.readonly` scope (google/scopes.ts) —
 * absent that (e.g. an integration connected before this scope existed, or
 * an org that restricts the Directory API), every lookup fails and this
 * degrades to an empty map, never a thrown error: sender-name resolution
 * must never be able to fail a sync.
 */
export async function resolveSenderNames(
  senderIds: string[],
  options: { accessToken: string; deadline: FetchDeadline },
): Promise<Map<string, ResolvedPerson>> {
  const resolved = new Map<string, ResolvedPerson>();
  const uniqueIds = [...new Set(senderIds)].slice(0, MAX_LOOKUPS_PER_RUN);
  if (uniqueIds.length === 0) return resolved;

  const url = new URL(PEOPLE_API_BATCH_GET_URL);
  for (const id of uniqueIds) url.searchParams.append("resourceNames", toPersonResourceName(id));
  url.searchParams.set("personFields", "names,emailAddresses");

  try {
    const res = await googleFetch<BatchGetResponse>(url.toString(), {
      accessToken: options.accessToken,
      deadline: options.deadline,
      maxAttempts: 1,
    });
    for (const entry of res.responses ?? []) {
      if (!entry.requestedResourceName || !entry.person) continue; // no result for this id (not found, or outside the org)
      const senderId = `users/${entry.requestedResourceName.replace(/^people\//, "")}`;
      resolved.set(senderId, {
        displayName: entry.person.names?.[0]?.displayName,
        email: entry.person.emailAddresses?.[0]?.value,
      });
    }
  } catch (err) {
    console.warn("[google_chat] sender name resolution failed — actors will show as raw ids:", err);
  }
  return resolved;
}
