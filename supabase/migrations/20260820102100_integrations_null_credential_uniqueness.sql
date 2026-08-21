-- =========================================================================
-- Fixes a real gap found via live testing (rapid overlapping clicks on the
-- Integrations page produced two "connected" mock rows for the same client
-- space), not a Nango-port change: integrations' existing
-- unique(client_space_id, provider, credential_id) is a standard Postgres
-- constraint, and standard unique constraints treat every NULL as distinct
-- from every other NULL. credential_id is NULL for any connector with no
-- OAuth grant (today: only `mock`), so that constraint provides zero
-- protection for those rows — connectMock's
-- upsert(..., {onConflict: "client_space_id,provider,credential_id"}) can
-- never actually find a conflict to upsert onto, and a double-click or a
-- retried Server Action silently creates a second row instead of updating
-- the first.
--
-- Slack/Google are unaffected: once connected, their credential_id is a
-- real (non-null) uuid, so the existing constraint already covers them.
-- =========================================================================
create unique index integrations_client_space_provider_no_credential_idx
  on public.integrations (client_space_id, provider)
  where credential_id is null;
