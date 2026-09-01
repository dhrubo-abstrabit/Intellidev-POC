/**
 * Typed errors a connector's fetchSince may throw. Provider-agnostic on
 * purpose — run-sync.ts and credentials.ts branch on these types without
 * ever learning anything about a specific provider.
 */

/** The provider (or Nango, on its behalf) rejected our credentials outright
 * (HTTP 401). Nango refreshes tokens itself (on read, and proactively at
 * least daily — see NANGO_MIGRATION_LOG.md D-010), so unlike the pre-Nango
 * design this is no longer paired with a local expiry-clearing write; it's
 * just a signal to run-sync's normal backoff path that this integration
 * needs attention (commonly: the user needs to reconnect it). */
export class ConnectorAuthError extends Error {
  constructor(message = "Connector rejected the current credentials") {
    super(message);
    this.name = "ConnectorAuthError";
  }
}

/** project_connectors.config failed a connector's Zod parse in a way that
 * can't be safely defaulted away (e.g. a malformed source id, too many
 * entries). This is deliberately a hard failure rather than a silent empty
 * sync — it lands in project_connectors.last_error (rendered on the
 * Integrations page) and flips its backoff via run-sync's existing failure
 * path, instead of looking like a working integration that quietly produces
 * nothing. */
export class ConnectorConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorConfigError";
  }
}
