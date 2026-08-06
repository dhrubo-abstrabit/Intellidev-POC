import type { Connector, ConnectorId } from "@/connectors/types";
import { slackConnector } from "@/connectors/slack";
import { mockConnector } from "@/connectors/mock";
import { googleChatConnector } from "@/connectors/google_chat";
import { googleDriveConnector } from "@/connectors/google_drive";

/**
 * Adding a new provider means one new folder under connectors/ plus one line
 * here — the sync engine and Integrations UI only ever go through this map,
 * never import a specific connector module directly.
 */
const registry: Partial<Record<ConnectorId, Connector>> = {
  slack: slackConnector,
  mock: mockConnector,
  google_chat: googleChatConnector,
  google_drive: googleDriveConnector,
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
