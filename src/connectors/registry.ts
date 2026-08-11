import type { Connector, ConnectorId } from "@/connectors/types";
import { slackConnector } from "@/connectors/slack";
import { mockConnector } from "@/connectors/mock";
import { googleConnector } from "@/connectors/google";

/**
 * Adding a new provider means one new folder under connectors/ plus one line
 * here — the sync engine and Integrations UI only ever go through this map,
 * never import a specific connector module directly.
 *
 * `gmail`, `google_drive` and `google_chat` are intentionally ABSENT: they
 * were merged into the single `google` connector, which delegates to their
 * (still-present) modules internally. The enum values survive for historical
 * rows, so getConnector() throws for them by design — the Integrations page
 * detects that and renders a "reconnect as Google" banner instead of
 * pretending a still-active legacy row can sync.
 */
const registry: Partial<Record<ConnectorId, Connector>> = {
  slack: slackConnector,
  mock: mockConnector,
  google: googleConnector,
};

export function getConnector(id: ConnectorId): Connector {
  const connector = registry[id];
  if (!connector) {
    throw new Error(`No connector registered for provider "${id}"`);
  }
  return connector;
}

export function listConnectors(): Connector[] {
  return Object.values(registry).filter((c): c is Connector => c !== undefined);
}
