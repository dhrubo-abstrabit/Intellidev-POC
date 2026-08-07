import "server-only";
import { z } from "zod";
import { createDeadline } from "@/connectors/deadline";
import { googleFetch } from "@/connectors/google/client";
import type { ConnectorConfigSchema, ConfigFieldSpec } from "@/lib/db/schemas/integration-config";
import { parseChatSpaceInput } from "./space-url";

// Bounds the per-run request count: fetchSince makes ~1 request per
// configured space per page, and a sync runs inside a 60s function.
export const MAX_CHAT_SPACES = 25;

const RESOLVE_BUDGET_MS = 15_000;

/** Normalizes+validates one pasted line via parseChatSpaceInput. Applied as
 * a per-item transform so the SAME schema instance handles both a raw
 * textarea submission (URLs, bare ids) and an already-normalized value read
 * back from a hostile direct PostgREST write — either way the connector's
 * own fetchSince only ever sees canonical `spaces/<id>` strings. */
const spaceItemSchema = z.string().transform((raw, ctx) => {
  const parsed = parseChatSpaceInput(raw);
  if (!parsed.ok) {
    ctx.addIssue({ code: "custom", message: parsed.reason });
    return z.NEVER;
  }
  return parsed.spaceName;
});

export const googleChatConfigSchema = z.object({
  spaceIds: z.array(spaceItemSchema).max(MAX_CHAT_SPACES, `At most ${MAX_CHAT_SPACES} spaces are supported.`).default([]),
  // Default true: raw `users/<id>` actors are close to useless for the
  // action-item pipeline. An off-switch exists for orgs where the
  // Directory API is restricted (every lookup would just fail every run)
  // or where resolving names isn't wanted for privacy reasons.
  resolveSenderNames: z.coerce.boolean().catch(true).default(true),
});

export type GoogleChatConfig = z.infer<typeof googleChatConfigSchema>;

export const GOOGLE_CHAT_CONFIG_FIELDS: ConfigFieldSpec[] = [
  {
    key: "spaceIds",
    kind: "text-list",
    label: "Chat spaces",
    placeholder: "https://mail.google.com/chat/u/0/#chat/space/AAAAAAAAAAA\nor just the space id, one per line",
    helpText:
      "One space URL or id per line. The connected Google account must be a member of each space — Chat only returns spaces it's already in.",
  },
  {
    key: "resolveSenderNames",
    kind: "boolean",
    label: "Resolve sender names",
    defaultChecked: true,
    helpText:
      "Looks up each message sender's name/email via your Workspace directory, instead of showing a raw account id. Requires reconnecting if this integration was connected before this option existed.",
  },
];

interface ChatSpace {
  name: string;
  spaceType?: string;
}

export const googleChatConfigEntry: ConnectorConfigSchema<GoogleChatConfig> = {
  fields: GOOGLE_CHAT_CONFIG_FIELDS,
  schema: googleChatConfigSchema,
  scopeFields: ["spaceIds"],
  isConfigured: (config) => config.spaceIds.length > 0,
  // Confirms each configured space is actually visible to the connected
  // account BEFORE saving — without this, a typo'd or inaccessible space id
  // would silently produce zero events until someone notices, a day later,
  // in integrations.last_error.
  async resolve(config, { credentials }) {
    if (config.spaceIds.length === 0) return { ok: true };
    const accessToken = credentials.tokens.access_token as string | undefined;
    if (!accessToken) return { ok: false, error: "This integration has no access token on file — reconnect it." };

    const deadline = createDeadline(RESOLVE_BUDGET_MS);
    const inaccessible: string[] = [];
    for (const spaceName of config.spaceIds) {
      try {
        await googleFetch<ChatSpace>(`https://chat.googleapis.com/v1/${spaceName}`, { accessToken, deadline, maxAttempts: 1 });
      } catch {
        inaccessible.push(spaceName);
      }
    }
    if (inaccessible.length > 0) {
      return {
        ok: false,
        error: `Not accessible with this Google account: ${inaccessible.join(", ")}. Invite the connected account to each space and try again.`,
      };
    }
    return { ok: true };
  },
};
