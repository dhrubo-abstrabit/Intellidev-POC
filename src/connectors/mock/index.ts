import type { Connector, ConnectorCredentials, FetchResult, NormalizedEventDraft, RawPayload } from "@/connectors/types";

/** No OAuth grant, so `credentials.tokens` is always empty — present only to
 * satisfy the shared `ConnectorCredentials` shape the sync engine expects
 * every connector to accept. */
const MOCK_EXTERNAL_ACCOUNT_ID = "mock-workspace";

interface MockCursor {
  seq: number;
}

const SAMPLE_AUTHORS = ["U_ALICE", "U_BOB", "U_CARLA"];
const SAMPLE_MESSAGES = [
  "Can someone review the staging deploy before EOD?",
  "Blocked on the API keys for the new integration.",
  "Shipped the fix for the flaky checkout test.",
  "Heads up: the weekly sync moved to Thursday.",
  "I think we should revisit the pricing tiers next sprint.",
];
const BATCH_SIZE = 5;

export function mockCredentials(): ConnectorCredentials {
  return { tokens: {}, externalAccountId: MOCK_EXTERNAL_ACCOUNT_ID, externalAccountLabel: "Mock workspace" };
}

export const mockConnector: Connector<MockCursor> = {
  id: "mock",
  displayName: "Mock (sample data)",
  requiresOAuth: false,

  async validate(): Promise<boolean> {
    return true;
  },

  async fetchSince(_credentials: ConnectorCredentials, cursor: MockCursor | null): Promise<FetchResult<MockCursor>> {
    const startSeq = cursor?.seq ?? 0;
    const rawPayloads: RawPayload[] = [];

    for (let i = 0; i < BATCH_SIZE; i++) {
      const seq = startSeq + i;
      const author = SAMPLE_AUTHORS[seq % SAMPLE_AUTHORS.length];
      const text = SAMPLE_MESSAGES[seq % SAMPLE_MESSAGES.length];
      rawPayloads.push({
        providerEventId: `mock:${seq}`,
        occurredAt: new Date(),
        payload: { seq, author, text, channel_id: "mock-general", channel_name: "general" },
      });
    }

    return {
      rawPayloads,
      nextCursor: { seq: startSeq + BATCH_SIZE },
      hasMore: false,
    };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const message = raw.payload as { seq: number; author: string; text: string; channel_id: string; channel_name: string };
    return [
      {
        type: "message.posted",
        actor: message.author,
        resource: `slack-channel:${message.channel_id}`,
        resourceType: "channel",
        title: `#${message.channel_name}`,
        body: message.text,
        occurredAt: raw.occurredAt ?? new Date(),
        metadata: { channel_id: message.channel_id, channel_name: message.channel_name },
        dedupeKey: `message.posted:${message.channel_id}:${message.seq}`,
      },
    ];
  },

  async disconnect(): Promise<void> {
    // Nothing to revoke — no external grant exists.
  },
};
