-- The prior (project-scoped) schema had `unique (project_id, provider,
-- credential_id)` on integrations, and app code upserts against exactly that
-- shape (see connectMock / the OAuth callback in
-- src/app/api/oauth/[provider]/callback/route.ts) to make reconnecting the
-- same provider account idempotent. The rescoped table carries no equivalent
-- constraint, so an upsert with `onConflict: "client_space_id,provider,
-- credential_id"` fails outright with "no unique or exclusion constraint
-- matching the ON CONFLICT specification". Restoring it, rescoped to
-- client_space_id, is what makes that upsert valid again — a straight
-- rescope of an existing guarantee, not a new one.
alter table public.integrations
  add constraint integrations_client_space_id_provider_credential_id_key
  unique (client_space_id, provider, credential_id);
