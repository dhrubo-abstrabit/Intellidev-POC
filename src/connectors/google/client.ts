import "server-only";
import { nangoProxy } from "@/lib/nango/client";
import type { ConnectorCredentials, FetchDeadline } from "@/connectors/types";

/** Re-exported under its original name so every existing catch site in the
 * Drive/Gmail/Chat connectors (`instanceof GoogleBudgetExhaustedError`)
 * keeps working unchanged. The class itself moved to lib/nango/client.ts
 * and lost the Google-specific name there, since Slack throws the same
 * error now too — see NANGO_MIGRATION_LOG.md D-004/D-007. */
export { BudgetExhaustedError as GoogleBudgetExhaustedError } from "@/lib/nango/client";

const GOOGLE_DEFAULT_BASE_URL = "https://www.googleapis.com";
const DEFAULT_MAX_ATTEMPTS = 3;

export interface GoogleFetchOptions {
  credentials: ConnectorCredentials;
  deadline: FetchDeadline;
  /** Total attempts including the first — translated to Nango's `retries`
   * count (attempts AFTER the first), since Nango owns backoff now. */
  maxAttempts?: number;
}

/**
 * Adapter over Nango's proxy for every Google API call across the Drive/
 * Gmail/Chat connectors (see D-004: binary downloads bypass this entirely
 * and fetch a raw token instead). Callers still pass a full URL exactly as
 * before Nango existed — this splits it into Nango's {endpoint,
 * baseUrlOverride} shape so none of those call sites needed to change their
 * URL construction, only how they authenticate. The `google` Nango
 * integration's default base is www.googleapis.com (D-005), so only
 * Gmail/Chat/People URLs actually need an override.
 */
export async function googleFetch<T>(url: string, options: GoogleFetchOptions): Promise<T> {
  const parsed = new URL(url);
  const baseUrlOverride = parsed.origin === GOOGLE_DEFAULT_BASE_URL ? undefined : parsed.origin;
  const endpoint = `${parsed.pathname}${parsed.search}`;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;

  return nangoProxy<T>({
    connectionId: options.credentials.connectionId,
    providerConfigKey: options.credentials.providerConfigKey,
    endpoint,
    baseUrlOverride,
    retries: Math.max(0, maxAttempts - 1),
    deadline: options.deadline,
  });
}
