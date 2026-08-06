import { Badge } from "@/components/ui/badge";
import type { Database } from "@/lib/db/database.types";

export type ConnectorProvider = Database["public"]["Enums"]["connector_provider"];

/** Human-readable labels for connector_provider — plain `capitalize` can't
 * turn "google_chat" into "Google Chat", so this is the map every provider
 * badge/chip in the app should read from instead of ad-hoc string munging. */
export const PROVIDER_LABEL: Record<ConnectorProvider, string> = {
  slack: "Slack",
  google_chat: "Google Chat",
  google_drive: "Google Drive",
  gmail: "Gmail",
  clickup: "ClickUp",
  mock: "Mock",
};

export function ProviderBadge({ provider }: { provider: ConnectorProvider }) {
  return <Badge variant="outline">{PROVIDER_LABEL[provider]}</Badge>;
}
