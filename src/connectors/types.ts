import type { Database } from "@/lib/db/database.types";

export type ConnectorId = Database["public"]["Enums"]["connector_provider"];

/** The full OAuth token bundle for a connector, before encryption. Shape is
 * intentionally provider-specific — see lib/crypto/tokens.ts for why this is
 * one opaque JSON blob rather than typed columns. */
export type ProviderTokenBundle = Record<string, unknown>;

export interface ConnectorCredentials {
  tokens: ProviderTokenBundle;
  externalAccountId: string;
  externalAccountLabel?: string;
  accessTokenExpiresAt?: Date;
}

/** One page of newly-fetched provider data, plus the cursor to resume from
 * next time. `cursor` is provider-specific — see integration_cursors' column
 * comment in the migration for why it's an untyped bag, not a shared shape. */
export interface FetchResult<TCursor> {
  rawPayloads: RawPayload[];
  nextCursor: TCursor;
  hasMore: boolean;
}

export interface RawPayload {
  /** Provider-native id for this specific event/record, used for ingest
   * idempotency (raw_events.provider_event_id). Omit only when the provider
   * has no stable id — normalize() then falls back to a payload hash. */
  providerEventId?: string;
  occurredAt?: Date;
  payload: Record<string, unknown>;
}

/** Tells fetchSince "how much time is left in this invocation" without
 * exposing wall-clock APIs directly — see connectors/deadline.ts. Checked at
 * every loop boundary a connector has (source/space/page/file), because a
 * page-level-only check can overshoot by however long the slowest single
 * request in that page takes. */
export interface FetchDeadline {
  expired(): boolean;
  remainingMs(): number;
}

/** Per-call context passed to fetchSince alongside credentials/cursor. */
export interface FetchContext {
  /** integrations.config, verbatim, as jsonb. THIS IS CLIENT-WRITABLE — the
   * `integrations` table grants `authenticated` a column-scoped UPDATE that
   * includes `config` (see 20260803150600_integrations.sql), so any
   * workspace owner/admin can PATCH it directly via PostgREST. Every
   * connector MUST parse this with Zod and fall back to safe defaults; NEVER
   * trust its shape, and never let a numeric field here be unbounded (it's a
   * quota-exhaustion / function-stall primitive otherwise). */
  config: Record<string, unknown>;
  deadline: FetchDeadline;
}

export interface NormalizedEventDraft {
  type: string; // "noun.verb", e.g. "message.posted" — matches the DB CHECK constraint
  actor?: string;
  actorDisplay?: string;
  actorEmail?: string;
  resource?: string;
  resourceType?: string;
  resourceUrl?: string;
  title?: string;
  body?: string;
  occurredAt: Date;
  metadata?: Record<string, unknown>;
  /** Provider-stable, used for the (integration_id, dedupe_key) unique
   * constraint — must be deterministic for the same underlying event across
   * re-syncs (e.g. `${type}:${resource}:${revision}`). */
  dedupeKey: string;
}

/**
 * Every connector implements this. The sync engine (services/sync) only
 * ever calls these five methods — adding a new provider means one new
 * folder under connectors/ and one registry line, never a change to the
 * sync engine itself.
 */
export interface Connector<TCursor = unknown> {
  readonly id: ConnectorId;
  readonly displayName: string;

  /** True for connectors with no OAuth handshake (e.g. the mock connector). */
  readonly requiresOAuth: boolean;

  /** Build the provider's authorize URL. `state` is an opaque, signed,
   * single-use token the callback route must verify before trusting the
   * returned `code` — see lib/oauth/state.ts for the CSRF rationale. */
  getAuthorizeUrl?(state: string): string;

  /** Exchange an OAuth `code` for the provider's token bundle. */
  exchangeCode?(code: string): Promise<ConnectorCredentials>;

  /** Cheap liveness check — called after connect and periodically to flip
   * `integrations.status` between 'connected' and 'degraded'/'error'. */
  validate(credentials: ConnectorCredentials): Promise<boolean>;

  /** Fetch everything new since `cursor` (null on first sync). Must be safe
   * to call repeatedly with the same cursor (idempotent — see raw_events'
   * dedupe unique index, which is the actual idempotency backstop). `context`
   * carries the run's config + time budget — implementations that don't need
   * either (Slack, mock) may simply omit the parameter; TS permits an
   * implementation with fewer parameters than the interface declares. */
  fetchSince(credentials: ConnectorCredentials, cursor: TCursor | null, context: FetchContext): Promise<FetchResult<TCursor>>;

  /** Map one raw provider payload to zero or more normalized events. Pure
   * function — no I/O, no side effects, so it's trivially unit-testable
   * against fixture payloads. */
  normalize(raw: RawPayload): NormalizedEventDraft[];

  /** Revoke the token with the provider, where the provider supports it.
   * Best-effort — the caller still deletes/updates local rows regardless of
   * whether this succeeds. */
  disconnect(credentials: ConnectorCredentials): Promise<void>;

  /** Exchange a soon-to-expire access token for a fresh one. Omit entirely
   * for providers whose tokens don't expire (Slack's classic bot tokens,
   * mock) — services/sync/credentials.ts skips the whole refresh path when
   * this is undefined. MUST return the COMPLETE bundle to re-seal, not a
   * delta: Google's refresh response omits `refresh_token`, so an
   * implementation must merge it forward from the input credentials or a
   * refresh silently bricks the credential the next time it's needed. Throw
   * ConnectorRefreshError({permanent: true}) on a provider-confirmed dead
   * grant (e.g. `invalid_grant`), {permanent: false} on anything that might
   * be transient (5xx, network). */
  refreshTokens?(credentials: ConnectorCredentials): Promise<ConnectorCredentials>;
}
