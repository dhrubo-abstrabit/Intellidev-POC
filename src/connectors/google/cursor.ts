/**
 * Cursor shape for the merged `google` connector, plus the pure helpers
 * around it. One nested slot per sub-service, each holding VERBATIM the
 * cursor that sub-connector already produced on its own — nothing is
 * re-interpreted here, so Gmail/Drive/Chat keep owning (and keep
 * defensively re-parsing) their own resume state.
 *
 * Pure on purpose: run-sync.ts persists exactly one cursor row per
 * integration, so the "which service resumed where" logic is the highest-
 * risk part of the merge and is directly unit-testable.
 */
import type { GmailCursor } from "@/connectors/gmail";
import type { GoogleChatCursor } from "@/connectors/google_chat";
import type { GoogleDriveCursor } from "@/connectors/google_drive/cursor";

/** The three sub-services the one Google grant covers. Mirrored (as a
 * string union only) by GoogleService in components/items/provider-badge.tsx
 * — the UI side can't import this module, which pulls in server-only
 * connector code. */
export type GoogleService = "gmail" | "drive" | "chat";

export const GOOGLE_SERVICES: readonly GoogleService[] = ["gmail", "drive", "chat"];

export interface GoogleCursor {
  provider: "google";
  v: 1;
  /** null = this service has never run (or was disabled before it ever
   * did). A slot is NEVER cleared just because its service is currently
   * disabled — re-enabling Drive months later must resume from where it
   * stopped, not re-backfill a whole folder tree. */
  gmail: GmailCursor | null;
  drive: GoogleDriveCursor | null;
  chat: GoogleChatCursor | null;
  /** Which service was fetched LAST in the previous run. fetchSince rotates
   * it to the back of the queue next time (see rotatePriority) so a service
   * with a large backlog, which will eat its whole slice every run, can't
   * permanently starve the ones queued behind it. */
  lastPriorityService?: GoogleService;
}

export function emptyGoogleCursor(): GoogleCursor {
  return { provider: "google", v: 1, gmail: null, drive: null, chat: null };
}

function subCursorOrNull<T>(value: unknown): T | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as T) : null;
}

/**
 * Any shape not recognized (absent, a stale version, corrupted jsonb, one of
 * the three PRE-MERGE per-provider cursors that a legacy row still carries)
 * degrades to "no cursor yet" rather than throwing — matching
 * google_drive/cursor.ts's parseCursor and gmail's parseCursor exactly. A
 * from-scratch bootstrap is idempotent (raw_events' dedupe index absorbs the
 * re-ingest), just slower once, which is a far better failure mode than
 * throwing out of a sync job nobody is watching.
 *
 * Sub-cursors are passed through as opaque objects on purpose: each
 * sub-connector re-parses its own slot defensively anyway, so validating
 * their internals twice would only add a second place to keep in sync.
 */
export function parseGoogleCursor(raw: unknown): GoogleCursor {
  if (!raw || typeof raw !== "object") return emptyGoogleCursor();
  const candidate = raw as { v?: unknown; provider?: unknown; lastPriorityService?: unknown } & Record<string, unknown>;
  if (candidate.v !== 1 || candidate.provider !== "google") return emptyGoogleCursor();

  const lastPriorityService = GOOGLE_SERVICES.includes(candidate.lastPriorityService as GoogleService)
    ? (candidate.lastPriorityService as GoogleService)
    : undefined;

  return {
    provider: "google",
    v: 1,
    gmail: subCursorOrNull<GmailCursor>(candidate.gmail),
    drive: subCursorOrNull<GoogleDriveCursor>(candidate.drive),
    chat: subCursorOrNull<GoogleChatCursor>(candidate.chat),
    ...(lastPriorityService ? { lastPriorityService } : {}),
  };
}

/**
 * Stable round-robin: whichever service ran LAST last time goes last again
 * this time, and everything that was queued behind it moves to the front.
 * `["gmail","drive","chat"]` with lastPriority `"gmail"` becomes
 * `["drive","chat","gmail"]`.
 *
 * Returns `enabled` unchanged when lastPriority is undefined or no longer
 * enabled — a service that was just disabled must not silently reshuffle the
 * order of the ones that remain.
 */
export function rotatePriority<T extends string>(enabled: readonly T[], lastPriority: T | undefined): T[] {
  if (lastPriority === undefined) return [...enabled];
  const index = enabled.indexOf(lastPriority);
  if (index === -1) return [...enabled];
  return [...enabled.slice(index + 1), ...enabled.slice(0, index), enabled[index]];
}
