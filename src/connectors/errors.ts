/**
 * Typed errors a connector's fetchSince/exchangeCode/refreshTokens may throw.
 * Provider-agnostic on purpose — run-sync.ts and credentials.ts branch on
 * these types without ever learning anything about a specific provider.
 */

/** The provider rejected our credentials outright (HTTP 401). run-sync's
 * catch responds by clearing connector_credentials.access_token_expires_at
 * (forcing a refresh attempt next run) rather than setting revoked_at — a
 * single 401 is not proof the grant itself is gone, just that this
 * particular access token no longer works. */
export class ConnectorAuthError extends Error {
  constructor(message = "Connector rejected the current credentials") {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

/** A refreshTokens() call failed. `permanent: true` means the provider has
 * confirmed the grant itself is dead (e.g. Google's invalid_grant) and
 * services/sync/credentials.ts may set connector_credentials.revoked_at.
 * `permanent: false` (5xx, network error, timeout) must NOT set revoked_at —
 * that would permanently brick a credential over a transient blip. */
export class ConnectorRefreshError extends Error {
  readonly permanent: boolean;
  constructor(message: string, options: { permanent: boolean }) {
    super(message);
    this.name = "ConnectorRefreshError";
    this.permanent = options.permanent;
  }
}

/** integrations.config failed a connector's Zod parse in a way that can't be
 * safely defaulted away (e.g. a malformed source id, too many entries). This
 * is deliberately a hard failure rather than a silent empty sync — it lands
 * in integrations.last_error (rendered on the Integrations page) and flips
 * status via run-sync's existing backoff path, instead of looking like a
 * working integration that quietly produces nothing. */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorConfigError";
  }
}
