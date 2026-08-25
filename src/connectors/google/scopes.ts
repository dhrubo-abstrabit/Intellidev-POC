/**
 * The merged `google` connector requests IDENTITY_SCOPES plus ALL THREE
 * sub-service scope lists in one consent screen (see connectors/google's
 * GOOGLE_ALL_SCOPES) — one grant covers mail, files and chat together.
 * That's a deliberate widening of what a single credential row unlocks,
 * accepted because Google never retro-upgrades an existing grant, so
 * per-service grants would mean a disconnect + reconnect every time a user
 * enabled another service. See CLAUDE.md's "Google connector specifics".
 *
 * The lists stay separate here because each sub-connector's own fetch code
 * still documents which scopes IT depends on. `include_granted_scopes` is a
 * setting on Nango's `google` integration now, not something this app's code
 * sets on an authorize URL (the old oauth.ts, which used to set it, is
 * deleted — see NANGO_MIGRATION_LOG.md) — kept off there for the same
 * reason it was kept off here: the requested list should stay the whole
 * truth about what a token can do.
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
