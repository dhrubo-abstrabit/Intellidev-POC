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
   * returned `code` — see connectors/slack/state.ts for the CSRF rationale. */
  getAuthorizeUrl?(state: string): string;

  /** Exchange an OAuth `code` for the provider's token bundle. */
  exchangeCode?(code: string): Promise<ConnectorCredentials>;

  /** Cheap liveness check — called after connect and periodically to flip
   * `integrations.status` between 'connected' and 'degraded'/'error'. */
  validate(credentials: ConnectorCredentials): Promise<boolean>;

  /** Fetch everything new since `cursor` (null on first sync). Must be safe
   * to call repeatedly with the same cursor (idempotent — see raw_events'
   * dedupe unique index, which is the actual idempotency backstop). */
  fetchSince(credentials: ConnectorCredentials, cursor: TCursor | null): Promise<FetchResult<TCursor>>;

  /** Map one raw provider payload to zero or more normalized events. Pure
   * function — no I/O, no side effects, so it's trivially unit-testable
   * against fixture payloads. */
  normalize(raw: RawPayload): NormalizedEventDraft[];

  /** Revoke the token with the provider, where the provider supports it.
   * Best-effort — the caller still deletes/updates local rows regardless of
   * whether this succeeds. */
  disconnect(credentials: ConnectorCredentials): Promise<void>;
}
