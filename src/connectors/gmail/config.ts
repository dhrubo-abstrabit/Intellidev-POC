import "server-only";
import { z } from "zod";
import type { ConnectorConfigSchema, ConfigFieldSpec } from "@/lib/db/schemas/integration-config";

export const MAX_QUERY_CHARS = 512;

export const gmailConfigSchema = z.object({
  // Bounded and newline-free because this is client-writable: a query with
  // embedded newlines could otherwise smuggle extra Gmail search operators
  // in ways that are hard to reason about.
  query: z
    .string()
    .max(MAX_QUERY_CHARS)
    .regex(/^[^\r\n]*$/, "The query can't contain line breaks.")
    .catch("")
    .default(""),
  bootstrapDays: z.coerce.number().int().min(1).max(365).catch(30).default(30),
  maxBodyChars: z.coerce.number().int().min(500).max(20_000).catch(8_000).default(8_000),
  // Default true: for a shared project mailbox, what the team SENT is as
  // informative for the action-item pipeline as what it received.
  includeSent: z.coerce.boolean().catch(true).default(true),
});

export type GmailConfig = z.infer<typeof gmailConfigSchema>;

export const GMAIL_CONFIG_FIELDS: ConfigFieldSpec[] = [
  {
    key: "query",
    kind: "text",
    label: "Search filter (optional)",
    placeholder: "from:client.com OR subject:invoice",
    helpText: "Standard Gmail search syntax. Leave blank to sync the whole mailbox.",
  },
  {
    key: "bootstrapDays",
    kind: "number",
    label: "Initial lookback (days)",
    min: 1,
    max: 365,
    helpText: "How far back to backfill on the first sync.",
  },
  {
    key: "maxBodyChars",
    kind: "number",
    label: "Max characters per email",
    min: 500,
    max: 20_000,
    helpText: "Longer email bodies are truncated to this length.",
  },
  {
    key: "includeSent",
    kind: "boolean",
    label: "Include sent mail",
    defaultChecked: true,
    helpText: "Also sync mail the connected account sent, not just what it received.",
  },
];

export const gmailConfigEntry: ConnectorConfigSchema<GmailConfig> = {
  fields: GMAIL_CONFIG_FIELDS,
  schema: gmailConfigSchema,
  // A changed query invalidates the cursor: lastInternalDateMs marks "the
  // newest message WE'VE SEEN for the previous query" — replayed against a
  // different query, messages matching the new query but older than that
  // timestamp would be silently skipped forever.
  scopeFields: ["query"],
  // No required scope — an empty query is a legitimate "sync everything"
  // config, unlike Chat/Drive which need an explicit space/folder. Saving
  // the form at least once (even with defaults) is still what flips
  // pending -> connected, so the user makes one explicit "yes, sync this
  // mailbox" gesture before it starts.
  isConfigured: () => true,
};
