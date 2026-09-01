import "server-only";
import { createDeadline } from "@/connectors/deadline";
import { nangoProxy, BudgetExhaustedError } from "@/lib/nango/client";
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

// The scope list Nango's `slack` integration must be configured with (see
// NANGO_MIGRATION_LOG.md — this codebase no longer builds an authorize URL
// itself, Nango does). Kept here as the source of truth for what this
// connector's fetch code actually depends on.
// conversations.list is called with types: "public_channel,private_channel",
// which needs channels:read (public) AND groups:read (private) — history
// scopes alone only cover reading messages in channels the bot can already
// see, not listing which private channels exist in the first place.
export const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "team:read",
  // Needed to download a shared file's bytes via url_private_download — see
  // downloadAttachment() below. Per CLAUDE.md's "scope changes don't
  // retro-apply" rule, an already-connected workspace needs an explicit
  // disconnect + reconnect before this actually lands on its token; editing
  // this list alone does nothing for existing grants. Must also be added in
  // the Slack app dashboard (OAuth & Permissions -> Bot Token Scopes) AND
  // in Nango's `slack` integration config.
  "files:read",
];

/** Every Slack Web API response shares `ok`/`error`; the rest is a union of
 * whatever fields the specific methods this connector calls can return —
 * loosely typed rather than one interface per method. */
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  team?: string; // auth.test's team NAME (not the {id,name} object oauth.v2.access used to return)
  team_id?: string;
  url?: string; // auth.test's `https://<subdomain>.slack.com/` — the team's permalink domain
  channels?: Array<{ id: string; name?: string; is_member?: boolean }>;
  messages?: Array<{ ts: string } & Record<string, unknown>>;
  members?: Array<{
    id: string;
    name?: string;
    real_name?: string;
    profile?: { display_name?: string; email?: string };
  }>;
  response_metadata?: { next_cursor?: string };
}

/** Every JSON call this connector makes, routed through Nango's proxy — see
 * NANGO_MIGRATION_LOG.md D-007: Nango owns retry/backoff (it honors Slack's
 * `retry-after` natively), so there's no hand-rolled 429 loop here anymore.
 * Slack's Web API accepts GET with query-string params for every method
 * this connector calls (only binary file uploads require POST), so this
 * collapses what used to be separate Post/Get helpers into one. */
async function slackApi(
  method: string,
  params: Record<string, string>,
  credentials: ConnectorCredentials,
  deadline: FetchDeadline,
): Promise<SlackApiResponse> {
  return nangoProxy<SlackApiResponse>({
    connectionId: credentials.connectionId,
    providerConfigKey: credentials.providerConfigKey,
    endpoint: `/${method}`,
    params,
    deadline,
  });
}

/** One users.list pass per sync (paginated), not one users.info call per
 * message — the per-message actor is just an id, so this resolves the whole
 * directory once, cheaply, using the users:read scope already in
 * BOT_SCOPES. Email is deliberately not requested here: it needs the
 * separate users:read.email scope, which an already-connected workspace
 * would need a disconnect+reconnect to pick up (see CLAUDE.md > Slack
 * connector specifics) — display_name/real_name/name all come from
 * users:read alone. A failed or partial directory degrades to no
 * enrichment, not a thrown error: a broken lookup shouldn't block message
 * sync. */
const USER_DIRECTORY_PAGE_LIMIT = 10; // 10 * 200 = 2000 users — comfortably above any real workspace

async function fetchUserDirectory(
  credentials: ConnectorCredentials,
  deadline: FetchDeadline,
): Promise<Map<string, { displayName?: string }>> {
  const directory = new Map<string, { displayName?: string }>();
  let cursor = "";
  for (let page = 0; page < USER_DIRECTORY_PAGE_LIMIT; page++) {
    const res = await slackApi("users.list", { limit: "200", ...(cursor ? { cursor } : {}) }, credentials, deadline);
    if (!res.ok) break;
    for (const user of res.members ?? []) {
      const displayName = user.profile?.display_name || user.real_name || user.name;
      directory.set(user.id, { displayName });
    }
    cursor = res.response_metadata?.next_cursor ?? "";
    if (!cursor) break;
  }
  return directory;
}

// <@U123>, <@U123|somelabel> (Slack still sends the |label form on older
// messages even though clients no longer show it), <#C123|channel-name>,
// and <!here>/<!channel>/<!everyone>.
const USER_MENTION_PATTERN = /<@([A-Z0-9]+)(?:\|[^>]*)?>/g;
const CHANNEL_MENTION_PATTERN = /<#[A-Z0-9]+\|([^>]*)>/g;
const SPECIAL_MENTION_PATTERN = /<!(here|channel|everyone)>/g;

/** Slack's raw message text carries mentions as opaque ids (`<@U0BKD91TKFW>`)
 * — its own clients resolve these for display but the Web API never does.
 * Resolved here (I/O-adjacent: needs the directory fetchSince already
 * built) rather than in normalize(), which stays pure/no-I/O. Channel
 * mentions need no directory lookup — Slack already inlines the name after
 * the `|`. */
function resolveMentions(text: string, directory: Map<string, { displayName?: string }>): string {
  return text
    .replace(USER_MENTION_PATTERN, (match, userId: string) => {
      const displayName = directory.get(userId)?.displayName;
      return displayName ? `@${displayName}` : match;
    })
    .replace(CHANNEL_MENTION_PATTERN, (_match, channelName: string) => `#${channelName}`)
    .replace(SPECIAL_MENTION_PATTERN, (_match, kind: string) => `@${kind}`);
}

/** One cursor per project connector (scope_key='default'), internally
 * tracking each channel's own resume point — Slack channels post at very
 * different rates, so a single flat timestamp would either re-fetch quiet
 * channels constantly or miss messages in busy ones. */
interface SlackCursor {
  provider: "slack";
  channelCursors: Record<string, string>; // channelId -> oldest `ts` seen
}

/** Slack's files[] entry, as embedded verbatim in a `file_share` message
 * (see fetchSince's `...message` spread). Only the fields normalize() and
 * downloadAttachment() actually read. */
interface SlackFile {
  id: string;
  name?: string;
  title?: string;
  mimetype?: string;
  size?: number;
  // "hosted" is a normal upload with real bytes behind url_private_download.
  // "external" (a linked Google Drive/Dropbox file, no Slack-hosted bytes)
  // and "tombstone" (the uploader deleted it) both have nothing to download.
  mode?: string;
  url_private_download?: string;
}

// Bookkeeping subtypes carry no attachments and aren't "activity" for the
// action-item pipeline — everything else (notably `file_share`, which has no
// subtype-specific meaning beyond "this message has files[]", and
// `thread_broadcast`) must pass through. Inverted from the old `if
// (message.subtype) return []` blanket check, which silently dropped every
// file upload along with its attachments — see CLAUDE.md/the plan for why
// this was a real bug, not just a missed feature.
const BOOKKEEPING_SUBTYPES = new Set([
  "channel_join",
  "channel_leave",
  "channel_topic",
  "channel_purpose",
  "channel_name",
  "channel_archive",
  "channel_unarchive",
  "channel_convert_to_private",
  "channel_convert_to_public",
  "group_join",
  "group_leave",
  "group_topic",
  "group_purpose",
  "group_name",
  "group_archive",
  "group_unarchive",
  "pinned_item",
  "unpinned_item",
  "bot_add",
  "bot_remove",
  "reminder_add",
]);

function filesToAttachmentDrafts(files: SlackFile[] | undefined): AttachmentDraft[] | undefined {
  if (!files || files.length === 0) return undefined;
  const drafts = files
    .filter((file) => file.mode !== "tombstone" && file.mode !== "external" && file.url_private_download)
    .map((file): AttachmentDraft => ({
      providerAttachmentId: file.id,
      filename: file.title || file.name,
      mimeType: file.mimetype,
      sizeBytes: file.size,
      downloadRef: { url_private_download: file.url_private_download },
    }));
  return drafts.length > 0 ? drafts : undefined;
}

// Reserved headroom at every loop boundary for the caller's raw_events/
// normalized_events writes and cursor upsert that happen after fetchSince
// returns — same pattern as every other connector. Slack's fetchSince had
// no deadline awareness at all before this migration (documented as an
// accepted omission in connectors/types.ts); it needs one now because
// nangoProxy requires a real FetchDeadline to bound Nango's own retries.
const RESERVE_MS = 5_000;

export const slackConnector: Connector<SlackCursor> = {
  id: "slack",
  displayName: "Slack",
  nangoProviderConfigKey: "slack",

  async identify(credentials: ConnectorCredentials) {
    const data = await slackApi("auth.test", {}, credentials, createDeadline(10_000));
    if (!data.ok || !data.team_id) {
      throw new Error(`Slack auth.test failed: ${data.error ?? "no team_id in response"}`);
    }
    return {
      externalAccountId: data.team_id,
      externalAccountLabel: data.team,
      // Trim the trailing slash so it composes cleanly into a permalink path
      // (`${accountDomain}/archives/${channelId}/p${ts}`).
      accountDomain: data.url?.replace(/\/$/, ""),
    };
  },

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    try {
      const data = await slackApi("auth.test", {}, credentials, createDeadline(10_000));
      return Boolean(data.ok);
    } catch {
      return false;
    }
  },

  async fetchSince(
    credentials: ConnectorCredentials,
    cursor: SlackCursor | null,
    context: FetchContext,
  ): Promise<FetchResult<SlackCursor>> {
    const channelCursors = { ...(cursor?.channelCursors ?? {}) };
    const rawPayloads: RawPayload[] = [];
    let hasMore = false;

    const userDirectory = await fetchUserDirectory(credentials, context.deadline).catch((err: unknown) => {
      console.warn("[slack] failed to fetch user directory — actors will show as raw ids:", err);
      return new Map<string, { displayName?: string }>();
    });

    if (context.deadline.remainingMs() < RESERVE_MS) {
      return { rawPayloads: [], nextCursor: { provider: "slack", channelCursors }, hasMore: true };
    }

    const channelsRes = await slackApi(
      "conversations.list",
      { types: "public_channel,private_channel", limit: "200" },
      credentials,
      context.deadline,
    );
    if (!channelsRes.ok) {
      throw new Error(`Slack conversations.list failed: ${channelsRes.error ?? "unknown error"}`);
    }

    for (const channel of channelsRes.channels ?? []) {
      if (!channel.is_member) continue; // bot must be invited to the channel to read history
      if (context.deadline.remainingMs() < RESERVE_MS) {
        hasMore = true;
        break;
      }

      const oldest = channelCursors[channel.id];
      let historyRes: SlackApiResponse;
      try {
        historyRes = await slackApi(
          "conversations.history",
          { channel: channel.id, ...(oldest ? { oldest } : {}), limit: "200" },
          credentials,
          context.deadline,
        );
      } catch (err) {
        if (err instanceof BudgetExhaustedError) {
          hasMore = true;
          break;
        }
        // Don't let one broken/archived channel abort the whole sync.
        continue;
      }
      if (!historyRes.ok) continue;

      let highestTs = oldest;
      for (const message of historyRes.messages ?? []) {
        const actorId = typeof message.user === "string" ? message.user : undefined;
        const actorInfo = actorId ? userDirectory.get(actorId) : undefined;
        rawPayloads.push({
          providerEventId: `${channel.id}:${message.ts}`,
          occurredAt: new Date(Number(message.ts) * 1000),
          payload: {
            ...message,
            channel_id: channel.id,
            channel_name: channel.name,
            user_display_name: actorInfo?.displayName,
            text_resolved: typeof message.text === "string" ? resolveMentions(message.text, userDirectory) : undefined,
          },
        });
        if (!highestTs || Number(message.ts) > Number(highestTs)) {
          highestTs = message.ts;
        }
      }
      if (highestTs) channelCursors[channel.id] = highestTs;
    }

    return {
      rawPayloads,
      nextCursor: { provider: "slack", channelCursors },
      hasMore, // conversations.list/.history pagination beyond one page is a v2 follow-up, not needed for the mock-first vertical slice
    };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const message = raw.payload as {
      ts: string;
      user?: string;
      text?: string;
      channel_id: string;
      channel_name?: string;
      subtype?: string;
      files?: SlackFile[];
      // Both resolved in fetchSince (I/O, allowed there) from a one-time
      // users.list call — normalize() itself stays pure/no-I/O, so it can
      // only read what fetchSince already attached to the payload.
      user_display_name?: string;
      text_resolved?: string;
    };

    // Skip channel-join/leave and other bookkeeping subtypes — they're not
    // meaningful "activity" for the action-item pipeline. `file_share` is
    // deliberately NOT in this set: it's a normal message that happens to
    // carry files[], and the old blanket `if (message.subtype) return []`
    // here used to drop every file upload along with it.
    if (message.subtype && BOOKKEEPING_SUBTYPES.has(message.subtype)) return [];

    const attachments = filesToAttachmentDrafts(message.files);

    return [
      {
        type: "message.posted",
        actor: message.user,
        actorDisplay: message.user_display_name,
        resource: `slack-channel:${message.channel_id}`,
        resourceType: "channel",
        title: message.channel_name ? `#${message.channel_name}` : undefined,
        body: message.text_resolved ?? message.text,
        occurredAt: raw.occurredAt ?? new Date(),
        metadata: { channel_id: message.channel_id, channel_name: message.channel_name },
        dedupeKey: `message.posted:${message.channel_id}:${message.ts}`,
        attachments,
      },
    ];
  },

  async downloadAttachment(
    credentials: ConnectorCredentials,
    downloadRef: Record<string, unknown>,
    deadline: FetchDeadline,
  ): Promise<DownloadedAttachment | null> {
    const url = downloadRef.url_private_download as string | undefined;
    if (!url || deadline.expired()) return null;

    try {
      // Direct fetch, not the proxy (see D-004): Slack file bytes are a
      // binary download, not a JSON API call, and getting a raw token here
      // is simpler than special-casing this one endpoint's response shape
      // through nangoProxy.
      const accessToken = await credentials.getAccessToken();
      const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
      if (!res.ok) {
        console.warn(`[slack] attachment download failed: HTTP ${res.status}`);
        return null;
      }
      const contentType = res.headers.get("content-type") ?? undefined;
      // Slack serves an HTML sign-in/error page with a 200 status (not a
      // 4xx) when the token lacks files:read or the file has actually been
      // deleted — without this check, that page would get stored and parsed
      // as if it were the real document.
      if (contentType?.includes("text/html")) {
        console.warn("[slack] attachment download returned an HTML page, not the file — likely missing files:read scope");
        return null;
      }
      const bytes = Buffer.from(await res.arrayBuffer());
      return { bytes, mimeType: contentType };
    } catch (err) {
      console.warn("[slack] attachment download threw:", err);
      return null;
    }
  },

  async disconnect(credentials: ConnectorCredentials): Promise<void> {
    // Best-effort, direct (not proxied) — a one-off admin action outside
    // any sync budget. The caller (integrations/actions.ts) deletes the
    // Nango connection regardless of whether this succeeds.
    try {
      const accessToken = await credentials.getAccessToken();
      await fetch("https://slack.com/api/auth.revoke", {
        method: "POST",
        headers: { Authorization: `Bearer ${accessToken}` },
      });
    } catch {
      // swallow — best-effort
    }
  },
};
