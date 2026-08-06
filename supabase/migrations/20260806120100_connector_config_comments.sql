-- Comment-only: documents the per-provider integrations.config and
-- integration_cursors.cursor shapes now that Google Chat, Google Drive, and
-- Gmail connectors exist. No column, type, or grant changes.

comment on column public.integrations.config is
  'Provider-specific sync scope. CLIENT-WRITABLE by workspace owners/admins '
  '(see the column-scoped UPDATE grant on this table) — every connector MUST '
  'parse this with Zod and never trust its shape. '
  'Google Chat: {"spaceIds":["spaces/AAAA",...]}. '
  'Google Drive: {"sources":["<folderOrSharedDriveId>",...],"initialLookbackDays":30,'
  '"extractText":true,"maxTextFetchesPerRun":25,"maxTextChars":20000}. '
  'Gmail: {"query":"...","bootstrapDays":30,"maxBodyChars":8000,"includeSent":true,'
  '"mailboxHint":"team@example.com"}. '
  'Validated at the app layer by the per-provider schema registered in '
  'src/lib/db/schemas/integration-config.ts.';

comment on column public.integration_cursors.cursor is
  'Provider-specific resume position, validated at the app layer with a Zod '
  'discriminated union. Slack: {"provider":"slack","channelCursors":{"<channelId>":"<ts>"}}. '
  'Google Chat: {"provider":"google_chat","v":1,"spaceCursors":{"spaces/AAAA":"<RFC3339>"}}. '
  'Google Drive: {"provider":"google_drive","v":1,"sources":{"<id>":{"modifiedTimeFloor":"<RFC3339>",'
  '"boundary":[...],"folders":{...},"driveId":null,"pendingBackfillFolderIds":[...],"backfillFloor":"<RFC3339>"}}}. '
  'Gmail: {"provider":"gmail","v":1,"lastInternalDateMs":1234567890000}. '
  'ClickUp: {"provider":"clickup","dateUpdatedGt":1234567890}.';

comment on column public.connector_credentials.access_token_expires_at is
  'NULL means "unknown — refresh before use", not "never expires". Set on every '
  'OAuth grant that has a real expiry (the Google connectors); cleared by '
  'run-sync.ts after a ConnectorAuthError to force a refresh attempt on the next '
  'sync. Stays permanently NULL for providers whose tokens never expire (Slack''s '
  'classic bot tokens, mock) — see services/sync/credentials.ts''s needsRefresh().';
