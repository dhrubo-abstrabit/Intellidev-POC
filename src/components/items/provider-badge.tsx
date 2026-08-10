import { Badge } from "@/components/ui/badge";
import type { Database } from "@/lib/db/database.types";

export type ConnectorProvider = Database["public"]["Enums"]["connector_provider"];

/** Human-readable labels for connector_provider — plain `capitalize` can't
 * turn "google_chat" into "Google Chat", so this is the map every provider
 * badge/chip in the app should read from instead of ad-hoc string munging.
 * `gmail`/`google_drive`/`google_chat` are retired as connectors but kept
 * here: events ingested before the merge still carry those providers. */
export const PROVIDER_LABEL: Record<ConnectorProvider, string> = {
  slack: "Slack",
  google: "Google",
  google_chat: "Google Chat",
  google_drive: "Google Drive",
  gmail: "Gmail",
  clickup: "ClickUp",
  mock: "Mock",
};

/** The three sub-services behind the merged `google` provider. Mirrors
 * GoogleService in connectors/google/cursor.ts as a plain string union — the
 * connector module is server-only and can't be imported from client
 * components like day-linkage.tsx. */
export type GoogleService = "gmail" | "drive" | "chat";

export const GOOGLE_SERVICE_LABEL: Record<GoogleService, string> = {
  gmail: "Gmail",
  drive: "Google Drive",
  chat: "Google Chat",
};

export function isGoogleService(value: unknown): value is GoogleService {
  return value === "gmail" || value === "drive" || value === "chat";
}

/**
 * `service` comes from normalized_events.metadata.service, which the merged
 * Google connector's normalize() stamps on every row it produces. Since
 * run-sync writes `provider` verbatim from the integration, all three Google
 * sub-services now land as provider='google' — without this the badge would
 * read a flat "Google" for mail, files and chat alike. Ignored for every
 * other provider, and falls back to "Google" if it's missing (a pre-merge
 * row, or one written by hand).
 */
export function ProviderBadge({ provider, service }: { provider: ConnectorProvider; service?: string | null }) {
  const label = provider === "google" && isGoogleService(service) ? GOOGLE_SERVICE_LABEL[service] : PROVIDER_LABEL[provider];
  return <Badge variant="outline">{label}</Badge>;
}
