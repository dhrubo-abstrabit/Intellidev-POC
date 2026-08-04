import { z } from "zod";

// Mirrors the DB CHECK constraint in supabase/migrations/20260803150400_tenancy.sql
// (`slug ~ '^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$'`) — kept in sync by hand since
// the constraint isn't introspectable into a Zod schema.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,48}[a-z0-9]$/;

// Combining Diacritical Marks block boundaries (Unicode code points, not
// characters) — the range NFKD normalization decomposes accents into, e.g.
// "e" + COMBINING ACUTE ACCENT. Expressed as numeric bounds and filtered by
// codePointAt rather than a regex Unicode range, so the source file contains
// only ASCII bytes and can't be silently corrupted by an encoding round-trip.
const COMBINING_MARKS_START = 0x0300;
const COMBINING_MARKS_END = 0x036f;

function stripCombiningMarks(input: string): string {
  return Array.from(input)
    .filter((char) => {
      const codePoint = char.codePointAt(0) ?? 0;
      return codePoint < COMBINING_MARKS_START || codePoint > COMBINING_MARKS_END;
    })
    .join("");
}

export const createWorkspaceSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(120),
});
export type CreateWorkspaceInput = z.infer<typeof createWorkspaceSchema>;

export const createProjectSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(160),
  description: z.string().trim().max(2000).optional(),
});
export type CreateProjectInput = z.infer<typeof createProjectSchema>;

/**
 * Derive a URL-safe slug from a display name, then guarantee it satisfies
 * the DB's length/charset constraint even for edge-case input (all-symbol
 * names, single characters, non-Latin scripts that strip to nothing).
 */
export function slugify(name: string): string {
  const base = stripCombiningMarks(name.toLowerCase().normalize("NFKD"))
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  const padded = base.length < 3 ? `${base || "ws"}-${Math.random().toString(36).slice(2, 6)}` : base;
  const truncated = padded.slice(0, 50);
  return SLUG_RE.test(truncated) ? truncated : `ws-${Math.random().toString(36).slice(2, 10)}`;
}
