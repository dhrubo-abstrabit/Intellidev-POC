import "server-only";
import { z } from "zod";
import { gmailConfigSchema, gmailConfigEntry, GMAIL_CONFIG_FIELDS } from "../gmail/config";
import { googleDriveConfigSchema, googleDriveConfigEntry, GOOGLE_DRIVE_CONFIG_FIELDS } from "../google_drive/config";
import { googleChatConfigSchema, googleChatConfigEntry, GOOGLE_CHAT_CONFIG_FIELDS } from "../google_chat/config";
import { GOOGLE_SERVICES, type GoogleService } from "./cursor";
import type { ConnectorConfigSchema, ConfigFieldSpec } from "@/lib/db/schemas/integration-config";

/**
 * The merged connector's config is just the three existing per-service
 * schemas nested one level down, unchanged — `null` means "this sub-service
 * is disabled". Composing rather than re-declaring is what keeps a single
 * Zod schema authoritative for BOTH the write path (the config form) and the
 * read path (each sub-connector re-parsing its own slice at fetchSince
 * time), exactly as it was before the merge.
 */
// Hard ceiling enforced server-side regardless of what a client PATCHes into
// integrations.config directly via PostgREST — see connectors/types.ts's
// FetchContext doc comment on why a client-writable numeric field must never
// be trusted as unbounded. maxAttachmentsPerRun can only ever LOWER this,
// never raise it.
export const MAX_ATTACHMENTS_PER_RUN_CEILING = 25;
const DEFAULT_MAX_ATTACHMENTS_PER_RUN = 15;

export const googleConfigSchema = z.object({
  gmail: gmailConfigSchema.nullable().default(null),
  drive: googleDriveConfigSchema.nullable().default(null),
  chat: googleChatConfigSchema.nullable().default(null),
  // Top-level (not nested per sub-service): whether to download and extract
  // text from Gmail/Chat attachments at all. Read by
  // services/attachments/run-extraction.ts and run-sync.ts, NOT by
  // fetchSince — normalize() always describes attachments it finds, and this
  // flag only gates whether the separate attachments job acts on them.
  // Deliberately NOT exposed as a config-form field — enabled by default for
  // everyone, with no UI to turn it off. Kept on the schema (rather than a
  // bare constant) so it's still a normal, bounded, defaultable value on
  // every saved config, and still overridable by hand via direct PostgREST
  // if that's ever needed.
  processAttachments: z.coerce.boolean().catch(true).default(true),
  maxAttachmentsPerRun: z.coerce
    .number()
    .int()
    .min(1)
    .max(MAX_ATTACHMENTS_PER_RUN_CEILING)
    .catch(DEFAULT_MAX_ATTACHMENTS_PER_RUN)
    .default(DEFAULT_MAX_ATTACHMENTS_PER_RUN),
});

export type GoogleConfig = z.infer<typeof googleConfigSchema>;

export interface GoogleConfigSection {
  key: GoogleService;
  /** Section heading in the config form, and the "Enable …" checkbox label. */
  label: string;
  helpText: string;
  /** The standalone connector's OWN field specs, reused verbatim — the
   * merged form renders them under namespaced input names
   * (`gmail.query`, `drive.sources`, …) rather than redefining them. */
  fields: ConfigFieldSpec[];
}

/**
 * Drives both halves of the save round-trip: the three collapsible sections
 * GoogleIntegrationConfigForm renders, and the namespaced FormData parsing in
 * integrations/actions.ts. One list so the two can't drift.
 *
 * Exported from this (server-only) module and passed DOWN to the client form
 * as a prop, rather than imported by it — every connector `config.ts` is
 * `server-only`, so a Client Component importing the field specs directly
 * would fail the build. Same shape as how IntegrationConfigForm already
 * receives `fields`.
 */
export const GOOGLE_CONFIG_SECTIONS: GoogleConfigSection[] = [
  {
    key: "gmail",
    label: "Gmail",
    helpText: "Syncs mail from the connected account's mailbox.",
    fields: GMAIL_CONFIG_FIELDS,
  },
  {
    key: "drive",
    label: "Google Drive",
    helpText: "Syncs files in the folders and shared drives listed below.",
    fields: GOOGLE_DRIVE_CONFIG_FIELDS,
  },
  {
    key: "chat",
    label: "Google Chat",
    helpText: "Syncs messages from spaces the connected account is a member of.",
    fields: GOOGLE_CHAT_CONFIG_FIELDS,
  },
];

/** Per-service view of the three existing config entries, so the delegating
 * logic below never hardcodes which fields belong to which service. */
const SUB_ENTRIES = {
  gmail: { label: "Gmail", entry: gmailConfigEntry as ConnectorConfigSchema },
  drive: { label: "Drive", entry: googleDriveConfigEntry as ConnectorConfigSchema },
  chat: { label: "Chat", entry: googleChatConfigEntry as ConnectorConfigSchema },
} satisfies Record<GoogleService, { label: string; entry: ConnectorConfigSchema }>;

/** Local copy of integration-config.ts's scopeFingerprint. Deliberately NOT
 * imported from there: that module imports THIS one for its registry entry,
 * and a value (rather than type-only) import back would close a real runtime
 * cycle. The logic is four lines and stable. */
function subScopeFingerprint(entry: ConnectorConfigSchema, config: unknown): string | null {
  // `unknown`, not GoogleConfig's own slot type: the PREVIOUS config comes
  // straight out of jsonb (a pre-merge shape, `{}` on a fresh integration, or
  // anything a direct PostgREST write left behind), so anything that isn't an
  // object is treated as "not enabled" rather than trusted.
  if (!config || typeof config !== "object") return null;
  const picked: Record<string, unknown> = {};
  for (const key of entry.scopeFields) picked[key] = (config as Record<string, unknown>)[key];
  return JSON.stringify(picked);
}

export const googleConfigEntry: ConnectorConfigSchema<GoogleConfig> = {
  // Unused: this connector renders through GoogleIntegrationConfigForm (three
  // namespaced sections), not the flat field-spec form every other connector
  // uses. The per-service field specs it renders are still the sub-entries'
  // own GMAIL_CONFIG_FIELDS / GOOGLE_DRIVE_CONFIG_FIELDS /
  // GOOGLE_CHAT_CONFIG_FIELDS — nothing was forked to build that form.
  fields: [],
  schema: googleConfigSchema,
  scopeFields: ["gmail", "drive", "chat"],

  /** Configured once ANY enabled sub-service is itself configured — a
   * Gmail-only Google integration is a complete, syncable setup, and holding
   * the whole integration at "pending" until all three are filled in would
   * be wrong. */
  isConfigured(config) {
    return GOOGLE_SERVICES.some((service) => {
      const sub = config[service];
      if (sub === null) return false;
      const { entry } = SUB_ENTRIES[service];
      return entry.isConfigured ? entry.isConfigured(sub as Record<string, unknown>) : true;
    });
  },

  /** Runs each enabled sub-service's own live check (does this Drive folder
   * exist? is the connected account in this Chat space?) and prefixes the
   * message so a form error says WHICH section is wrong. Short-circuits on
   * the first failure — the form surfaces one error at a time anyway, and
   * every extra check is a real API round-trip inside a Server Action. */
  async resolve(config, ctx) {
    for (const service of GOOGLE_SERVICES) {
      const sub = config[service];
      if (sub === null) continue;
      const { entry, label } = SUB_ENTRIES[service];
      if (!entry.resolve) continue;
      const result = await entry.resolve(sub as Record<string, unknown>, ctx);
      if (!result.ok) return { ok: false, error: `${label}: ${result.error}` };
    }
    return { ok: true };
  },

  /**
   * Per-service cursor pruning. Without this, editing the Gmail query would
   * take Drive's and Chat's cursors down with it (the shared save path's
   * fallback is to delete the whole cursor row), re-backfilling two
   * untouched services on the next sync.
   *
   * A service's slot is dropped when ITS OWN scope fingerprint changed —
   * computed from that sub-entry's own `scopeFields`, with a disabled
   * (null) config fingerprinting as null. Toggling a service off and back
   * on therefore does cost a re-scan; that's the deliberate trade for not
   * silently replaying a stale Gmail `lastInternalDateMs` against a query
   * that changed while the service was off, which would skip matching mail
   * older than the cursor forever. A re-scan is idempotent (raw_events'
   * dedupe index), just slower once.
   */
  pruneCursorOnScopeChange(previousConfig, nextConfig, currentCursor) {
    if (!currentCursor || typeof currentCursor !== "object") return null;
    const pruned: Record<string, unknown> = { ...currentCursor };
    for (const service of GOOGLE_SERVICES) {
      const { entry } = SUB_ENTRIES[service];
      const before = subScopeFingerprint(entry, previousConfig[service]);
      const after = subScopeFingerprint(entry, nextConfig[service]);
      if (before !== after) pruned[service] = null;
    }
    return pruned;
  },
};
