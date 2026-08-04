import "server-only";
import { slackEnv, publicEnv } from "@/lib/env";
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
  return `${publicEnv().NEXT_PUBLIC_APP_URL}/api/oauth/slack/callback`;
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
        rawPayloads.push({
          providerEventId: `${channel.id}:${message.ts}`,
          occurredAt: new Date(Number(message.ts) * 1000),
          payload: { ...message, channel_id: channel.id, channel_name: channel.name },
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
    };

    // Skip channel-join/leave and other bookkeeping subtypes — they're not
    // meaningful "activity" for the action-item pipeline.
    if (message.subtype) return [];

    return [
      {
        type: "message.posted",
        actor: message.user,
        resource: `slack-channel:${message.channel_id}`,
        resourceType: "channel",
        title: message.channel_name ? `#${message.channel_name}` : undefined,
        body: message.text,
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
