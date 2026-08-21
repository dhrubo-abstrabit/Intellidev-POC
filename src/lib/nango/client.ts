import "server-only";
import { ConnectorAuthError } from "@/connectors/errors";
import { nangoEnv } from "@/lib/env";
import type { FetchDeadline } from "@/connectors/types";

/**
 * Thrown instead of letting a proxy call run past a fetchSince run's
 * remaining time budget. Formerly connectors/google/client.ts's
 * GoogleBudgetExhaustedError — renamed and moved here (see
 * NANGO_MIGRATION_LOG.md D-004/D-007) because it is no longer Google-
 * specific once Slack's calls go through the same proxy. Every connector's
 * pagination loop must catch this at its own boundary and return what it
 * already has with `hasMore: true`, not let it propagate as a hard failure.
 */
export class BudgetExhaustedError extends Error {
  constructor(message = "Ran out of time budget before the request could complete") {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/**
 * Milliseconds reserved below the deadline's remaining time so this
 * module's own AbortSignal always fires before the caller's outer budget
 * check would (leaves room for the abort + error handling itself to run).
 */
const DEADLINE_RESERVE_MS = 500;

export interface NangoProxyOptions {
  connectionId: string;
  providerConfigKey: string;
  /** Path on the provider's API, e.g. "/gmail/v1/users/me/messages". Passed
   * through to Nango's proxy verbatim — leading slash optional. */
  endpoint: string;
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Query params appended to the endpoint URL (not proxied as-is — Nango
   * forwards these to the upstream provider request). */
  params?: Record<string, string>;
  /** JSON body for non-GET requests. */
  data?: unknown;
  /** Overrides the provider's default base URL — see D-005: one `google`
   * integration reaches gmail.googleapis.com / chat.googleapis.com /
   * people.googleapis.com this way, none of which is the provider's
   * default (www.googleapis.com). Must be present in the Nango instance's
   * NANGO_OUTBOUND_URL_POLICY allowlist (D-014) or the proxy rejects it. */
  baseUrlOverride?: string;
  /** Passed to Nango as the `Retries` header — Nango owns backoff/rate-limit
   * handling (D-007). Defaults to 3. Pass 0 to disable. */
  retries?: number;
  /** Extra headers forwarded to the upstream request via Nango's
   * `nango-proxy-$HEADER` passthrough convention is NOT applied here — this
   * sets headers on the call to Nango itself (rarely needed). */
  headers?: Record<string, string>;
  deadline: FetchDeadline;
}

function buildProxyUrl(serverUrl: string, endpoint: string, params?: Record<string, string>): string {
  const cleanEndpoint = endpoint.startsWith("/") ? endpoint.slice(1) : endpoint;
  const url = new URL(`${serverUrl}/proxy/${cleanEndpoint}`);
  if (params) {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  }
  return url.toString();
}

/**
 * Shared HTTP client for every provider API call routed through Nango's
 * proxy (Slack + Google JSON calls — see D-004 for why binary downloads
 * bypass this entirely). Deliberately thin: Nango owns retry/backoff
 * (D-007), so this module's only job is (1) authenticating to Nango itself,
 * (2) bounding the call to the caller's remaining fetchSince budget so a
 * retry storm on Nango's clock can never overshoot ours, and (3) mapping a
 * 401 to the same ConnectorAuthError every connector already expects.
 */
export async function nangoProxy<T>(options: NangoProxyOptions): Promise<T> {
  const remaining = options.deadline.remainingMs() - DEADLINE_RESERVE_MS;
  if (options.deadline.expired() || remaining <= 0) {
    throw new BudgetExhaustedError();
  }

  const env = nangoEnv();
  const url = buildProxyUrl(env.NANGO_SERVER_URL, options.endpoint, options.params);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), remaining);

  try {
    const res = await fetch(url, {
      method: options.method ?? "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env.NANGO_SECRET_KEY}`,
        "Provider-Config-Key": options.providerConfigKey,
        "Connection-Id": options.connectionId,
        Retries: String(options.retries ?? 3),
        ...(options.baseUrlOverride ? { "Base-Url-Override": options.baseUrlOverride } : {}),
        ...(options.data !== undefined ? { "Content-Type": "application/json" } : {}),
        ...options.headers,
      },
      body: options.data !== undefined ? JSON.stringify(options.data) : undefined,
    });

    if (res.status === 401) {
      throw new ConnectorAuthError(`Nango proxy rejected the connection's credentials: ${options.endpoint}`);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`Nango proxy ${options.endpoint} failed with ${res.status}: ${text || res.statusText}`);
    }

    // 204/empty-body responses have nothing to parse.
    const text = await res.text();
    return (text ? JSON.parse(text) : undefined) as T;
  } catch (err) {
    if (err instanceof DOMException && err.name === "AbortError") {
      throw new BudgetExhaustedError();
    }
    throw err;
  } finally {
    clearTimeout(timeout);
  }
}
