import "server-only";
import { slackEnv } from "@/lib/env";
import { oauthRedirectUri } from "@/lib/oauth/redirect";
import type {
  Connector,
  ConnectorCredentials,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

const SLACK_AUTHORIZE_URL = "https://slack.com/oauth/v2/authorize";
const SLACK_API_BASE = "https://slack.com/api";
// conversations.list is called with types: "public_channel,private_channel",
// which needs channels:read (public) AND groups:read (private) — history
// scopes alone only cover reading messages in channels the bot can already
// see, not listing which private channels exist in the first place.
const BOT_SCOPES = [
  "channels:history",
  "channels:read",
  "groups:history",
  "groups:read",
  "users:read",
  "team:read",
];

/** Every Slack Web API response shares `ok`/`error`; the rest is a union of
 * whatever fields the specific methods this connector calls can return —
 * loosely typed rather than one interface per method. */
interface SlackApiResponse {
  ok: boolean;
  error?: string;
  access_token?: string;
  token_type?: string;
  scope?: string;
  bot_user_id?: string;
  team?: { id: string; name?: string };
  authed_user?: Record<string, unknown>;
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

async function fetchUserDirectory(accessToken: string): Promise<Map<string, { displayName?: string }>> {
  const directory = new Map<string, { displayName?: string }>();
  let cursor = "";
  for (let page = 0; page < USER_DIRECTORY_PAGE_LIMIT; page++) {
    const res = await slackApiGet("users.list", { limit: "200", ...(cursor ? { cursor } : {}) }, accessToken);
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

/** One cursor per integration (scope_key='default'), internally tracking
 * each channel's own resume point — Slack channels post at very different
 * rates, so a single flat timestamp would either re-fetch quiet channels
 * constantly or miss messages in busy ones. */
interface SlackCursor {
  provider: "slack";
  channelCursors: Record<string, string>; // channelId -> oldest `ts` seen
}

function redirectUri(): string {
  return oauthRedirectUri("slack");
}

async function slackApiPost(method: string, params: Record<string, string>, accessToken?: string): Promise<SlackApiResponse> {
  const res = await fetch(`${SLACK_API_BASE}/${method}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: new URLSearchParams(params),
  });
  return res.json();
}

async function slackApiGet(method: string, params: Record<string, string>, accessToken: string): Promise<SlackApiResponse> {
  const url = new URL(`${SLACK_API_BASE}/${method}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Slack rate-limits aggressively (Tier 2/3 methods can be as low as 20-50
  // req/min per workspace) — a single 429 retry with the provided
  // Retry-After is the minimum viable handling; a real production sync
  // engine under load would want a shared rate limiter across integrations.
  for (let attempt = 0; attempt < 3; attempt++) {
    const res = await fetch(url, { headers: { Authorization: `Bearer ${accessToken}` } });
    if (res.status === 429) {
      const retryAfterSec = Number(res.headers.get("Retry-After") ?? "5");
      await new Promise((resolve) => setTimeout(resolve, retryAfterSec * 1000));
      continue;
    }
    return res.json();
  }
  throw new Error(`Slack API ${method}: exhausted retries after repeated 429s`);
}

export const slackConnector: Connector<SlackCursor> = {
  id: "slack",
  displayName: "Slack",
  requiresOAuth: true,

  getAuthorizeUrl(state: string): string {
    const env = slackEnv();
    const url = new URL(SLACK_AUTHORIZE_URL);
    url.searchParams.set("client_id", env.SLACK_CLIENT_ID);
    url.searchParams.set("scope", BOT_SCOPES.join(","));
    url.searchParams.set("redirect_uri", redirectUri());
    url.searchParams.set("state", state);
    return url.toString();
  },

  async exchangeCode(code: string): Promise<ConnectorCredentials> {
    const env = slackEnv();
    const data = await slackApiPost("oauth.v2.access", {
      client_id: env.SLACK_CLIENT_ID,
      client_secret: env.SLACK_CLIENT_SECRET,
      code,
      redirect_uri: redirectUri(),
    });

    if (!data.ok) {
      throw new Error(`Slack OAuth exchange failed: ${data.error ?? "unknown error"}`);
    }

    return {
      tokens: {
        access_token: data.access_token,
        token_type: data.token_type,
        scope: data.scope,
        bot_user_id: data.bot_user_id,
        team: data.team,
        authed_user: data.authed_user,
      },
      externalAccountId: data.team?.id ?? "unknown",
      externalAccountLabel: data.team?.name,
      // Slack bot tokens don't expire under the classic OAuth flow used
      // here, so there's no expires_in to record.
    };
  },

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return false;
    const data = await slackApiPost("auth.test", {}, accessToken);
    return Boolean(data.ok);
  },

  async fetchSince(
    credentials: ConnectorCredentials,
    cursor: SlackCursor | null,
  ): Promise<FetchResult<SlackCursor>> {
    const accessToken = credentials.tokens.access_token as string;
    const channelCursors = { ...(cursor?.channelCursors ?? {}) };
    const rawPayloads: RawPayload[] = [];

    const userDirectory = await fetchUserDirectory(accessToken).catch((err: unknown) => {
      console.warn("[slack] failed to fetch user directory — actors will show as raw ids:", err);
      return new Map<string, { displayName?: string }>();
    });

    const channelsRes = await slackApiGet(
      "conversations.list",
      { types: "public_channel,private_channel", limit: "200" },
      accessToken,
    );
    if (!channelsRes.ok) {
      throw new Error(`Slack conversations.list failed: ${channelsRes.error ?? "unknown error"}`);
    }

    for (const channel of channelsRes.channels ?? []) {
      if (!channel.is_member) continue; // bot must be invited to the channel to read history

      const oldest = channelCursors[channel.id];
      const historyRes = await slackApiGet(
        "conversations.history",
        { channel: channel.id, ...(oldest ? { oldest } : {}), limit: "200" },
        accessToken,
      );
      if (!historyRes.ok) {
        // Don't let one broken/archived channel abort the whole sync.
        continue;
      }

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
      hasMore: false, // conversations.list/.history pagination beyond one page is a v2 follow-up, not needed for the mock-first vertical slice
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
      // Both resolved in fetchSince (I/O, allowed there) from a one-time
      // users.list call — normalize() itself stays pure/no-I/O, so it can
      // only read what fetchSince already attached to the payload.
      user_display_name?: string;
      text_resolved?: string;
    };

    // Skip channel-join/leave and other bookkeeping subtypes — they're not
    // meaningful "activity" for the action-item pipeline.
    if (message.subtype) return [];

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
      },
    ];
  },

  async disconnect(credentials: ConnectorCredentials): Promise<void> {
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return;
    // Best-effort — the row gets deleted/marked revoked locally regardless.
    await slackApiPost("auth.revoke", {}, accessToken).catch(() => {});
  },
};
