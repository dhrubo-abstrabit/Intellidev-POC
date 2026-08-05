/**
 * Timezone-correct "which project-local day is this instant in" helpers.
 *
 * A day in a project's timezone is not a UTC day, and PostgREST can't
 * express `(occurred_at at time zone tz)::date` without a migration (an RPC
 * or view, plus regenerating database.types.ts). So instead of pushing the
 * bucketing into SQL, callers over-fetch a UTC window that's guaranteed to
 * contain the whole local day (see utcWindowForDay) and then bucket the rows
 * in JS with projectDayKey. Intl does the offset/DST math, so there's no
 * hand-rolled arithmetic to get wrong.
 *
 * src/services/action-items/generate.ts has its own projectLocalDate() that
 * does the same "today" computation as projectToday() below — that one is
 * covered by an integration test billing the real Anthropic API, so it's
 * left alone rather than refactored to share this module. Consolidate
 * separately if it comes up again.
 */

const DAY_KEY_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();
const TIME_LABEL_FORMATTER_CACHE = new Map<string, Intl.DateTimeFormat>();

function dayKeyFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = DAY_KEY_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    // en-CA formats as YYYY-MM-DD, matching the for_date column's shape —
    // the same trick generate.ts uses.
    formatter = new Intl.DateTimeFormat("en-CA", { timeZone });
    DAY_KEY_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

function timeLabelFormatter(timeZone: string): Intl.DateTimeFormat {
  let formatter = TIME_LABEL_FORMATTER_CACHE.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
    TIME_LABEL_FORMATTER_CACHE.set(timeZone, formatter);
  }
  return formatter;
}

/** "2026-08-01" for the given instant in the project's timezone. */
export function projectDayKey(iso: string, timeZone: string): string {
  return dayKeyFormatter(timeZone).format(new Date(iso));
}

/** Today's day key in the project's timezone. */
export function projectToday(timeZone: string): string {
  return dayKeyFormatter(timeZone).format(new Date());
}

/** "10:59" — 24h, project-local. formatItemDate() (components/items/format)
 * deliberately drops the time component; this is the time-only counterpart
 * used where a message's time of day matters, e.g. the Project Data tab. */
export function projectTimeLabel(iso: string, timeZone: string): string {
  return timeLabelFormatter(timeZone).format(new Date(iso));
}

/** ISO instant `days` ago from now. Exists so callers (Server Components,
 * where the React compiler's purity lint flags a bare `Date.now()` in the
 * render body) go through one impure call site instead of each rolling
 * their own. */
export function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

/**
 * Half-open UTC bounds ([gte, lt)) guaranteed to contain every instant that
 * falls on `dayKey` in *some* timezone offset from UTC-12 to UTC+14 — i.e. a
 * full UTC day either side of the nominal date. Callers MUST still filter
 * the resulting rows with projectDayKey(row.occurred_at, timeZone) — this
 * only bounds the query, it doesn't do the bucketing.
 */
export function utcWindowForDay(dayKey: string): { gte: string; lt: string } {
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  const gte = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const lt = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
  return { gte: gte.toISOString(), lt: lt.toISOString() };
}
