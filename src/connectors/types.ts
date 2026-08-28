import type { Database } from "@/lib/db/database.types";

export type ConnectorId = Database["public"]["Enums"]["connector_provider"];

/**
 * A connector's credentials, backed by a Nango connection (see
 * NANGO_MIGRATION_LOG.md D-008/D-009). `connectionId` + `providerConfigKey`
 * are what every JSON API call needs — they're passed straight to Nango's
 * proxy (lib/nango/client.ts's nangoProxy), which injects the actual token
 * itself. `getAccessToken()` is only for the handful of binary-download
 * paths that deliberately bypass the proxy (D-004: Slack file downloads,
 * Gmail attachment bytes, Drive export/download) — it's a closure rather
 * than a field so a sync that downloads nothing never pays the extra Nango
 * round-trip, and it MUST be memoized by the implementation, since
 * services/attachments/run-extraction.ts loads credentials once and reuses
 * them across every attachment in a run.
 */
export interface ConnectorCredentials {
  connectionId: string;
  providerConfigKey: string;
  externalAccountId: string;
  externalAccountLabel?: string;
  getAccessToken(): Promise<string>;
}

/** One page of newly-fetched provider data, plus the cursor to resume from
 * next time. `cursor` is provider-specific — see project_connector_cursors'
 * column comment in the migration for why it's an untyped bag, not a shared
 * shape. */
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
  /** project_connectors.config, verbatim, as jsonb. THIS IS CLIENT-WRITABLE —
   * the `project_connectors` table grants `authenticated` a column-scoped
   * UPDATE that includes `config` (see the connectors migration), so any
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
  /** Provider-stable, used for the (project_connector_id, dedupe_key) unique
   * constraint — must be deterministic for the same underlying event across
   * re-syncs (e.g. `${type}:${resource}:${revision}`). */
  dedupeKey: string;
  /** Attachments discovered on this event (Slack files[], Gmail MIME parts
   * with an attachmentId, Chat attachment[]). normalize() only DESCRIBES
   * these — it's pure/no-I/O, so it can't download bytes here. Persisted as
   * event_attachments rows (status='pending') by run-sync.ts, then actually
   * downloaded/parsed later by the separate /api/jobs/attachments job. See
   * services/attachments/ and the event_attachments migration's header
   * comment for why this is a separate async step. */
  attachments?: AttachmentDraft[];
}

/** One attachment discovered on a message/email, described but not yet
 * fetched. `providerAttachmentId` + the owning event form the
 * event_attachments idempotency key, so it MUST be stable across re-syncs of
 * the same underlying message (a Slack file id, a Gmail MIME part's
 * attachmentId, a Chat attachmentDataRef.resourceName) — never a generated
 * value. */
export interface AttachmentDraft {
  providerAttachmentId: string;
  filename?: string;
  mimeType?: string;
  sizeBytes?: number;
  /** Opaque, provider-specific handle handed back to downloadAttachment()
   * verbatim later — never interpreted by run-sync.ts or normalize(). See
   * event_attachments.download_ref's column comment for the concrete shapes
   * per provider. */
  downloadRef: Record<string, unknown>;
}

/** Result of a successful downloadAttachment() call. `mimeType` is returned
 * separately from AttachmentDraft.mimeType because the provider's download
 * response is sometimes more trustworthy than the metadata seen at fetchSince
 * time (e.g. a server-set Content-Type) — services/attachments/extract.ts
 * prefers this value when present. */
export interface DownloadedAttachment {
  bytes: Buffer;
  mimeType?: string;
}

/**
 * Every connector implements this. The sync engine (services/sync) only
 * ever calls fetchSince/normalize/downloadAttachment/validate — adding a
 * new provider means one new folder under connectors/ and one registry
 * line, never a change to the sync engine itself. OAuth (authorize/
 * exchange/refresh) is Nango's job, not this interface's — see
 * NANGO_MIGRATION_LOG.md D-009 for why that cut landed here.
 */
export interface Connector<TCursor = unknown> {
  readonly id: ConnectorId;
  readonly displayName: string;

  /** The Nango integration id (`unique_key`) this connector authenticates
   * through, e.g. "google" or "slack" — `undefined` for connectors with no
   * OAuth grant at all (the mock connector). Drives both the Connect UI's
   * `allowed_integrations` and the Integrations page's "is this connectable"
   * check that `requiresOAuth` used to serve. */
  readonly nangoProviderConfigKey?: string;

  /** Recovers what `exchangeCode` used to return before Nango: the
   * provider's own stable account identifier (Google's `sub`, Slack's
   * `team.id`) and a human-readable label. Needed because Nango assigns
   * connection ids as random UUIDs the caller can't choose, so THIS is what
   * the connect flow uses to look up (or create) the right
   * space_connections row for a given (client space, provider, external
   * account) — see D-008's scoped reuse. `accountDomain` is optional and only
   * meaningful for providers whose events need it to build a click-through
   * URL (Slack's team subdomain, for message permalinks) — see
   * space_connections.account_domain's column comment. */
  identify?(
    credentials: ConnectorCredentials,
  ): Promise<{ externalAccountId: string; externalAccountLabel?: string; accountDomain?: string }>;

  /** Cheap liveness check — called after connect and periodically to flip
   * `space_connections.status` between 'connected' and 'degraded'/'error'. */
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

  /** Fetch one attachment's raw bytes, given the `downloadRef` a prior
   * normalize() call produced. Called by the /api/jobs/attachments job, NOT
   * during fetchSince — downloading and parsing every attachment inline
   * would blow the 45s sync budget on the first Slack channel with a few
   * PDFs in it. Omit entirely for connectors with no attachment support
   * (mock) — services/attachments/run-extraction.ts skips the whole
   * download step when this is undefined.
   *
   * MUST return `null` (never throw) for a single bad/inaccessible file —
   * mirrors connectors/google_drive/text.ts's fetchFileText contract: one
   * weird attachment must never fail the whole extraction run. `deadline` is
   * carved per-attachment by the caller; check it before starting a large
   * download, same as every other connector loop boundary. */
  downloadAttachment?(
    credentials: ConnectorCredentials,
    downloadRef: Record<string, unknown>,
    deadline: FetchDeadline,
  ): Promise<DownloadedAttachment | null>;

  /** Revoke the connection with the provider, where the provider supports
   * it, on top of Nango's own connection deletion — best-effort, since the
   * caller (integrations/actions.ts) deletes the Nango connection and
   * updates local rows regardless of whether this succeeds. Optional: most
   * providers need nothing beyond Nango's own DELETE /connections; only
   * implement this for a provider-specific revoke Nango doesn't already
   * cover. */
  disconnect?(credentials: ConnectorCredentials): Promise<void>;
}
