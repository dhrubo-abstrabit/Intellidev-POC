import "server-only";
import { googleFetch, GoogleBudgetExhaustedError } from "@/connectors/google/client";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorConfigError } from "@/connectors/errors";
import { googleChatConfigSchema } from "./config";
import { resolveSenderNames } from "./directory";
import type {
  AttachmentDraft,
  Connector,
  ConnectorCredentials,
  DownloadedAttachment,
  FetchContext,
  FetchDeadline,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

const CHAT_API_BASE = "https://chat.googleapis.com/v1";

// Bounds per-run cost: with a 45s deadline and ~1 request per page per
// space, this is far more headroom than any real project's message volume
// needs — the deadline check inside the loop is what actually protects a
// busy space, this cap only protects against something misbehaving.
const MAX_PAGES_PER_SPACE = 20;
const PAGE_SIZE = 100;
// Reserve enough of the deadline that a page already in flight can finish
// and get persisted, rather than getting cut off mid-request.
const RESERVE_MS = 5_000;
// Sender-name resolution is a nice-to-have enrichment, not core sync
// correctness — it only runs if there's still meaningfully more than one
// request's worth of budget left after fetching messages.
const RESOLVE_NAMES_RESERVE_MS = 3_000;

/** Mirrors Slack's channelCursors for the same reason: spaces post at
 * wildly different rates, so a single flat timestamp either re-scans quiet
 * spaces on every run or risks missing messages in busy ones. Exported so
 * the merged `google` connector can nest it under its own cursor verbatim —
 * see connectors/google/cursor.ts. */
export interface GoogleChatCursor {
  provider: "google_chat";
  v: 1;
  spaceCursors: Record<string, string>; // spaceName ("spaces/<id>") -> RFC3339 createTime of the latest message seen
}

/** Chat's `Attachment` resource — either an upload Chat itself hosts
 * (attachmentDataRef, downloaded via the Chat API's media endpoint) or a
 * file the message links from the sender's Drive (driveDataRef, downloaded
 * via Drive's own `alt=media`, same as connectors/google_drive does). */
interface ChatAttachment {
  name?: string;
  contentName?: string;
  contentType?: string;
  attachmentDataRef?: { resourceName?: string };
  driveDataRef?: { driveFileId?: string };
}

interface ChatMessage {
  name: string; // spaces/AAAA/messages/BBBB.BBBB — globally unique and stable
  sender?: { name?: string; displayName?: string; type?: string };
  createTime: string;
  text?: string;
  formattedText?: string;
  thread?: { name?: string };
  attachment?: ChatAttachment[];
}

function attachmentsToDrafts(attachments: ChatAttachment[] | undefined): AttachmentDraft[] | undefined {
  if (!attachments || attachments.length === 0) return undefined;
  const drafts = attachments
    .map((a): AttachmentDraft | undefined => {
      if (a.attachmentDataRef?.resourceName) {
        return {
          providerAttachmentId: a.attachmentDataRef.resourceName,
          filename: a.contentName,
          mimeType: a.contentType,
          downloadRef: { kind: "chat_media", resourceName: a.attachmentDataRef.resourceName },
        };
      }
      if (a.driveDataRef?.driveFileId) {
        return {
          providerAttachmentId: a.driveDataRef.driveFileId,
          filename: a.contentName,
          mimeType: a.contentType,
          downloadRef: { kind: "drive", fileId: a.driveDataRef.driveFileId },
        };
      }
      return undefined; // neither ref present — nothing to download
    })
    .filter((draft): draft is AttachmentDraft => draft !== undefined);
  return drafts.length > 0 ? drafts : undefined;
}

interface ChatMessagesResponse {
  messages?: ChatMessage[];
  nextPageToken?: string;
}

function parseCursor(raw: unknown): GoogleChatCursor {
  if (raw && typeof raw === "object" && (raw as { v?: unknown }).v === 1) {
    const spaceCursors = (raw as { spaceCursors?: unknown }).spaceCursors;
    if (spaceCursors && typeof spaceCursors === "object") {
      return { provider: "google_chat", v: 1, spaceCursors: spaceCursors as Record<string, string> };
    }
  }
  // Any shape we don't recognize (absent, stale v0, corrupted) is treated as
  // "no cursor yet" rather than a hard failure — a full re-fetch from epoch
  // is idempotent (raw_events' dedupe index absorbs it), just slower once.
  return { provider: "google_chat", v: 1, spaceCursors: {} };
}

/**
 * NOT registered in connectors/registry.ts anymore — the merged `google`
 * connector owns the OAuth handshake and delegates fetch/normalize here (see
 * connectors/google/index.ts). No OAuth methods or `disconnect` here at
 * all: Nango owns the handshake now, and google/index.ts's own disconnect
 * doesn't delegate to the sub-connectors, so an implementation here would
 * just be dead code.
 */
export const googleChatConnector: Connector<GoogleChatCursor> = {
  id: "google_chat",
  displayName: "Google Chat",

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    try {
      // Cheapest call that proves both the token and the chat.spaces scope:
      // list at most one space owned/joined by the connected account.
      await googleFetch(`${CHAT_API_BASE}/spaces?pageSize=1&filter=spaceType = "SPACE"`, {
        credentials,
        deadline: createDeadline(10_000),
        maxAttempts: 1,
      });
      return true;
    } catch {
      return false;
    }
  },

  async fetchSince(
    credentials: ConnectorCredentials,
    cursor: GoogleChatCursor | null,
    context: FetchContext,
  ): Promise<FetchResult<GoogleChatCursor>> {
    const parsedConfig = googleChatConfigSchema.safeParse(context.config);
    if (!parsedConfig.success) {
      // Structural garbage (not client-writable-safe defaults, but a config
      // that genuinely can't be interpreted) — surfaced to
      // integrations.last_error rather than a silent empty sync, which
      // would look identical to "this integration just has no spaces yet".
      throw new ConnectorConfigError(
        `Google Chat configuration is invalid: ${parsedConfig.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const config = parsedConfig.data;

    // Defensive re-parse rather than trusting the generic's static type:
    // integration_cursors.cursor is an untyped jsonb column at runtime, so a
    // corrupted or stale-shape value must degrade to "start over", not throw.
    const previousCursors = parseCursor(cursor).spaceCursors;
    // Drop cursor entries for spaces no longer configured — a stale cursor
    // for a removed space would just accumulate forever otherwise.
    const spaceCursors: Record<string, string> = {};
    for (const spaceName of config.spaceIds) {
      if (previousCursors[spaceName]) spaceCursors[spaceName] = previousCursors[spaceName];
    }

    const rawPayloads: RawPayload[] = [];
    let hasMore = false;

    for (const spaceName of config.spaceIds) {
      if (context.deadline.remainingMs() < RESERVE_MS) {
        hasMore = true;
        break;
      }

      const sinceIso = spaceCursors[spaceName] ?? new Date(0).toISOString();
      let latestSeen = sinceIso;
      let pageToken: string | undefined;
      let pages = 0;
      let spaceExhaustedBudget = false;

      try {
        do {
          if (context.deadline.remainingMs() < RESERVE_MS) {
            hasMore = true;
            break;
          }

          const url = new URL(`${CHAT_API_BASE}/${spaceName}/messages`);
          // orderBy=createTime asc is the API default, but set explicitly:
          // it's what makes a deadline-truncated run advance this space's
          // cursor forward with no gap — oldest-first means everything
          // already returned is safe to consider "seen".
          url.searchParams.set("orderBy", "createTime asc");
          // NOTE: Chat's documented filter grammar for messages.list is
          // `createTime > "<RFC3339>"` — not empirically verified against a
          // live space in this environment (see connectors/google/README's
          // "verify before trusting" list). If this turns out to be wrong,
          // the failure mode is a thrown API error per space, which is
          // caught below and skipped, not silent data loss.
          url.searchParams.set("filter", `createTime > "${sinceIso}"`);
          url.searchParams.set("pageSize", String(PAGE_SIZE));
          url.searchParams.set("showDeleted", "false");
          if (pageToken) url.searchParams.set("pageToken", pageToken);

          const res = await googleFetch<ChatMessagesResponse>(url.toString(), {
            credentials,
            deadline: context.deadline,
          });

          for (const message of res.messages ?? []) {
            // Card-only bot posts carry no prose — nothing for the
            // action-item pipeline to read.
            if (!message.text && !message.formattedText && !(message.attachment && message.attachment.length > 0)) {
              continue;
            }
            rawPayloads.push({
              providerEventId: message.name,
              occurredAt: new Date(message.createTime),
              payload: { ...message, space_name: spaceName },
            });
            if (message.createTime > latestSeen) latestSeen = message.createTime;
          }

          pageToken = res.nextPageToken;
          pages++;
        } while (pageToken && pages < MAX_PAGES_PER_SPACE);

        if (pageToken) hasMore = true; // didn't fully drain this space this run
      } catch (err) {
        if (err instanceof GoogleBudgetExhaustedError) {
          spaceExhaustedBudget = true;
          hasMore = true;
        } else {
          // One broken/inaccessible space must not abort the whole sync —
          // mirrors slack/index.ts's per-channel error handling.
          console.warn(`[google_chat] space ${spaceName} failed, skipping:`, err);
        }
      }

      spaceCursors[spaceName] = latestSeen;
      if (spaceExhaustedBudget) break; // deadline is global, not per-space — stop entirely
    }

    // Resolve sender names/emails via the People API directory — one
    // batched request covering every HUMAN sender collected this run,
    // AFTER all spaces are processed (not per-space), so a sender posting
    // in multiple spaces is only looked up once. I/O-adjacent, same reason
    // Slack resolves its user directory in fetchSince rather than
    // normalize(): normalize() stays pure and can only read what's already
    // attached to the payload.
    if (config.resolveSenderNames && context.deadline.remainingMs() > RESOLVE_NAMES_RESERVE_MS) {
      const senderIds = rawPayloads
        .map((raw) => (raw.payload as { sender?: { name?: string; displayName?: string; type?: string } }).sender)
        .filter((sender): sender is { name: string; type?: string } => Boolean(sender?.name && sender.type === "HUMAN" && !sender.displayName))
        .map((sender) => sender.name);

      if (senderIds.length > 0) {
        const resolved = await resolveSenderNames(senderIds, { credentials, deadline: context.deadline });
        if (resolved.size > 0) {
          for (const raw of rawPayloads) {
            const sender = (raw.payload as { sender?: { name?: string } }).sender;
            const match = sender?.name ? resolved.get(sender.name) : undefined;
            if (match) {
              raw.payload.sender_display_name = match.displayName;
              raw.payload.sender_email = match.email;
            }
          }
        }
      }
    }

    return {
      rawPayloads,
      nextCursor: { provider: "google_chat", v: 1, spaceCursors },
      hasMore,
    };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const message = raw.payload as {
      name: string;
      sender?: { name?: string; displayName?: string };
      text?: string;
      formattedText?: string;
      thread?: { name?: string };
      space_name: string;
      attachment?: ChatAttachment[];
      // Attached in fetchSince (I/O, allowed there) by directory.ts's
      // People API lookup — normalize() itself stays pure/no-I/O, so it can
      // only read what fetchSince already resolved. Absent when
      // resolveSenderNames is off, the lookup failed, or the sender wasn't
      // a HUMAN (e.g. a bot/app) — see directory.ts and CLAUDE.md for why
      // this can legitimately come back empty even when enabled.
      sender_display_name?: string;
      sender_email?: string;
    };

    const attachments = attachmentsToDrafts(message.attachment);

    // Previously `if (!message.text && !message.formattedText) return []`
    // dropped every attachment-only message — but fetchSince's own filter
    // (see the loop above) deliberately ADMITS a message with attachments
    // and no text, so that raw_events row produced zero normalized_events
    // rows. Mirror fetchSince's own condition here instead of a stricter one.
    if (!message.text && !message.formattedText && !attachments) return [];

    return [
      {
        type: "message.posted",
        actor: message.sender?.name,
        actorDisplay: message.sender_display_name ?? message.sender?.displayName,
        actorEmail: message.sender_email,
        resource: `gchat-space:${message.space_name}`,
        resourceType: "space",
        // A message whose only content is a file share has no text at all
        // — body must not be null, or the LLM prompt sees a blank event with
        // no clue anything was even shared.
        body: message.text ?? message.formattedText ?? (attachments ? `[shared ${attachments.length} file(s)]` : undefined),
        occurredAt: raw.occurredAt ?? new Date(),
        metadata: { space_name: message.space_name, thread_name: message.thread?.name },
        dedupeKey: `message.posted:${message.name}`,
        attachments,
      },
    ];
  },

  async downloadAttachment(
    credentials: ConnectorCredentials,
    downloadRef: Record<string, unknown>,
    deadline: FetchDeadline,
  ): Promise<DownloadedAttachment | null> {
    if (deadline.expired()) return null;

    const kind = downloadRef.kind as string | undefined;
    let url: string | undefined;
    if (kind === "chat_media" && typeof downloadRef.resourceName === "string") {
      url = `${CHAT_API_BASE}/media/${downloadRef.resourceName}?alt=media`;
    } else if (kind === "drive" && typeof downloadRef.fileId === "string") {
      // Same endpoint connectors/google_drive/text.ts's fetchFileText uses
      // for a "download" plan — reused here rather than importing that
      // module, to keep Chat's downloader dependency-free of Drive's.
      url = `https://www.googleapis.com/drive/v3/files/${downloadRef.fileId}?alt=media&supportsAllDrives=true`;
    }
    if (!url) return null;

    try {
      // Bypasses the proxy deliberately (see NANGO_MIGRATION_LOG.md D-004):
      // this is a raw binary body, and googleFetch does res.text() ->
      // JSON.parse (see connectors/google/client.ts) so it cannot carry
      // one. Single attempt only, same rationale as google_drive/text.ts's
      // fetchFileText: retrying a slow single attachment would eat the
      // budget meant for OTHER attachments in the same job run.
      const accessToken = await credentials.getAccessToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        console.warn(`[google_chat] attachment download failed: HTTP ${res.status}`);
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, mimeType: res.headers.get("content-type") ?? undefined };
    } catch (err) {
      console.warn("[google_chat] attachment download threw:", err);
      return null;
    }
  },
};
