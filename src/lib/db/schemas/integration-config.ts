import type { z } from "zod";
import type { ConnectorId, ConnectorCredentials } from "@/connectors/types";

/**
 * Declarative description of one field in a connector's config form —
 * lets integration-config-form.tsx render Chat's space-id list, Drive's
 * folder-url list + numeric knobs, and Gmail's query + toggles from the
 * same component instead of a bespoke form per provider. This repo has no
 * generic <Form>/<FormField> abstraction (see src/components/ui/), so a
 * small declarative spec is the alternative to either a giant per-provider
 * component or unstructured `formData.get(...)` calls scattered around.
 */
export type ConfigFieldSpec =
  | { key: string; kind: "text-list"; label: string; placeholder?: string; helpText?: string }
  | { key: string; kind: "text"; label: string; placeholder?: string; helpText?: string }
  | { key: string; kind: "number"; label: string; helpText?: string; min?: number; max?: number }
  | { key: string; kind: "boolean"; label: string; helpText?: string; defaultChecked?: boolean };

export interface ConfigResolveContext {
  credentials: ConnectorCredentials;
}

export interface ConnectorConfigSchema<T extends Record<string, unknown> = Record<string, unknown>> {
  /** Renders the config form — see integration-config-form.tsx. */
  fields: ConfigFieldSpec[];
  /** Parses+validates the FormData-derived raw object. Every scalar field
   * should degrade via `.catch(default)` on garbage input (config is
   * client-writable via PostgREST after this initial save too, so the
   * connector itself re-parses with this SAME schema at fetchSince time —
   * this is the one Zod schema both the write path and the read path use,
   * so they can't disagree). Structural violations (too many list entries,
   * a malformed id) should fail .safeParse so the form shows a field error
   * instead of silently saving something the connector will reject later. */
  schema: z.ZodType<T>;
  /** Field keys that define WHERE this connector reads from (e.g. Drive's
   * `sources`, Chat's `spaceIds`, Gmail's `query`). When any of these
   * change on save, the integration's cursor is cleared — a cursor built
   * for the old scope must not be reused for a new one (e.g. a stale
   * `modifiedTimeFloor` from a totally different Drive folder). */
  scopeFields: string[];
  /** Whether this config has enough scope to sync anything — drives the
   * pending -> connected transition for Google connectors that land
   * "pending" straight out of OAuth (see api/oauth/[provider]/callback).
   * Defaults to "true" (via isConfigScoped below) for connectors that
   * don't have this concept. */
  isConfigured?(config: T): boolean;
  /** Optional live check against the provider's API — e.g. "does this
   * Drive folder exist and is it accessible with this grant?" Returning
   * ok:false surfaces the message as an immediate form error instead of a
   * silent save that only fails a day later in integrations.last_error. */
  resolve?(config: T, ctx: ConfigResolveContext): Promise<{ ok: true } | { ok: false; error: string }>;
}

/**
 * Mirrors connectors/registry.ts's own pattern exactly: adding a new
 * connector's config means one new `config.ts` module next to its
 * `index.ts`, plus one import + one entry here — never a change to the
 * config UI or Server Action, which only ever go through this map. Starts
 * empty; Phases building google_chat/google_drive/gmail each add their
 * entry (a connector with no entry here simply renders no config form —
 * see integrations/page.tsx).
 */
const schemas: Partial<Record<ConnectorId, ConnectorConfigSchema>> = {};

export function getConfigSchema(provider: ConnectorId): ConnectorConfigSchema | undefined {
  return schemas[provider];
}

export function isConfigScoped<T extends Record<string, unknown>>(entry: ConnectorConfigSchema<T>, config: T): boolean {
  return entry.isConfigured ? entry.isConfigured(config) : true;
}

/** Extracts just the scope-defining fields, for cursor-invalidation
 * comparisons — plain JSON equality is enough since every field is a
 * primitive or an array of primitives. */
export function scopeFingerprint<T extends Record<string, unknown>>(entry: ConnectorConfigSchema<T>, config: T): string {
  const picked: Record<string, unknown> = {};
  for (const key of entry.scopeFields) picked[key] = config[key];
  return JSON.stringify(picked);
}
