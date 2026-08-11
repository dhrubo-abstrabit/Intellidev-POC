import "server-only";
import { googleAuthorizeUrl, exchangeGoogleCode, refreshGoogleTokens, revokeGoogleToken } from "@/connectors/google/oauth";
import { GMAIL_SCOPES, DRIVE_SCOPES, CHAT_SCOPES } from "@/connectors/google/scopes";
import { carveDeadline } from "@/connectors/deadline";
import { ConnectorConfigError } from "@/connectors/errors";
import { gmailConnector } from "@/connectors/gmail";
import { googleDriveConnector } from "@/connectors/google_drive";
import { googleChatConnector } from "@/connectors/google_chat";
import { googleConfigSchema } from "./config";
import { parseGoogleCursor, rotatePriority, GOOGLE_SERVICES, type GoogleCursor, type GoogleService } from "./cursor";
import type {
  Connector,
  ConnectorCredentials,
  FetchContext,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

/** Every scope the one combined grant carries. Deliberately the union of
 * what used to be three separate least-privilege consent screens — see
 * CLAUDE.md's "Google connector specifics" for the tradeoff this accepts
 * (one credential row now unlocks mail + files + chat together). */
export const GOOGLE_ALL_SCOPES = [...GMAIL_SCOPES, ...DRIVE_SCOPES, ...CHAT_SCOPES];

/** Don't even start a sub-service with less than this left on the parent
 * deadline: every sub-connector reserves 5–6s of its own budget for the
 * caller's writes, so a slice thinner than that can only produce an empty
 * "stopped early" result while still costing a round-trip or two. */
const MIN_SERVICE_BUDGET_MS = 6_000;

/** Which sub-service produced a raw payload. Injected by fetchSince,
 * consumed by normalize() — and NOT part of any sub-connector's own payload
 * shape, hence the underscore prefix (matching Drive's own `_sourceId` /
 * `_mode` convention). */
const SERVICE_TAG_KEY = "_service";

function serviceOf(payload: Record<string, unknown>): GoogleService | undefined {
  const tag = payload[SERVICE_TAG_KEY];
  return GOOGLE_SERVICES.includes(tag as GoogleService) ? (tag as GoogleService) : undefined;
}

/**
 * One Google grant, three sub-services. Delegates wholesale to the existing
 * gmail/google_drive/google_chat connectors rather than reimplementing their
 * fetch logic — this module only owns (a) the combined OAuth handshake, (b)
 * splitting the single FetchContext.deadline between whichever sub-services
 * are enabled, (c) nesting their cursors under one cursor row, and (d)
 * tagging normalized events with which service they came from.
 *
 * (d) is load-bearing: run-sync.ts writes `provider: integration.provider`
 * verbatim, so after the merge every Gmail/Drive/Chat row lands with
 * provider='google' and `metadata.service` is the ONLY thing that still
 * distinguishes them downstream (provider badges, Data-page filters).
 */
export const googleConnector: Connector<GoogleCursor> = {
  id: "google",
  displayName: "Google",
  requiresOAuth: true,

  getAuthorizeUrl(state: string): string {
    return googleAuthorizeUrl({ provider: "google", scopes: GOOGLE_ALL_SCOPES, state });
  },

  async exchangeCode(code: string): Promise<ConnectorCredentials> {
    // Requires ALL three scope sets up front, even for a user who only means
    // to enable Gmail: Google never retro-upgrades an existing grant (see
    // CLAUDE.md), so asking later would mean a disconnect + reconnect every
    // time someone ticks a new service on.
    return exchangeGoogleCode("google", code, GOOGLE_ALL_SCOPES);
  },

  async validate(credentials: ConnectorCredentials): Promise<boolean> {
    // Drive's `about` probe is the cheapest of the three and needs no
    // per-service config to be meaningful — this only has to prove the
    // access token is alive, not that any particular sub-service is scoped.
    return googleDriveConnector.validate(credentials);
  },

  async refreshTokens(credentials: ConnectorCredentials): Promise<ConnectorCredentials> {
    return refreshGoogleTokens(credentials);
  },

  async fetchSince(
    credentials: ConnectorCredentials,
    cursor: GoogleCursor | null,
    context: FetchContext,
  ): Promise<FetchResult<GoogleCursor>> {
    const parsedConfig = googleConfigSchema.safeParse(context.config);
    if (!parsedConfig.success) {
      throw new ConnectorConfigError(
        `Google configuration is invalid: ${parsedConfig.error.issues[0]?.message ?? "unknown error"}`,
      );
    }
    const config = parsedConfig.data;
    const previous = parseGoogleCursor(cursor);

    const enabled = GOOGLE_SERVICES.filter((service) => config[service] !== null);
    if (enabled.length === 0) {
      // Every sub-service disabled: a legitimate (if pointless) config, not
      // an error. Return the cursor untouched so re-enabling resumes.
      return { rawPayloads: [], nextCursor: previous, hasMore: false };
    }

    const order = rotatePriority(enabled, previous.lastPriorityService);
    const next: GoogleCursor = { ...previous };
    const rawPayloads: RawPayload[] = [];
    let hasMore = false;
    let lastAttempted: GoogleService | undefined;

    for (let i = 0; i < order.length; i++) {
      const service = order[i];
      if (context.deadline.remainingMs() < MIN_SERVICE_BUDGET_MS) {
        // Out of budget: leave every remaining service's cursor slot exactly
        // as it was, and let run-sync know there's more to do.
        hasMore = true;
        break;
      }

      // An even split of whatever is LEFT, across whatever is left to run —
      // so a service that returns early hands its unused time to the ones
      // behind it instead of wasting it.
      const slice = carveDeadline(context.deadline, 1 / (order.length - i));
      let result: FetchResult<unknown>;

      if (service === "gmail") {
        const sub = await gmailConnector.fetchSince(credentials, previous.gmail, { config: config.gmail!, deadline: slice });
        next.gmail = sub.nextCursor;
        result = sub;
      } else if (service === "drive") {
        const sub = await googleDriveConnector.fetchSince(credentials, previous.drive, { config: config.drive!, deadline: slice });
        next.drive = sub.nextCursor;
        result = sub;
      } else {
        const sub = await googleChatConnector.fetchSince(credentials, previous.chat, { config: config.chat!, deadline: slice });
        next.chat = sub.nextCursor;
        result = sub;
      }

      for (const raw of result.rawPayloads) {
        rawPayloads.push({ ...raw, payload: { ...raw.payload, [SERVICE_TAG_KEY]: service } });
      }
      if (result.hasMore) hasMore = true;
      lastAttempted = service;
    }

    // Rotate on whatever actually ran, not on the planned order — a run that
    // stopped early must not "credit" services it never got to, or they'd be
    // pushed to the back of the queue without having fetched anything.
    if (lastAttempted) next.lastPriorityService = lastAttempted;

    return { rawPayloads, nextCursor: next, hasMore };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const service = serviceOf(raw.payload);
    // An untagged payload is one this connector never produced (a hand-
    // written row, or a payload from before the merge) — nothing here can
    // tell which sub-normalizer would understand it, so drop it rather than
    // guess. normalize() returning [] is an explicitly supported outcome.
    if (!service) return [];

    const drafts =
      service === "gmail"
        ? gmailConnector.normalize(raw)
        : service === "drive"
          ? googleDriveConnector.normalize(raw)
          : googleChatConnector.normalize(raw);

    // The sub-normalizers only read keys they themselves attached, so the
    // extra `_service` key is inert noise to them — but the resulting
    // normalized_events row needs it, since `provider` is now 'google' for
    // all three.
    return drafts.map((draft) => ({ ...draft, metadata: { ...draft.metadata, service } }));
  },

  async disconnect(credentials: ConnectorCredentials): Promise<void> {
    await revokeGoogleToken(credentials).catch(() => {});
  },
};
