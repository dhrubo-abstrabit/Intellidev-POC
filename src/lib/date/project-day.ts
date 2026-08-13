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

/** Offset of `timeZone` from UTC, in minutes, at `instant` (positive east of
 * UTC). Used to convert a project-local wall-clock instant to its UTC
 * equivalent without a date library — Intl already knows every zone's
 * offset/DST rules. */
function tzOffsetMinutes(instant: Date, timeZone: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hourCycle: "h23",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  })
    .formatToParts(instant)
    .reduce((acc: Record<string, string>, p) => {
      acc[p.type] = p.value;
      return acc;
    }, {});
  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return (asIfUtc - instant.getTime()) / 60_000;
}

/** The exact UTC instant of local midnight for `dayKey` in `timeZone` — e.g.
 * "2026-08-01" in "Asia/Kolkata" (UTC+5:30) is "2026-07-31T18:30:00.000Z".
 * Two-pass: the offset can differ right around a DST transition, so the
 * first pass's offset (measured at the naive UTC-midnight guess) is used to
 * refine the instant, then re-measured at that refined instant. */
function zonedDayStartUtc(dayKey: string, timeZone: string): string {
  const naiveUtc = new Date(`${dayKey}T00:00:00.000Z`);
  const offset1 = tzOffsetMinutes(naiveUtc, timeZone);
  const refined = new Date(naiveUtc.getTime() - offset1 * 60_000);
  const offset2 = tzOffsetMinutes(refined, timeZone);
  return offset2 === offset1 ? refined.toISOString() : new Date(naiveUtc.getTime() - offset2 * 60_000).toISOString();
}

/** "2026-08-02" given "2026-08-01" — plain calendar-day arithmetic, which
 * needs no timezone: a Gregorian day boundary is the same the world over. */
function nextDayKey(dayKey: string): string {
  const d = new Date(`${dayKey}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

/**
 * Half-open UTC bounds ([gte, lt)) for `dayKey`.
 *
 * Called without `timeZone`, this brackets every instant that falls on
 * `dayKey` in *some* timezone offset from UTC-12 to UTC+14 — i.e. a full UTC
 * day either side of the nominal date. Callers MUST still filter the
 * resulting rows with projectDayKey(row.occurred_at, timeZone) — this only
 * bounds the query, it doesn't do the bucketing. Use this shape when you
 * need to over-fetch and bucket precisely afterward (e.g. paging through a
 * single day's own events).
 *
 * Called with `timeZone`, the bounds are exact — dayKey's own local midnight
 * and the next day's local midnight, both converted to UTC, with no buffer.
 * Use this shape for a cutoff comparison (e.g. "strictly before dayKey's own
 * local day") where a full extra day of slop would wrongly exclude events
 * that are unambiguously already in the past for that project's actual
 * timezone — no further bucketing needed, the bound is already precise.
 */
export function utcWindowForDay(dayKey: string, timeZone?: string): { gte: string; lt: string } {
  if (timeZone) {
    return { gte: zonedDayStartUtc(dayKey, timeZone), lt: zonedDayStartUtc(nextDayKey(dayKey), timeZone) };
  }
  const start = new Date(`${dayKey}T00:00:00.000Z`);
  const gte = new Date(start.getTime() - 24 * 60 * 60 * 1000);
  const lt = new Date(start.getTime() + 2 * 24 * 60 * 60 * 1000);
  return { gte: gte.toISOString(), lt: lt.toISOString() };
}
