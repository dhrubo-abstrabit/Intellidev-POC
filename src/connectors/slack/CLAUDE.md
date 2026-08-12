## Slack connector specifics

- A bot being "added to a channel" via Slack's app-install UI is **not** the same as the bot user actually joining that channel. `conversations.history` only works for channels where `conversations.list`'s `is_member` field is true, which requires an explicit `/invite @bot-name` for channels the bot wasn't OAuth-scoped to auto-join.
- OAuth scopes must be added in both places: the code's requested-scopes list (`src/connectors/slack/index.ts`) and the Slack app's own dashboard (OAuth & Permissions → Bot Token Scopes). An already-connected workspace needs an explicit disconnect + reconnect for a newly-added scope to actually land on its token — editing the code alone doesn't retroactively upgrade an existing grant.
