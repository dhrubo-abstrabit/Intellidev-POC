import "server-only";
import { z } from "zod";
import { createDeadline } from "@/connectors/deadline";
import { googleFetch } from "@/connectors/google/client";
import { RESOLVE_FIELDS } from "./query";
import { parseDriveSourceUrl } from "./source-url";
import type { ConnectorConfigSchema, ConfigFieldSpec } from "@/lib/db/schemas/integration-config";

export const MAX_SOURCES = 10;
const RESOLVE_BUDGET_MS = 20_000;

function dedupeStrings(values: string[]): string[] {
  return [...new Set(values)];
}

/** Normalizes+validates one pasted line via parseDriveSourceUrl — applied
 * as a per-item transform so the config Zod schema is the single source of
 * truth for BOTH the write path (a raw textarea submission) and the read
 * path (fetchSince re-parsing whatever ended up in integrations.config,
 * including a hostile direct PostgREST write). */
const sourceItemSchema = z.string().transform((raw, ctx) => {
  const parsed = parseDriveSourceUrl(raw);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.reason });
    return z.NEVER;
  }
  return parsed.id;
});

export const googleDriveConfigSchema = z.object({
  sources: z
    .array(sourceItemSchema)
    .max(MAX_SOURCES, `At most ${MAX_SOURCES} folders/shared drives are supported.`)
    .default([])
    .transform(dedupeStrings),
  initialLookbackDays: z.coerce.number().int().min(1).max(365).catch(30).default(30),
  extractText: z.coerce.boolean().catch(true).default(true),
  maxTextFetchesPerRun: z.coerce.number().int().min(0).max(100).catch(25).default(25),
  maxTextChars: z.coerce.number().int().min(500).max(50_000).catch(20_000).default(20_000),
});

export type GoogleDriveConfig = z.infer<typeof googleDriveConfigSchema>;

export const GOOGLE_DRIVE_CONFIG_FIELDS: ConfigFieldSpec[] = [
  {
    key: "sources",
    kind: "text-list",
    label: "Folders & shared drives",
    placeholder: "https://drive.google.com/drive/folders/1AbCdEfGhIjKlMnOpQrStUvWxYz\none per line",
    helpText: "One folder or shared-drive URL per line. Subfolders are included automatically.",
  },
  {
    key: "initialLookbackDays",
    kind: "number",
    label: "Initial lookback (days)",
    min: 1,
    max: 365,
    helpText: "How far back to backfill on the first sync.",
  },
  {
    key: "extractText",
    kind: "boolean",
    label: "Extract document text",
    defaultChecked: true,
    helpText:
      "Pulls the text of Google Docs/Slides/Sheets (and small plain-text files) into the synced data, not just file metadata. " +
      "This sends document contents to the AI pipeline — leave off for metadata-only tracking.",
  },
  {
    key: "maxTextFetchesPerRun",
    kind: "number",
    label: "Max text extractions per sync",
    min: 0,
    max: 100,
    helpText: "Caps how many documents' text is fetched in a single sync run.",
  },
  {
    key: "maxTextChars",
    kind: "number",
    label: "Max characters per document",
    min: 500,
    max: 50_000,
    helpText: "Longer documents are truncated to this length.",
  },
];

interface DriveFileResolveResult {
  id: string;
  mimeType: string;
  trashed?: boolean;
}

export const googleDriveConfigEntry: ConnectorConfigSchema<GoogleDriveConfig> = {
  fields: GOOGLE_DRIVE_CONFIG_FIELDS,
  schema: googleDriveConfigSchema,
  scopeFields: ["sources"],
  isConfigured: (config) => config.sources.length > 0,
  // Confirms each pasted folder/drive is actually a folder and accessible
  // with the connected account's grant BEFORE saving — without this, a
  // typo'd id would silently produce zero events until noticed a day later.
  async resolve(config, { credentials }) {
    if (config.sources.length === 0) return { ok: true };
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return { ok: false, error: "This integration has no access token on file — reconnect it." };

    const deadline = createDeadline(RESOLVE_BUDGET_MS);
    const problems: string[] = [];
    for (const id of config.sources) {
      try {
        const file = await googleFetch<DriveFileResolveResult>(
          `https://www.googleapis.com/drive/v3/files/${id}?supportsAllDrives=true&fields=${RESOLVE_FIELDS}`,
          { accessToken, deadline, maxAttempts: 1 },
        );
        if (file.trashed) {
          problems.push(`${id} (in trash)`);
        } else if (file.mimeType !== "application/vnd.google-apps.folder") {
          problems.push(`${id} (not a folder)`);
        }
      } catch {
        // Some shared drives don't resolve via files.get — fall back to
        // asking whether it's a shared drive at all before giving up.
        try {
          await googleFetch(`https://www.googleapis.com/drive/v3/drives/${id}`, { accessToken, deadline, maxAttempts: 1 });
        } catch {
          problems.push(id);
        }
      }
    }
    if (problems.length > 0) {
      return {
        ok: false,
        error: `Not accessible as a folder or shared drive with this Google account: ${problems.join(", ")}.`,
      };
    }
    return { ok: true };
  },
};
