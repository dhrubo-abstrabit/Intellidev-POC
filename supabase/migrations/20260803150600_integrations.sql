-- =========================================================================
-- connector_credentials: workspace-scoped OAuth grant. SERVICE-ROLE ONLY.
--
-- Scoped to the workspace, not the project: OAuth is granted against a
-- provider *account* (a Slack team, a Google account), not a project. Scoping
-- to a project would force re-running OAuth consent once per project for the
-- same Slack team. One grant per (workspace, provider, external account),
-- reused by any number of project-level `integrations` bindings.
--
-- The entire token bundle (access/refresh/id token + provider extras) is one
-- AES-256-GCM-encrypted JSON blob (see src/lib/crypto/tokens.ts) — never a
-- plaintext column, and never one column per token (providers disagree on
-- what they return; a schema-typed column per field would churn constantly).
-- =========================================================================
create table public.connector_credentials (
  id                      uuid primary key default gen_random_uuid(),
  workspace_id            uuid not null references public.workspaces (id) on delete cascade,
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

  unique (workspace_id, provider, external_account_id),
  constraint connector_credentials_id_workspace_id_key unique (id, workspace_id)
);

create index connector_credentials_refresh_due_idx
  on public.connector_credentials (access_token_expires_at)
  where revoked_at is null and access_token_expires_at is not null;

create trigger trg_connector_credentials_updated_at
  before update on public.connector_credentials
  for each row execute function public.set_updated_at();

-- RLS on with zero policies -> default deny. Grant removal (not just RLS) is
-- the important lock: a missing grant fails loudly (401/403) in dev instead
-- of silently returning `[]`, and it survives someone adding a "just for
-- debugging" permissive policy later.
alter table public.connector_credentials enable row level security;
revoke all on public.connector_credentials from anon, authenticated;

-- =========================================================================
-- integrations: project-scoped binding to a credential. This is what the
-- spec's "Connected Integrations" / Integrations page actually renders.
-- =========================================================================
create table public.integrations (
  id             uuid primary key default gen_random_uuid(),
  workspace_id   uuid not null,
  project_id     uuid not null,
  credential_id  uuid,  -- null for connectors with no OAuth grant (e.g. mock)
  provider       public.connector_provider not null,
  status         public.integration_status not null default 'pending',
  display_name   text,

  config                 jsonb not null default '{}'::jsonb,  -- channels, folder ids, list ids
  sync_enabled           boolean not null default true,
  sync_interval_seconds  integer not null default 900 check (sync_interval_seconds between 60 and 86400),
  next_sync_at           timestamptz not null default now(),
  last_sync_started_at   timestamptz,
  last_sync_succeeded_at timestamptz,
  last_error             text,
  consecutive_failures   smallint not null default 0,

  connected_by   uuid references public.users (id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),

  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  foreign key (credential_id, workspace_id)
    references public.connector_credentials (id, workspace_id) on delete set null,
  unique (project_id, provider, credential_id),
  constraint integrations_id_workspace_id_key unique (id, workspace_id),
  constraint integrations_id_project_id_key unique (id, project_id),
  check (jsonb_typeof(config) = 'object')
);

-- The cron dispatcher's only query, running every minute forever: keep this
-- index narrow (partial) so its cost scales with due work, not total rows.
create index integrations_due_for_sync_idx
  on public.integrations (next_sync_at)
  where sync_enabled and status in ('connected', 'degraded');

create trigger trg_integrations_updated_at
  before update on public.integrations
  for each row execute function public.set_updated_at();

alter table public.integrations enable row level security;

create policy integrations_select on public.integrations for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy integrations_update_admin on public.integrations for update to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]))
  with check (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
create policy integrations_delete_admin on public.integrations for delete to authenticated
  using (public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[]));
-- No insert policy: integrations are created only by the OAuth callback /
-- connect flow, which runs with the service-role client. No insert grant
-- either, for the same reason.
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
-- jsonb because the cursor shape is genuinely provider-specific (Slack uses
-- an epoch-string `oldest`, Drive an opaque `startPageToken`, ClickUp a
-- millis integer) — a single typed column would be a lie about one of them.
-- This is the ONLY place a resume position is stored; do not also track a
-- cursor elsewhere, or you get duplicate/skipped events when they disagree.
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
  'Google Drive: {"provider":"google_drive","startPageToken":"..."}. '
  'ClickUp: {"provider":"clickup","dateUpdatedGt":1234567890}. Validated at the app layer with a Zod discriminated union.';

create trigger trg_integration_cursors_updated_at
  before update on public.integration_cursors
  for each row execute function public.set_updated_at();

alter table public.integration_cursors enable row level security;
revoke all on public.integration_cursors from anon, authenticated;
