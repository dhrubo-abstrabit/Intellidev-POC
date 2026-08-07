import "server-only";
import { googleAuthorizeUrl, exchangeGoogleCode, refreshGoogleTokens, revokeGoogleToken } from "@/connectors/google/oauth";
import { googleFetch, GoogleBudgetExhaustedError } from "@/connectors/google/client";
import { GMAIL_SCOPES } from "@/connectors/google/scopes";
import { createDeadline } from "@/connectors/deadline";
import { ConnectorConfigError } from "@/connectors/errors";
import { stripHtml } from "@/connectors/google_drive/text";
import { gmailConfigSchema } from "./config";
import { extractPlainText, header, stripQuotedReply } from "./mime";
import type { GmailMessagePart } from "./mime";
import type {
  Connector,
  ConnectorCredentials,
  FetchContext,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

const GMAIL_API_BASE = "https://gmail.googleapis.com/gmail/v1/users/me";

const RESERVE_MS = 5_000;
const MAX_LIST_PAGES = 10;
const MAX_MESSAGES_PER_RUN = 150;
// A 5-minute overlap absorbs Gmail's indexing lag and clock skew between
// `internalDate` and `after:<epochSeconds>`'s own resolution — the
// alternative (no overlap) risks silently dropping a message that hadn't
// finished indexing yet when the previous run's window closed.
// raw_events.provider_event_id dedupe absorbs the resulting re-reads for
// free, which is far cheaper than losing mail.
const OVERLAP_SECONDS = 300;
const DAY_MS = 24 * 60 * 60 * 1000;
// Matches the untruncated 200-event prompt this connector's clamp has to
// respect (see connectors/google_drive/normalize.ts's identical constant
// and its full rationale — services/action-items/generate.ts +
// lib/llm/anthropic.ts render every event's body into one un-truncated
// message).
const MAX_NORMALIZED_BODY_CHARS = 2000;

const SKIP_LABELS = new Set(["DRAFT", "SPAM", "TRASH", "CHAT"]);

interface GmailCursor {
  provider: "gmail";
  v: 1;
  /** Newest `internalDate` (epoch ms) among messages actually fetched.
   * Deliberately NO persisted pageToken: messages.list is newest-first with
   * no orderBy option, so a page token doesn't correspond to a stable
   * forward time position across separate function invocations. */
  lastInternalDateMs: number | null;
  bootstrappedAt?: string;
}

interface GmailListResponse {
  messages?: Array<{ id: string; threadId: string }>;
  nextPageToken?: string;
}

interface GmailMessage {
  id: string;
  threadId: string;
  labelIds?: string[];
  internalDate: string; // epoch ms, as a string
  payload?: GmailMessagePart;
}

function parseCursor(raw: unknown): GmailCursor {
  if (raw && typeof raw === "object" && (raw as { v?: unknown }).v === 1 && (raw as { provider?: unknown }).provider === "gmail") {
    const lastInternalDateMs = (raw as { lastInternalDateMs?: unknown }).lastInternalDateMs;
    const bootstrappedAt = (raw as { bootstrappedAt?: unknown }).bootstrappedAt;
    return {
      provider: "gmail",
      v: 1,
      lastInternalDateMs: typeof lastInternalDateMs === "number" ? lastInternalDateMs : null,
      bootstrappedAt: typeof bootstrappedAt === "string" ? bootstrappedAt : undefined,
    };
  }
  // Any unrecognized shape (absent, corrupted, a future version) degrades
  // to "no cursor yet" — a from-scratch bootstrap is idempotent via
  // raw_events' dedupe index, just slower once.
  return { provider: "gmail", v: 1, lastInternalDateMs: null };
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}\n…[truncated]`;
}

function parseFromHeader(value: string | undefined): { email?: string; displayName?: string } {
  if (!value) return {};
  const match = value.match(/^(.*?)\s*<([^>]+)>\s*$/);
  if (match) {
    const name = match[1].trim().replace(/^"(.*)"$/, "$1");
    return { displayName: name || undefined, email: match[2].trim() };
  }
  return { email: value.trim() };
}

function clampNormalizedBody(body: string | undefined): string | undefined {
  if (!body) return undefined;
  return body.length <= MAX_NORMALIZED_BODY_CHARS ? body : `${body.slice(0, MAX_NORMALIZED_BODY_CHARS)}\n…[truncated]`;
}

export const gmailConnector: Connector<GmailCursor> = {
  id: "gmail",
  displayName: "Gmail",
  requiresOAuth: true,

  getAuthorizeUrl(state: string): string {
    return googleAuthorizeUrl({ provider: "gmail", scopes: GMAIL_SCOPES, state });
  },

  async exchangeCode(code: string): Promise<ConnectorCredentials> {
    return exchangeGoogleCode("gmail", code, GMAIL_SCOPES);
  },

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return false;
    try {
      await googleFetch(`${GMAIL_API_BASE}/profile`, { accessToken, deadline: createDeadline(10_000), maxAttempts: 1 });
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
    cursor: GmailCursor | null,
    context: FetchContext,
  ): Promise<FetchResult<GmailCursor>> {
    const parsedConfig = gmailConfigSchema.safeParse(context.config);
    if (!parsedConfig.success) {
      throw new ConnectorConfigError(
        `Gmail configuration is invalid: ${parsedConfig.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const config = parsedConfig.data;
    const accessToken = credentials.tokens.access_token as string;
    const previousCursor = parseCursor(cursor);

    const windowStartEpochSec = previousCursor.lastInternalDateMs
      ? Math.floor(previousCursor.lastInternalDateMs / 1000) - OVERLAP_SECONDS
      : Math.floor((Date.now() - config.bootstrapDays * DAY_MS) / 1000);

    const queryParts = [config.query, `after:${windowStartEpochSec}`];
    if (!config.includeSent) queryParts.push("-in:sent"); // API-level filter, since normalize() has no access to config
    const q = queryParts.filter(Boolean).join(" ");

    // --- 1. List message stubs. Cheap ({id, threadId} only); newest-first. ---
    const stubs: Array<{ id: string; threadId: string }> = [];
    let pageToken: string | undefined;
    let pages = 0;
    let stoppedEarly = false;

    try {
      do {
        if (context.deadline.remainingMs() < RESERVE_MS) {
          stoppedEarly = true;
          break;
        }
        const url = new URL(`${GMAIL_API_BASE}/messages`);
        url.searchParams.set("q", q);
        url.searchParams.set("maxResults", "500");
        // includeSpamTrash left at its default (false) — never opted into.
        if (pageToken) url.searchParams.set("pageToken", pageToken);

        const res = await googleFetch<GmailListResponse>(url.toString(), { accessToken, deadline: context.deadline });
        for (const m of res.messages ?? []) stubs.push({ id: m.id, threadId: m.threadId });
        pageToken = res.nextPageToken;
        pages++;
      } while (pageToken && pages < MAX_LIST_PAGES);
      if (pageToken) stoppedEarly = true;
    } catch (err) {
      if (err instanceof GoogleBudgetExhaustedError) stoppedEarly = true;
      else throw err; // a list failure (vs a per-message one) is not something to silently swallow
    }

    // Reverse to (approximately) oldest-first: messages.list has no
    // `orderBy`, so this is what makes a deadline-truncated run advance the
    // time cursor FORWARD rather than stranding a gap between two runs.
    stubs.reverse();

    // --- 2. Fetch full message bodies, oldest-first, within budget. --------
    const rawPayloads: RawPayload[] = [];
    let maxInternalDateMsSeen = previousCursor.lastInternalDateMs ?? 0;

    for (const stub of stubs) {
      if (rawPayloads.length >= MAX_MESSAGES_PER_RUN || context.deadline.remainingMs() < RESERVE_MS) {
        stoppedEarly = true;
        break;
      }

      let message: GmailMessage;
      try {
        // format=full is required — format=metadata returns headers but no
        // payload.body.data, which is what the plain-text extraction needs.
        message = await googleFetch<GmailMessage>(`${GMAIL_API_BASE}/messages/${stub.id}?format=full`, {
          accessToken,
          deadline: context.deadline,
        });
      } catch (err) {
        if (err instanceof GoogleBudgetExhaustedError) {
          stoppedEarly = true;
          break;
        }
        // One unreadable message must not abort the whole sync — mirrors
        // slack/index.ts's per-channel error handling. Accepted, documented
        // limitation: if a later message in this run advances the cursor
        // past this one, a permanently-failing message could end up
        // orphaned outside the window. Rare enough not to engineer around.
        console.warn(`[gmail] failed to fetch message ${stub.id}, skipping:`, err);
        continue;
      }

      const internalDateMs = Number(message.internalDate);
      if (Number.isFinite(internalDateMs) && internalDateMs > maxInternalDateMsSeen) {
        maxInternalDateMsSeen = internalDateMs;
      }

      const plainText = extractPlainText(message.payload, stripHtml);
      const cleanedText = plainText ? stripQuotedReply(plainText) : undefined;
      const bodyExcerpt = cleanedText ? truncate(cleanedText, config.maxBodyChars) : undefined;

      rawPayloads.push({
        providerEventId: message.id, // plain messageId, NOT messageId:historyId — historyId changes on every label edit, which would re-ingest the same email every time someone stars it
        occurredAt: Number.isFinite(internalDateMs) ? new Date(internalDateMs) : undefined,
        payload: { ...message, body_excerpt: bodyExcerpt },
      });
    }

    return {
      rawPayloads,
      nextCursor: {
        provider: "gmail",
        v: 1,
        lastInternalDateMs: maxInternalDateMsSeen || null,
        bootstrappedAt: previousCursor.bootstrappedAt ?? new Date().toISOString(),
      },
      hasMore: stoppedEarly,
    };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const message = raw.payload as unknown as GmailMessage & { body_excerpt?: string };
    const labels = message.labelIds ?? [];
    if (labels.some((l) => SKIP_LABELS.has(l))) return [];

    const type = labels.includes("SENT") ? "email.sent" : "email.received";
    const subject = header(message.payload?.headers, "Subject");
    const { email, displayName } = parseFromHeader(header(message.payload?.headers, "From"));
    const internalDateMs = Number(message.internalDate);

    return [
      {
        type,
        actor: email,
        actorDisplay: displayName,
        actorEmail: email,
        resource: `gmail-thread:${message.threadId}`,
        // Thread-level, not message-level — so a whole conversation reads
        // as one thing to the action-item prompt, matching Slack's
        // channel-level (not message-level) resource grouping.
        resourceType: "email_thread",
        title: subject,
        body: clampNormalizedBody(message.body_excerpt),
        occurredAt: raw.occurredAt ?? (Number.isFinite(internalDateMs) ? new Date(internalDateMs) : new Date()),
        metadata: { message_id: message.id, thread_id: message.threadId, label_ids: labels },
        // Message-level, not thread-level — a distinct email is a distinct
        // fact, and Gmail message bodies are immutable once delivered
        // (unlike Drive files), so there's no autosave-style churn to
        // coalesce here.
        dedupeKey: `${type}:${message.id}`,
      },
    ];
  },

  async disconnect(credentials: ConnectorCredentials): Promise<void> {
    await revokeGoogleToken(credentials).catch(() => {});
  },
};
