/**
 * Normalizes whatever a user pastes into the Drive config form (a folder
 * URL, a shared-drive URL, or a bare id) into a plain Drive file/drive id.
 * Pure and side-effect-free — used from the config Zod schema's per-item
 * transform, so the same rules apply whether the id came from a form
 * submission or a hostile direct PostgREST write.
 *
 * Deliberately does NOT try to tell a shared-drive root apart from an
 * ordinary folder from the URL shape alone — Drive serves both at
 * `/drive/folders/<id>`, and prefix heuristics (`0A…` vs `1…`) are folklore
 * that breaks on legacy ids. That disambiguation is a one-request API
 * question, done lazily against the live API (config.ts's `resolve` for an
 * immediate check; index.ts's fetchSince for the authoritative one, cached
 * in the cursor — never in config, which is client-writable).
 */
export type ParsedDriveSource = { ok: true; id: string } | { ok: false; reason: string };

// Drive file/drive ids are base64url-ish tokens. This charset gate is a
// security boundary, not just hygiene: the id is interpolated into a Drive
// `q` string (`'<id>' in parents`), and a stray quote could break out of
// the quoted literal. escapeDriveQueryLiteral() in query.ts is the second
// layer of defense applied at the actual interpolation site.
const DRIVE_ID_PATTERN = /^[A-Za-z0-9_-]{10,200}$/;

function withId(id: string): ParsedDriveSource {
  if (!DRIVE_ID_PATTERN.test(id)) {
    return { ok: false, reason: `"${id}" doesn't look like a valid Drive id.` };
  }
  return { ok: true, id };
}

export function parseDriveSourceUrl(rawInput: string): ParsedDriveSource {
  const input = rawInput.trim();
  if (!input) return { ok: false, reason: "empty" };

  let url: URL | null = null;
  try {
    url = new URL(input);
  } catch {
    // Not a URL — treat the whole trimmed input as a bare id.
    return withId(input);
  }

  if (/\/(my-drive|shared-drives)(\/|$)/.test(url.pathname)) {
    return { ok: false, reason: "Paste a specific folder or shared drive, not all of My Drive." };
  }
  if (/\/file\/d\//.test(url.pathname) || url.hostname === "docs.google.com") {
    return { ok: false, reason: "That's a single file/document, not a folder — paste the containing folder's URL instead." };
  }

  // /drive/folders/<id>, /drive/u/<n>/folders/<id> — the /u/<n>/ segment is
  // a browser-profile artifact, not part of any API identity, so it's
  // simply not matched by this pattern rather than stripped explicitly.
  const folderMatch = url.pathname.match(/\/folders\/([A-Za-z0-9_-]+)/);
  if (folderMatch) return withId(folderMatch[1]);

  return { ok: false, reason: `Couldn't find a folder id in "${input}".` };
}
