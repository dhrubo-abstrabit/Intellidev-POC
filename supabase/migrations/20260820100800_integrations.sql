-- =========================================================================
-- connector_credentials: the OAuth grant. SERVICE-ROLE ONLY.
--
-- Scoped to the CLIENT SPACE. OAuth is granted against a provider *account*
-- (a Slack team, a Google account), and in this model each client space is
-- expected to correspond to a distinct provider account — one client's Slack,
-- one client's Drive. Scoping any lower (per project) would force re-running
-- consent once per project against the same Slack team.
--
-- Consequence to know: if two client spaces under one workspace share a
-- single provider account (e.g. several internal departments on one company
-- Slack), each needs its own grant — meaning two consent flows, two token
-- blobs, and two independent refresh cycles for the same upstream account.
--
-- The entire token bundle (access/refresh/id token + provider extras) is one
-- AES-256-GCM-encrypted JSON blob (see src/lib/crypto/tokens.ts) — never a
-- plaintext column, and never one column per token (providers disagree on
-- what they return). `bytea`, not text: this is raw AEAD ciphertext plus a
-- 16-byte auth tag, and a text column would either corrupt it or demand a
-- base64 layer the crypto module does not have.
-- =========================================================================
create table public.connector_credentials (
  id                      uuid primary key default gen_random_uuid(),
  client_space_id         uuid not null,
  workspace_id            uuid not null,
  provider                public.connector_provider not null,
  external_account_id     text not null,   -- Slack team_id, Google sub, ClickUp team id
  external_account_label  text,            -- e.g. "Acme Corp" — denormalized for UI display

  secret_ciphertext       bytea not null,  -- AEAD ciphertext || 16-byte auth tag
  secret_iv               bytea not null,  -- 12-byte nonce, fresh per encryption
  secret_key_version      smallint not null default 1,
  secret_alg              text not null default 'aes-256-gcm',

  access_token_expires_at timestamptz,
  refresh_failed_at       timestamptz,
  refresh_failure_count   smallint not null default 0,
  revoked_at              timestamptz,
  created_by              uuid references public.users (id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  unique (client_space_id, provider, external_account_id),
  constraint connector_credentials_id_client_space_id_key unique (id, client_space_id)
);

create index connector_credentials_refresh_due_idx
  on public.connector_credentials (access_token_expires_at)
  where revoked_at is null and access_token_expires_at is not null;

create trigger trg_connector_credentials_updated_at
  before update on public.connector_credentials
  for each row execute function public.set_updated_at();

-- RLS on with zero policies -> default deny. Removing the grants (not just
-- relying on RLS) is the important lock: a missing grant fails loudly
-- (401/403) instead of silently returning `[]`, and it survives someone
-- adding a "just for debugging" permissive policy later.
alter table public.connector_credentials enable row level security;
revoke all on public.connector_credentials from anon, authenticated;

-- =========================================================================
-- integrations: a configured connector on a client space. This is what the
-- Integrations page renders and what the sync dispatcher iterates.
--
-- More than one integration per (client space, provider, credential) is
-- allowed on purpose: splitting one Slack grant into several integrations
-- with disjoint `config.channels` is how a client space feeds different
-- projects from different channel sets, via project_connector_scopes below.
-- =========================================================================
create table public.integrations (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  credential_id   uuid,  -- null for connectors with no OAuth grant (e.g. mock)
  provider        public.connector_provider not null,
  status          public.integration_status not null default 'pending',
  display_name    text,

  config                 jsonb not null default '{}'::jsonb,  -- channels, folder ids, list ids
  sync_enabled           boolean not null default true,
  sync_interval_seconds  integer not null default 900 check (sync_interval_seconds between 60 and 86400),
  next_sync_at           timestamptz not null default now(),
  last_sync_started_at   timestamptz,
  last_sync_succeeded_at timestamptz,
  last_error             text,
  consecutive_failures   smallint not null default 0,

  connected_by    uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  -- Column-list form of `on delete set null` is required, not the bare form:
  -- client_space_id is `not null`, so nulling both referencing columns when a
  -- credential is deleted would itself violate that constraint. (The previous
  -- schema carried this exact bug in bare form on several FKs; it only never
  -- fired because the parent rows were always removed via a cascade that
  -- deleted the children first.)
  foreign key (credential_id, client_space_id)
    references public.connector_credentials (id, client_space_id)
    on delete set null (credential_id),
  constraint integrations_id_client_space_id_key unique (id, client_space_id),
  check (jsonb_typeof(config) = 'object')
);

-- The cron dispatcher's only query, running every minute forever: keep this
-- index narrow (partial) so its cost scales with due work, not total rows.
create index integrations_due_for_sync_idx
  on public.integrations (next_sync_at)
  where sync_enabled and status in ('connected', 'degraded');

create index integrations_client_space_idx
  on public.integrations (client_space_id, provider);

create trigger trg_integrations_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.integrations enable row level security;

create policy integrations_select on public.integrations for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
create policy integrations_update_admin on public.integrations for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy integrations_delete_admin on public.integrations for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
-- No insert policy: integrations are created only by the OAuth callback /
-- connect flow, which runs with the service-role client.
grant select, delete on public.integrations to authenticated;

-- RLS cannot restrict which *columns* an UPDATE touches — without this grant
-- restriction, a member could PATCH `status` or `next_sync_at` straight
-- through PostgREST and desync the sync engine's bookkeeping.
revoke update on public.integrations from authenticated;
grant update (sync_enabled, display_name, config, sync_interval_seconds)
  on public.integrations to authenticated;

-- =========================================================================
-- integration_cursors: per-resource sync cursor. SERVICE-ROLE ONLY.
--
-- Not a `cursor` column on `integrations`: Slack needs one per channel,
-- Google Drive one per folder/drive, ClickUp a single `date_updated_gt`.
-- jsonb because the cursor shape is genuinely provider-specific — a single
-- typed column would be a lie about one of them. This is the ONLY place a
-- resume position is stored; do not also track a cursor elsewhere, or you get
-- duplicate/skipped events when the two disagree.
-- =========================================================================
create table public.integration_cursors (
  integration_id   uuid not null references public.integrations (id) on delete cascade,
  scope_key        text not null default 'default',  -- channel id / drive id / 'default'
  cursor           jsonb not null,
  last_advanced_at timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (integration_id, scope_key)
);

comment on column public.integration_cursors.cursor is
  'Provider-specific resume position. Slack: {"provider":"slack","oldestTs":"..."}. '
  'Google: {"provider":"google","gmail":{...},"drive":{...},"chat":{...}}. '
  'ClickUp: {"provider":"clickup","dateUpdatedGt":1234567890}. Validated at the app layer with a Zod discriminated union.';

create trigger trg_integration_cursors_updated_at
  before update on public.integration_cursors
  for each row execute function public.set_updated_at();

alter table public.integration_cursors enable row level security;
revoke all on public.integration_cursors from anon, authenticated;

-- =========================================================================
-- project_connector_scopes: which integrations feed a given project.
--
-- This narrows what the LLM reads when generating that project's action
-- items. It does NOT narrow what a human can read: normalized_events and
-- event_attachments key on client_space_id, so every workspace member can
-- read every integration's events regardless of what is scoped here. That is
-- a known and accepted property of this model — recorded so it is not
-- mistaken for an access control.
-- =========================================================================
create table public.project_connector_scopes (
  project_id      uuid not null,
  integration_id  uuid not null,
  client_space_id uuid not null,
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  primary key (project_id, integration_id),
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  foreign key (integration_id, client_space_id)
    references public.integrations (id, client_space_id) on delete cascade
);

create index project_connector_scopes_integration_idx
  on public.project_connector_scopes (integration_id);

alter table public.project_connector_scopes enable row level security;

create policy pcs_select on public.project_connector_scopes for select to authenticated
  using (project_id in (select public.current_project_ids()));
create policy pcs_write_manager on public.project_connector_scopes for all to authenticated
  using (project_id in (select public.manageable_project_ids()))
  with check (project_id in (select public.manageable_project_ids()));

grant select, insert, update, delete on public.project_connector_scopes to authenticated;
