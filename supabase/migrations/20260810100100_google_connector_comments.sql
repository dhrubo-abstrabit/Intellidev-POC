-- Comment-only: documents the NESTED integrations.config and
-- integration_cursors.cursor shapes introduced by the merged 'google'
-- connector. No column, type, or grant changes.
--
-- The pre-merge per-provider shapes are kept in these comments too: rows
-- written by the old 'gmail' / 'google_drive' / 'google_chat' integrations
-- are never rewritten, so both shapes exist in this database indefinitely.

comment on column public.integrations.config is
  'Provider-specific sync scope. CLIENT-WRITABLE by workspace owners/admins '
  '(see the column-scoped UPDATE grant on this table) — every connector MUST '
  'parse this with Zod and never trust its shape. '
  'Google (merged connector): {"gmail":{"query":"...","bootstrapDays":30,'
  '"maxBodyChars":8000,"includeSent":true}|null,'
  '"drive":{"sources":["<folderOrSharedDriveId>",...],"initialLookbackDays":30,'
  '"extractText":true,"maxTextFetchesPerRun":25,"maxTextChars":20000}|null,'
  '"chat":{"spaceIds":["spaces/AAAA",...],"resolveSenderNames":true}|null} — '
  'null means that sub-service is disabled; each sub-object is the SAME schema '
  'the standalone connector used before the merge. '
  'Legacy (pre-merge, historical rows only) — Google Chat: {"spaceIds":[...]}. '
  'Google Drive: {"sources":[...],...}. Gmail: {"query":"...",...}. '
  'Slack: {} (no configurable scope). '
  'Validated at the app layer by the per-provider schema registered in '
  'src/lib/db/schemas/integration-config.ts.';

comment on column public.integration_cursors.cursor is
  'Provider-specific resume position, validated at the app layer by each '
  'connector''s own defensive parser (a shape it does not recognize degrades to '
  '"no cursor yet" rather than throwing out of an unattended sync job). '
  'Google (merged connector): {"provider":"google","v":1,'
  '"gmail":<gmail cursor>|null,"drive":<drive cursor>|null,"chat":<chat cursor>|null,'
  '"lastPriorityService":"gmail"|"drive"|"chat"} — one nested slot per '
  'sub-service, each holding VERBATIM the cursor that sub-connector produced '
  'before the merge. A slot is left untouched when its service is disabled or '
  'was not reached within this run''s time budget, so re-enabling a service '
  'resumes instead of re-backfilling; lastPriorityService rotates which '
  'sub-service goes first next run so one large backlog cannot starve the others. '
  'Slack: {"provider":"slack","channelCursors":{"<channelId>":"<ts>"}}. '
  'Legacy (pre-merge, historical rows only) — Google Chat: '
  '{"provider":"google_chat","v":1,"spaceCursors":{"spaces/AAAA":"<RFC3339>"}}. '
  'Google Drive: {"provider":"google_drive","v":1,"sources":{"<id>":{"modifiedTimeFloor":"<RFC3339>",'
  '"boundary":[...],"folders":{...},"driveId":null,"pendingBackfillFolderIds":[...],"backfillFloor":"<RFC3339>"}}}. '
  'Gmail: {"provider":"gmail","v":1,"lastInternalDateMs":1234567890000}. '
  'ClickUp: {"provider":"clickup","dateUpdatedGt":1234567890}.';

comment on column public.normalized_events.metadata is
  'Provider-specific long tail not hoisted into a column. Shape varies by '
  'provider+type; validated at the app layer, not by a DB constraint. '
  'For provider=''google'' this ALWAYS carries {"service":"gmail"|"drive"|"chat"} '
  'alongside the sub-connector''s own keys — after the merge, provider collapses '
  'to ''google'' for all three, so this tag is the only thing that still '
  'distinguishes them (the Data page''s badges and connector chips read it).';
