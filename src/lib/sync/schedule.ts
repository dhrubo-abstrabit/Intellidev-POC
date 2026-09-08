// Deliberately NOT `server-only`: sync-schedule-form.tsx (a client component)
// imports SYNC_INTERVAL_PRESETS/SYNC_SCHEDULE_UNITS directly, the same reason
// GoogleConfigFormSection is redeclared rather than imported in
// google-integration-config-form.tsx. This also can't live in
// src/lib/db/schemas/integration-config.ts, which transitively pulls in
// `server-only` via @/connectors/google/config.
//
// One Zod-schema-adjacent module, used on both the client (live validation
// messages as the user types) and the server (saveSyncSchedule's actual
// validation) — parseScheduleParts is the single implementation both call,
// so they can't disagree about what's valid.

// Mirrors project_connectors.sync_interval_seconds' own CHECK constraint
// (supabase/migrations/20260901000800_connectors.sql) — kept in sync by hand
// since a DB CHECK has no TypeScript-readable source of truth.
export const MIN_SYNC_INTERVAL_SECONDS = 60;
export const MAX_SYNC_INTERVAL_SECONDS = 86_400;

export const CUSTOM_PRESET_VALUE = "custom";

interface SyncIntervalPresetDef {
  seconds: number;
  /** Lowercase, embeddable mid-sentence — "Syncs {phrase}." */
  phrase: string;
}

const PRESET_DEFS: readonly SyncIntervalPresetDef[] = [
  { seconds: 900, phrase: "every 15 minutes" },
  { seconds: 1800, phrase: "every 30 minutes" },
  { seconds: 3600, phrase: "every hour" },
  { seconds: 21600, phrase: "every 6 hours" },
  { seconds: 43200, phrase: "every 12 hours" },
  { seconds: 86400, phrase: "once a day" },
];

function capitalize(phrase: string): string {
  return phrase.length ? phrase[0].toUpperCase() + phrase.slice(1) : phrase;
}

export interface SyncIntervalPreset {
  /** The <Select> option value — the raw second count as a string, so the
   * non-custom path is a whitelist lookup with no second mapping table and
   * the form value IS the DB value. */
  value: string;
  seconds: number;
  /** Capitalized, for the preset dropdown and the header summary badge. */
  label: string;
}

export const SYNC_INTERVAL_PRESETS: readonly SyncIntervalPreset[] = PRESET_DEFS.map((p) => ({
  value: String(p.seconds),
  seconds: p.seconds,
  label: capitalize(p.phrase),
}));

export type SyncScheduleUnit = "minutes" | "hours";

export const SYNC_SCHEDULE_UNITS: readonly { value: SyncScheduleUnit; label: string; seconds: number }[] = [
  { value: "minutes", label: "Minutes", seconds: 60 },
  { value: "hours", label: "Hours", seconds: 3600 },
];

/** Exact match against a known preset, else "custom" — seeds the preset
 * <Select>'s defaultValue from a saved sync_interval_seconds. */
export function secondsToPresetValue(seconds: number): string {
  const match = SYNC_INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  return match ? match.value : CUSTOM_PRESET_VALUE;
}

/** Seeds the custom amount/unit fields even when a preset is currently
 * active, so switching a preset connector to "Custom" shows a sensible
 * starting value instead of an empty box. Prefers whole hours; falls back to
 * minutes (rounded, floored at 1) for anything that isn't an exact multiple
 * of an hour. */
export function secondsToCustomParts(seconds: number): { amount: number; unit: SyncScheduleUnit } {
  if (seconds > 0 && seconds % 3600 === 0) {
    return { amount: seconds / 3600, unit: "hours" };
  }
  return { amount: Math.max(1, Math.round(seconds / 60)), unit: "minutes" };
}

/** Lowercase, embeddable phrase — "every 45 minutes", "every hour", "once a
 * day". Prefers a preset's own phrase on an exact match (so 3600 reads
 * "every hour", not "every 60 minutes"). */
export function secondsToLabel(seconds: number): string {
  const preset = PRESET_DEFS.find((p) => p.seconds === seconds);
  if (preset) return preset.phrase;
  if (seconds > 0 && seconds % 3600 === 0) {
    const hours = seconds / 3600;
    return `every ${hours} hour${hours === 1 ? "" : "s"}`;
  }
  const minutes = Math.max(1, Math.round(seconds / 60));
  return `every ${minutes} minute${minutes === 1 ? "" : "s"}`;
}

/** In-form summary line under the schedule controls. */
export function describeSchedule(seconds: number, syncEnabled: boolean): string {
  return syncEnabled ? `Syncs ${secondsToLabel(seconds)}.` : "Automatic syncing is paused.";
}

/** Short, capitalized form for the always-visible card-header badge (the
 * schedule control itself lives inside a collapsed-by-default panel, so this
 * is what makes the setting discoverable without expanding the card). */
export function scheduleBadgeLabel(seconds: number, syncEnabled: boolean): string {
  if (!syncEnabled) return "Paused";
  const preset = SYNC_INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  return preset ? preset.label : capitalize(secondsToLabel(seconds));
}

export type ParsedSchedule = { ok: true; intervalSeconds: number } | { ok: false; error: string };

// Bounds amount * unitSeconds (max unit is 3600) to at most ~3.6e10 — three
// orders of magnitude inside Number.MAX_SAFE_INTEGER, so the multiplication
// below can never lose precision or overflow to Infinity. Also rejects
// anything a whole-number-of-minutes-or-hours picker should never produce:
// decimals ("1.5"), negatives ("-5"), exponential notation ("1e3"), and
// non-numeric input ("abc", "Infinity", "NaN") all fail this pattern before
// they ever reach Number(...).
const CUSTOM_AMOUNT_PATTERN = /^\d{1,7}$/;

/** The single validation implementation shared by the client's live
 * range-check and the Server Action's authoritative check — rejects with a
 * friendly message rather than silently clamping, so a value out of
 * [MIN_SYNC_INTERVAL_SECONDS, MAX_SYNC_INTERVAL_SECONDS] never reaches
 * Postgres as a raw 23514. A tampered `preset` value is checked against the
 * whitelist, not just "is it custom or not" — that way a hand-crafted
 * request can't smuggle in an interval that was never actually offered. */
export function parseScheduleParts(
  preset: string | null | undefined,
  amount: string | null | undefined,
  unit: string | null | undefined,
): ParsedSchedule {
  if (!preset) {
    return { ok: false, error: "Choose how often this connector should sync." };
  }

  if (preset !== CUSTOM_PRESET_VALUE) {
    const match = SYNC_INTERVAL_PRESETS.find((p) => p.value === preset);
    if (!match) {
      return { ok: false, error: "That sync frequency isn't available." };
    }
    return { ok: true, intervalSeconds: match.seconds };
  }

  const trimmedAmount = (amount ?? "").trim();
  if (!trimmedAmount) {
    return { ok: false, error: "Enter how often this connector should sync." };
  }
  if (!CUSTOM_AMOUNT_PATTERN.test(trimmedAmount)) {
    return { ok: false, error: "Sync interval must be a whole number of minutes or hours." };
  }

  const unitDef = SYNC_SCHEDULE_UNITS.find((u) => u.value === unit);
  if (!unitDef) {
    return { ok: false, error: "Choose minutes or hours." };
  }

  const intervalSeconds = Number(trimmedAmount) * unitDef.seconds;
  if (intervalSeconds < MIN_SYNC_INTERVAL_SECONDS) {
    return { ok: false, error: "Syncs can run at most once a minute — choose 1 minute or more." };
  }
  if (intervalSeconds > MAX_SYNC_INTERVAL_SECONDS) {
    return { ok: false, error: "Syncs must run at least once a day — choose 24 hours or less." };
  }
  return { ok: true, intervalSeconds };
}

export function parseScheduleFormData(formData: FormData): ParsedSchedule {
  return parseScheduleParts(
    formData.get("syncPreset") as string | null,
    formData.get("syncCustomAmount") as string | null,
    formData.get("syncCustomUnit") as string | null,
  );
}

/** Providers that merged into `google` and no longer have a connector
 * registered (see connectors/registry.ts). Hoisted here rather than kept
 * private to the Integrations page so saveSyncSchedule can apply the same
 * guard — it's a public POST endpoint, not just a page render, so the page
 * hiding the schedule form for these isn't sufficient on its own. */
export const RETIRED_GOOGLE_PROVIDERS = ["gmail", "google_drive", "google_chat"];
