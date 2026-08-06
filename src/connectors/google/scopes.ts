/**
 * Every Google connector requests IDENTITY_SCOPES plus exactly one
 * provider-specific scope list — never more. `include_granted_scopes` is
 * deliberately never used (see oauth.ts), so a Gmail connect can never end
 * up carrying Drive access just because the same Google account connected
 * Drive earlier: three least-privilege grants, three consent screens.
 */
export const IDENTITY_SCOPES = ["openid", "email", "profile"];

export const DRIVE_SCOPES = ["https://www.googleapis.com/auth/drive.readonly"];

export const CHAT_SCOPES = [
  "https://www.googleapis.com/auth/chat.spaces.readonly",
  "https://www.googleapis.com/auth/chat.messages.readonly",
  // Lets fetchSince resolve a message's `sender.name` ("users/<id>") to a
  // real display name/email via the People API's directory resource (see
  // connectors/google_chat/directory.ts) — under user auth, Chat's own API
  // returns sender.displayName empty. An integration connected before this
  // scope existed won't have it on its token; per CLAUDE.md's "scope
  // changes don't retro-apply" rule, it needs a disconnect + reconnect.
  "https://www.googleapis.com/auth/directory.readonly",
];

export const GMAIL_SCOPES = ["https://www.googleapis.com/auth/gmail.readonly"];
