/**
 * Pure MIME helpers for Gmail's `messages.get?format=full` payload shape.
 * The highest-value unit-tested surface in this connector — everything
 * here is lossy and locale/client-specific by nature (quoted-reply
 * stripping especially), which is exactly why it's applied only to
 * normalized_events.body; raw_events keeps the untouched payload so the
 * heuristics here can be improved and replayed later without re-fetching
 * anything from Gmail.
 */

export interface GmailHeader {
  name?: string;
  value?: string;
}

export interface GmailMessagePart {
  mimeType?: string;
  filename?: string;
  headers?: GmailHeader[];
  body?: { size?: number; data?: string; attachmentId?: string };
  parts?: GmailMessagePart[];
}

/** Gmail's header casing isn't stable across messages (`Message-ID` and
 * `Message-Id` both occur in the wild) — always match case-insensitively. */
export function header(headers: GmailHeader[] | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers?.find((h) => h.name?.toLowerCase() === lower)?.value;
}

/** Gmail encodes body data as URL-safe base64 ("base64url") — decoding with
 * plain "base64" silently corrupts any payload containing `-` or `_`
 * (which is common: both are valid base64url alphabet characters that
 * standard base64 doesn't use, though it's the reverse direction that
 * actually corrupts: standard base64's decoder just treats `-`/`_` as
 * invalid/stops early). Buffer's "base64url" encoding handles this
 * correctly regardless. */
function decodeBase64Url(data: string): string {
  return Buffer.from(data, "base64url").toString("utf8");
}

/**
 * Depth-first search preferring the first non-attachment `text/plain`
 * part; falls back to a tag-stripped `text/html` part if no plain-text
 * part exists. Parts carrying an `attachmentId` are skipped outright — an
 * attached .txt file is not the message body. `stripHtml` is injected
 * rather than imported from connectors/google_drive/text.ts to keep this
 * module dependency-free and independently testable.
 */
export function extractPlainText(payload: GmailMessagePart | undefined, stripHtml: (html: string) => string): string | undefined {
  if (!payload) return undefined;

  const plainPart = findPart(payload, "text/plain");
  if (plainPart?.body?.data) return decodeBase64Url(plainPart.body.data);

  const htmlPart = findPart(payload, "text/html");
  if (htmlPart?.body?.data) return stripHtml(decodeBase64Url(htmlPart.body.data));

  return undefined;
}

function findPart(part: GmailMessagePart, mimeType: string): GmailMessagePart | undefined {
  if (part.body?.attachmentId) return undefined; // an attachment, not body text
  if (part.mimeType === mimeType && part.body?.data) return part;
  for (const child of part.parts ?? []) {
    const found = findPart(child, mimeType);
    if (found) return found;
  }
  return undefined;
}

// Matches the start of a quoted-reply block across the major mail clients:
// Gmail/Apple Mail's "On <date>, <name> wrote:", Outlook's "-----Original
// Message-----", an Outlook plain header block, or 3+ consecutive
// `>`-quoted lines.
const QUOTE_MARKERS: RegExp[] = [
  /^On .{10,120}\bwrote:\s*$/m,
  /^-{5,}\s*Original Message\s*-{5,}$/m,
  /^From:\s.+\nSent:\s.+\nTo:\s.+/m,
  /^(?:>.*\n){2,}>.*/m, // 3+ consecutive '>'-quoted lines (2 full lines plus a final one, which may be the last line in the string)
];

// A trailing "-- \n<signature>" block — the conventional Unix/mail-client
// signature delimiter (note the required trailing space after "--").
const SIGNATURE_MARKER = /\n-- \n[\s\S]*$/;

/**
 * Cuts a message body at the first quoted-reply marker found, then trims a
 * trailing signature block. Best-effort and known to be imperfect across
 * locales/clients — that imprecision is exactly why raw_events keeps the
 * untouched text and only normalized_events.body sees this.
 */
export function stripQuotedReply(text: string): string {
  let cutAt = text.length;
  for (const marker of QUOTE_MARKERS) {
    const match = marker.exec(text);
    if (match && match.index < cutAt) cutAt = match.index;
  }
  const withoutQuote = text.slice(0, cutAt).trimEnd();
  return withoutQuote.replace(SIGNATURE_MARKER, "").trimEnd();
}
