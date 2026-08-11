import type { ConnectorProvider, GoogleService } from "@/components/items/provider-badge";

export interface ProjectDataFilters {
  /** A validated "YYYY-MM-DD" day key, or null if absent/malformed — the
   * page resolves null to the most recent day with activity (or today). */
  date: string | null;
  connector: ConnectorProvider | "all";
  /** Secondary dimension, only meaningful alongside connector="google": the
   * merged Google connector writes every Gmail/Drive/Chat event with
   * provider='google', so isolating "just Gmail" needs this extra filter on
   * normalized_events.metadata.service. "all" for every other connector. */
  service: GoogleService | "all";
}

const ALL_CONNECTORS: ConnectorProvider[] = ["slack", "google", "google_chat", "google_drive", "gmail", "clickup", "mock"];
const ALL_SERVICES: GoogleService[] = ["gmail", "drive", "chat"];
const DATE_KEY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Pure parsing of the raw searchParams object into normalized filters —
 * kept separate from the Supabase query building in page.tsx so it's unit
 * testable without a database, mirroring task-management/filters.ts.
 */
export function parseProjectDataSearchParams(
  raw: Record<string, string | string[] | undefined>,
): ProjectDataFilters {
  const dateRaw = first(raw.date);
  const connectorRaw = first(raw.connector);
  const serviceRaw = first(raw.service);

  return {
    // A malformed or missing date (e.g. a stale/shared URL, or a typo) falls
    // back to null rather than erroring — the page picks a sensible default.
    date: dateRaw && DATE_KEY_PATTERN.test(dateRaw) ? dateRaw : null,
    connector:
      connectorRaw && (ALL_CONNECTORS as string[]).includes(connectorRaw)
        ? (connectorRaw as ConnectorProvider)
        : "all",
    service:
      serviceRaw && (ALL_SERVICES as string[]).includes(serviceRaw) ? (serviceRaw as GoogleService) : "all",
  };
}

/**
 * The day rail and connector strip are Server Components (no
 * useSearchParams), so each Link's href is built explicitly from the params
 * this route has — day, connector and service each preserve whichever
 * dimension the others are changing.
 */
export function projectDataHref(next: ProjectDataFilters): string {
  const params = new URLSearchParams();
  if (next.date) params.set("date", next.date);
  if (next.connector !== "all") params.set("connector", next.connector);
  // A service filter without a connector filter would be ambiguous (and the
  // page can't apply it) — the connector strip always sets both together.
  if (next.connector === "google" && next.service !== "all") params.set("service", next.service);
  const query = params.toString();
  return query ? `?${query}` : "?";
}
