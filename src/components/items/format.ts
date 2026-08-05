import { format, parseISO } from "date-fns";

/** "05/Aug/2026" — used everywhere a date/timestamp column (for_date,
 * due_at, snoozed_until) is displayed, so they read consistently regardless
 * of the viewer's browser locale (unlike toLocaleDateString()). */
export function formatItemDate(value: string): string {
  return format(parseISO(value), "dd/MMM/yyyy");
}
