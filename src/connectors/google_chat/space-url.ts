/**
 * Normalizes whatever a user pastes into the config form (a Chat URL, a
 * `spaces/<id>` resource name, or a bare id) into the canonical
 * `spaces/<id>` resource name the Chat API expects everywhere. Pure and
 * side-effect-free so it's directly unit-testable, and used from BOTH the
 * config Zod schema's per-item transform (config.ts) and — by that same
 * schema being shared — the connector's own read path, so a hostile direct
 * PostgREST write is normalized/rejected exactly the same way a form
 * submission is.
 */
export type ParsedChatSpace = { ok: true; spaceName: string } | { ok: false; reason: string };

// Chat space/room ids are opaque alphanumeric-ish tokens. This charset gate
// is a security boundary, not just hygiene: spaceName is interpolated into
// the Chat API request URL path, so a stray `/` or `?` could smuggle in an
// unintended path segment or query param.
const SPACE_ID_PATTERN = /^[A-Za-z0-9_-]{5,100}$/;

function withSpaceId(id: string): ParsedChatSpace {
  if (!SPACE_ID_PATTERN.test(id)) {
    return { ok: false, reason: `"${id}" doesn't look like a valid Chat space id.` };
  }
  return { ok: true, spaceName: `spaces/${id}` };
}

export function parseChatSpaceInput(rawInput: string): ParsedChatSpace {
  const input = rawInput.trim();
  if (!input) return { ok: false, reason: "empty" };

  // Already in resource-name form (e.g. round-tripping a previously saved,
  // already-normalized value).
  const resourceNameMatch = input.match(/^spaces\/([A-Za-z0-9_-]+)$/);
  if (resourceNameMatch) return withSpaceId(resourceNameMatch[1]);

  // A pasted Chat URL. Google has shipped at least three different shapes
  // for the same thing over time — https://mail.google.com/chat/u/0/#chat/
  // space/<id> (Gmail-integrated Chat, hash-based), https://chat.google.com/
  // room/<id> (older standalone app), and https://chat.google.com/app/chat/
  // <id> (current standalone app, confirmed against a real link — see
  // space-url.test.ts). Rather than chase every prefix Google has used
  // across UI redesigns, only the hash-based shape is pattern-matched
  // explicitly; every other shape is handled by taking the URL's LAST path
  // segment and validating it against the id charset — a segment that's
  // too short (e.g. an account index like the "0" in "/u/0/") or has
  // invalid characters just falls through to the rejection below.
  try {
    const url = new URL(input);
    const hashMatch = url.hash.match(/(?:space|room|dm)\/([A-Za-z0-9_-]+)/);
    if (hashMatch) return withSpaceId(hashMatch[1]);

    const pathSegments = url.pathname.split("/").filter(Boolean);
    const lastSegment = pathSegments[pathSegments.length - 1];
    if (lastSegment && SPACE_ID_PATTERN.test(lastSegment)) return withSpaceId(lastSegment);

    return { ok: false, reason: `Couldn't find a space id in "${input}".` };
  } catch {
    // Not a URL — treat the whole trimmed input as a bare id.
    return withSpaceId(input);
  }
}
