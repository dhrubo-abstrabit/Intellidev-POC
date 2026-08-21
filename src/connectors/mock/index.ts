import type {
  Connector,
  ConnectorCredentials,
  DownloadedAttachment,
  FetchResult,
  NormalizedEventDraft,
  RawPayload,
} from "@/connectors/types";

/** No OAuth grant — these are dummy values present only to satisfy the
 * shared `ConnectorCredentials` shape the sync engine expects every
 * connector to accept. */
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
  "Meridian Corp moved their contract renewal call up to Thursday — need the updated pricing deck before then.",
];
const BATCH_SIZE = 5;

export function mockCredentials(): ConnectorCredentials {
  return {
    connectionId: "mock",
    providerConfigKey: "mock",
    externalAccountId: MOCK_EXTERNAL_ACCOUNT_ID,
    externalAccountLabel: "Mock workspace",
    getAccessToken: async () => "",
  };
}

export const mockConnector: Connector<MockCursor> = {
  id: "mock",
  displayName: "Mock (sample data)",

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
      // Deterministic: exactly one message per batch carries a sample
      // attachment, so run-sync.integration.test.ts can assert on a
      // predictable event_attachments row without needing real provider
      // credentials or a network call.
      const hasAttachment = seq % BATCH_SIZE === 2;
      rawPayloads.push({
        providerEventId: `mock:${seq}`,
        occurredAt: new Date(),
        payload: { seq, author, text, channel_id: "mock-general", channel_name: "general", hasAttachment },
      });
    }

    return {
      rawPayloads,
      nextCursor: { seq: startSeq + BATCH_SIZE },
      hasMore: false,
    };
  },

  normalize(raw: RawPayload): NormalizedEventDraft[] {
    const message = raw.payload as {
      seq: number;
      author: string;
      text: string;
      channel_id: string;
      channel_name: string;
      hasAttachment?: boolean;
    };
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
        attachments: message.hasAttachment
          ? [
              {
                providerAttachmentId: `mock-att-${message.seq}`,
                filename: "sample.txt",
                mimeType: "text/plain",
                sizeBytes: 36,
                downloadRef: { seq: message.seq },
              },
            ]
          : undefined,
      },
    ];
  },

  async downloadAttachment(): Promise<DownloadedAttachment | null> {
    // No real provider to call — returns fixed bytes so
    // services/attachments/run-extraction.ts has something real to parse
    // and upload when exercised against the mock connector.
    return { bytes: Buffer.from("Sample attachment text for testing."), mimeType: "text/plain" };
  },

  async disconnect(): Promise<void> {
    // Nothing to revoke — no external grant exists.
  },
};
