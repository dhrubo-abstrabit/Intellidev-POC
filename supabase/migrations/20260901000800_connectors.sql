-- =========================================================================
-- space_connections: the provider grant. SERVICE-ROLE ONLY for secrets.
--
-- Scoped to the CLIENT SPACE, because OAuth is granted against a provider
-- *account* (a Slack team, a Google account) and in this model each client
-- space corresponds to a distinct provider account — one client's Slack, one
-- client's Drive. A space admin connects it once; every project in the space
-- reuses it via project_connectors.
--
-- Two auth modes:
--   nango   - Nango holds token custody entirely. This app stores only the
--             connection id and the integration key needed to ask Nango for
--             a fresh access token.
--   api_key - a locally-sealed AES-256-GCM secret, for providers with no
--             OAuth dance (Supabase, OpenAI Codex). `bytea`, not text: this
--             is raw AEAD ciphertext plus a 16-byte auth tag, and a text
--             column would either corrupt it or demand a base64 layer.
--
-- Consequence to know: if two client spaces share one provider account (e.g.
-- several internal departments on one company Slack), each needs its own
-- grant — two consent flows, two connections, two refresh cycles for the same
-- upstream account.
-- =========================================================================
create table public.space_connections (
  id                        uuid primary key default gen_random_uuid(),
  client_space_id           uuid not null references public.client_spaces (id) on delete cascade,
  provider                  public.connector_provider not null,
  auth_mode                 public.connector_auth_mode not null,

  -- auth_mode = 'nango'
  nango_connection_id       text,
  nango_provider_config_key text,

  -- auth_mode = 'api_key'
  secret_ciphertext         bytea,       -- AEAD ciphertext || 16-byte auth tag
  secret_iv                 bytea,       -- 12-byte nonce, fresh per encryption
  secret_key_version        smallint,
  -- Lets you FIND rows still sealed under an old key. Without it, rotation is
  -- a guess: there is no way to enumerate what still needs re-encrypting.
  secret_rotated_at         timestamptz,

  external_account_id       text not null,  -- Slack team_id, Google sub, org id
  external_account_label    text,           -- denormalized for UI display
  -- Slack team domain. Required to build message permalinks — without it a
  -- normalized event cannot produce a working click-through URL.
  account_domain            text,

  -- Space-wide defaults ONLY. Per-project scope (channels, folders, repos)
  -- lives on project_connectors.config.
  config                    jsonb not null default '{}'::jsonb,
  status                    public.integration_status not null default 'pending',
  last_validated_at         timestamptz,
  revoked_at                timestamptz,
  connected_by              uuid references public.users (id) on delete set null,
  created_at                timestamptz not null default now(),
  updated_at                timestamptz not null default now(),

  unique (client_space_id, provider, external_account_id),
  -- Composite FK target for project_connectors, so a connection from space A
  -- can never be referenced by a project connector tagged space B.
  constraint space_connections_id_client_space_id_key unique (id, client_space_id),

  check (jsonb_typeof(config) = 'object'),
  -- Each auth mode must carry the fields it actually needs. Without this a
  -- half-configured row reaches the sync engine and fails at fetch time,
  -- inside a job nobody is watching, rather than at insert time.
  constraint space_connections_auth_mode_chk check (
    (auth_mode = 'nango'   and nango_connection_id is not null
                           and nango_provider_config_key is not null)
    or
    (auth_mode = 'api_key' and secret_ciphertext is not null
                           and secret_iv is not null
                           and secret_key_version is not null)
  )
);

-- Nango's connection ids are globally unique on its side; enforce that here
-- too so a bug cannot silently attach two local rows to one Nango connection.
create unique index space_connections_nango_connection_id_idx
  on public.space_connections (nango_connection_id)
  where nango_connection_id is not null;

create index space_connections_space_provider_idx
  on public.space_connections (client_space_id, provider);

create trigger trg_space_connections_updated_at
  before update on public.space_connections
  for each row execute function public.set_updated_at();

comment on column public.space_connections.nango_provider_config_key is
  'The Nango integration id this connection belongs to (e.g. "google", '
  '"slack") — distinct from connector_provider, since one Nango integration '
  'can back a provider value covering several sub-services.';

-- =========================================================================
-- project_connectors: what the sync engine iterates.
--
-- Narrows one space-level grant down to one project's scope. This is the
-- level-shift from the previous schema, where a single `integrations` row
-- conflated the grant, the config and the schedule at client-space level.
--
-- ACCEPTED CONSEQUENCE — duplicate ingestion. Nothing stops two projects in
-- one space scoping the same Slack channel. Each gets its own connector, its
-- own cursor, and therefore its own copy of every message: N projects means
-- N raw_events rows per upstream event, N sets of embeddings, and N× the
-- provider quota. The unique key below is (project_id, connection_id), which
-- permits this BY DESIGN. It is a product decision, not a constraint gap —
-- no DDL can express "these two projects must not overlap".
-- =========================================================================
create table public.project_connectors (
  id                     uuid primary key default gen_random_uuid(),
  client_space_id        uuid not null,
  project_id             uuid not null,
  connection_id          uuid not null,
  -- Denormalized from the connection for cheap filtering. The composite FK
  -- below does not carry it, so it is kept honest by a trigger rather than a
  -- constraint — see trg_project_connectors_sync_provider.
  provider               public.connector_provider not null,

  -- PROJECT scope: slack channel ids, drive folder ids, chat spaces, the one
  -- supabase project_ref, github repos. Client-writable — Zod-parse it.
  config                 jsonb not null default '{}'::jsonb,
  enabled                boolean not null default true,
  sync_enabled           boolean not null default true,
  sync_interval_seconds  integer not null default 900
                           check (sync_interval_seconds between 60 and 86400),
  next_sync_at           timestamptz not null default now(),
  last_sync_started_at   timestamptz,
  last_sync_succeeded_at timestamptz,
  last_error             text,
  consecutive_failures   smallint not null default 0,
  created_by             uuid references public.users (id) on delete set null,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),

  unique (project_id, connection_id),
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  foreign key (connection_id, client_space_id)
    references public.space_connections (id, client_space_id) on delete cascade,

  constraint project_connectors_id_client_space_id_key unique (id, client_space_id),
  -- THE THREE-COLUMN FK TARGET. This is the fix for the integrity hole in the
  -- original design: without it, raw_events/normalized_events could FK
  -- independently to a connector and to a project, and nothing would force
  -- the two to agree — an event could claim project B while being sourced
  -- from a connector belonging to project A, as long as both sat in the same
  -- client space. Events FK on all three columns instead.
  constraint project_connectors_id_project_id_client_space_id_key
    unique (id, project_id, client_space_id),

  check (jsonb_typeof(config) = 'object')
);

-- The dispatcher's only query, running forever: keep this index narrow
-- (partial) so its cost scales with due work, not total rows.
create index project_connectors_due_for_sync_idx
  on public.project_connectors (next_sync_at)
  where enabled and sync_enabled;

create index project_connectors_project_idx
  on public.project_connectors (project_id, provider);
create index project_connectors_connection_idx
  on public.project_connectors (connection_id);

create trigger trg_project_connectors_updated_at
  before update on public.project_connectors
  for each row execute function public.set_updated_at();

-- `provider` is denormalized for filtering, so it must not be allowed to
-- drift from its parent connection. Enforced here rather than trusted,
-- because a wrong provider routes an event to the wrong normalize() and the
-- failure surfaces far from its cause.
create or replace function public.sync_project_connector_provider()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_provider public.connector_provider;
begin
  select sc.provider into v_provider
  from public.space_connections sc
  where sc.id = new.connection_id;

  if v_provider is null then
    raise exception 'space_connection % not found', new.connection_id;
  end if;

  new.provider := v_provider;
  return new;
end;
$$;

create trigger trg_project_connectors_sync_provider
  before insert or update of connection_id on public.project_connectors
  for each row execute function public.sync_project_connector_provider();

-- =========================================================================
-- project_connector_cursors: per-resource sync cursor. SERVICE-ROLE ONLY.
--
-- Not a `cursor` column on project_connectors: Slack needs one per channel,
-- Google Drive one per folder/drive, and the merged Google connector nests
-- three sub-cursors. jsonb because the shape is genuinely provider-specific —
-- a single typed column would be a lie about one of them.
--
-- This is the ONLY place a resume position is stored. Do not also track a
-- cursor elsewhere, or you get duplicate/skipped events when the two
-- disagree.
-- =========================================================================
create table public.project_connector_cursors (
  project_connector_id uuid not null
                         references public.project_connectors (id) on delete cascade,
  scope_key            text not null default 'default',  -- channel / folder / 'default'
  cursor               jsonb not null,
  last_advanced_at     timestamptz not null default now(),
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  primary key (project_connector_id, scope_key)
);

comment on column public.project_connector_cursors.cursor is
  'Provider-specific resume position. Slack: {"provider":"slack","oldestTs":"..."}. '
  'Google: {"provider":"google","gmail":{...},"drive":{...},"chat":{...}}. '
  'Validated at the app layer with a Zod discriminated union.';

create trigger trg_project_connector_cursors_updated_at
  before update on public.project_connector_cursors
  for each row execute function public.set_updated_at();

-- =========================================================================
-- RLS
--
-- space_connections is readable by space members (the Integrations page lists
-- what is connected) but its secret columns are never granted — see the
-- column list below. Writes are service-role only: connections are created by
-- the Nango connect flow, not by a PATCH.
-- =========================================================================
alter table public.space_connections        enable row level security;
alter table public.project_connectors       enable row level security;
alter table public.project_connector_cursors enable row level security;

create policy space_connections_select on public.space_connections for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    or client_space_id in (select public.manageable_client_space_ids())
  );
create policy space_connections_delete on public.space_connections for delete to authenticated
  using (client_space_id in (select public.manageable_client_space_ids()));

-- Column-scoped SELECT. RLS cannot restrict which columns a SELECT returns,
-- so this grant is the ONLY thing keeping secret_ciphertext / secret_iv /
-- nango_connection_id out of a PostgREST response.
grant select (id, client_space_id, provider, auth_mode, external_account_id,
              external_account_label, account_domain, config, status,
              last_validated_at, revoked_at, connected_by, created_at, updated_at)
  on public.space_connections to authenticated;
grant delete on public.space_connections to authenticated;
revoke insert, update on public.space_connections from authenticated, anon;
-- Renaming the displayed label is the one safe client-side edit.
grant update (external_account_label) on public.space_connections to authenticated;

-- project_connectors is fully client-manageable within a project the caller
-- can configure — this is the per-project scoping UI.
create policy project_connectors_select on public.project_connectors for select to authenticated
  using (project_id in (select public.current_project_ids()));
create policy project_connectors_write on public.project_connectors for all to authenticated
  using (project_id in (select public.manageable_project_ids()))
  with check (project_id in (select public.manageable_project_ids()));

grant select, insert, delete on public.project_connectors to authenticated;
revoke update on public.project_connectors from authenticated;
-- status/next_sync_at/last_error/consecutive_failures are the sync engine's
-- bookkeeping. RLS cannot restrict which columns an UPDATE touches, so this
-- column list is the only thing stopping a member desyncing the dispatcher.
grant update (config, enabled, sync_enabled, sync_interval_seconds)
  on public.project_connectors to authenticated;

-- Cursors: default-deny. RLS on with zero policies, and the grants removed —
-- a missing grant fails loudly (403) rather than silently returning [], and
-- it survives someone adding a "just for debugging" permissive policy later.
revoke all on public.project_connector_cursors from anon, authenticated;
