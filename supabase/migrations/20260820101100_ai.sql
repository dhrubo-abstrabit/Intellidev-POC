-- =========================================================================
-- llm_runs: full audit record of every model call. SERVICE-ROLE ONLY —
-- prompts carry cross-project context and system-prompt IP; responses carry
-- pre-filter model output. `prompt_version` + `prompt` + `model` stored per
-- run is what makes "why did the model say that last Tuesday" answerable
-- after the prompt template has since been edited.
-- =========================================================================
create table public.llm_runs (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  kind            public.llm_run_kind not null,
  status          public.llm_run_status not null default 'queued',
  model           text not null,
  provider        text not null default 'anthropic',
  prompt_version  text not null,
  input_event_ids uuid[] not null default '{}',  -- immutable audit record, not a queried relationship
  prompt          jsonb,   -- full messages array, for replay/debugging
  response        jsonb,
  prompt_tokens         integer,
  completion_tokens     integer,
  cache_read_tokens     integer,
  cache_creation_tokens integer,
  cost_usd        numeric(10, 6),
  latency_ms      integer,
  error_message   text,
  idempotency_key text,
  started_at      timestamptz,
  finished_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  constraint llm_runs_id_client_space_id_key unique (id, client_space_id)
);

create unique index llm_runs_idempotency_uniq
  on public.llm_runs (idempotency_key) where idempotency_key is not null;
create index llm_runs_cs_recent_idx on public.llm_runs (client_space_id, created_at desc);

create trigger trg_llm_runs_updated_at
  before update on public.llm_runs
  for each row execute function public.set_updated_at();

alter table public.llm_runs enable row level security;
revoke all on public.llm_runs from anon, authenticated;

-- =========================================================================
-- action_items: the only client-writable AI-derived table, and only its
-- human-owned columns (status/assignee/snooze/priority) — title, confidence,
-- dedupe_hash, llm_run_id, generated_at stay immutable from the client since
-- they are model provenance, not user input.
--
-- `project_id` is NULLABLE and MODEL-ASSIGNED. Events are scoped to the
-- client space and carry no project of their own, so the extraction step has
-- to decide which project (if any) an item belongs to. `confidence_score`
-- covers the model's certainty about the item; it does not cover the accuracy
-- of this tag. A null project_id means "relevant to the client, not to a
-- specific initiative" and stays visible to everyone on the client space.
--
-- `workspace_id` is carried alongside client_space_id purely so the
-- assignee_team_member_id composite FK below can reach team_members, which is
-- workspace-scoped. It is not part of any RLS predicate.
-- =========================================================================
create table public.action_items (
  id               uuid primary key default gen_random_uuid(),
  client_space_id  uuid not null,
  workspace_id     uuid not null,
  project_id       uuid,
  llm_run_id       uuid,
  kind             public.action_item_kind not null default 'action',
  title            text not null check (length(btrim(title)) between 1 and 300),
  description      text,
  priority         public.action_item_priority not null default 'medium',
  confidence_score numeric(4, 3) not null check (confidence_score between 0 and 1),
  status           public.action_item_status not null default 'pending',
  for_date         date not null,  -- client-space-local day (via client_spaces.timezone)
  due_at           timestamptz,
  owner_hint       text,           -- LLM's guess at the responsible human, free text
  assignee_id      uuid references public.users (id) on delete set null,
  assignee_team_member_id uuid,
  dedupe_hash      text not null,
  superseded_by    uuid references public.action_items (id) on delete set null,
  resolved_at      timestamptz,
  snoozed_until    timestamptz,
  generated_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),

  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete set null (project_id),
  foreign key (llm_run_id, client_space_id)
    references public.llm_runs (id, client_space_id) on delete set null (llm_run_id),
  -- The column-list form of `on delete set null` is required, not the bare
  -- form: client_space_id is `not null`, so nulling both referencing columns
  -- on a parent delete would itself violate that constraint.
  foreign key (assignee_team_member_id, workspace_id)
    references public.team_members (id, workspace_id)
    on delete set null (assignee_team_member_id),

  -- Forces every write to set one assignee column and null the other, so
  -- every reader can resolve "the assignee" with a plain `??` instead of
  -- needing a documented tie-break rule for "what if both are set."
  constraint action_items_single_assignee_chk
    check (assignee_id is null or assignee_team_member_id is null),
  constraint action_items_id_client_space_id_key unique (id, client_space_id)
);

-- Enforces "avoid duplicates, merge similar recommendations" in the data
-- layer, not just the prompt: re-running generation upserts on this key
-- instead of inserting a near-duplicate. Keyed on client_space_id, not
-- project_id — the events are client-space scoped, so the same conversation
-- must not produce one item per project. Only open items are constrained: a
-- resolved item and a later, unrelated item may legitimately share a hash.
create unique index action_items_open_dedupe_uniq
  on public.action_items (client_space_id, dedupe_hash)
  where status in ('pending', 'in_progress');

create index action_items_project_today_idx
  on public.action_items (project_id, for_date desc, priority desc)
  where status in ('pending', 'in_progress') and project_id is not null;
create index action_items_cs_pending_idx
  on public.action_items (client_space_id, for_date desc)
  where status = 'pending';
create index action_items_assignee_open_idx
  on public.action_items (assignee_id, for_date desc)
  where status in ('pending', 'in_progress') and assignee_id is not null;
create index action_items_snoozed_idx
  on public.action_items (snoozed_until)
  where status = 'snoozed';

comment on column public.action_items.assignee_team_member_id is
  'A team_members roster contact assigned to this task — mutually exclusive '
  'with assignee_id (see action_items_single_assignee_chk). Distinct from '
  'owner_hint (the LLM''s free-text guess, display-only, not client-writable). '
  'A roster contact has no login, so there is no "my tasks" access path for '
  'this column — deliberately no index mirroring action_items_assignee_open_idx.';

create trigger trg_action_items_updated_at
  before update on public.action_items
  for each row execute function public.set_updated_at();

alter table public.action_items enable row level security;

-- Two-armed predicate. Untagged items (project_id is null) belong to the
-- client space and are visible to everyone who can see it. Tagged items
-- additionally require access to that project — which, for the default
-- visibility='workspace', every workspace member already has, so this only
-- bites for projects explicitly marked 'restricted'.
create policy action_items_select on public.action_items for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );
create policy action_items_update on public.action_items for update to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  )
  with check (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );

grant select on public.action_items to authenticated;
revoke insert, delete on public.action_items from authenticated, anon;
revoke update on public.action_items from authenticated;
grant update (status, assignee_id, assignee_team_member_id, snoozed_until, resolved_at, priority)
  on public.action_items to authenticated;

-- =========================================================================
-- action_item_source_events: join table, not a uuid[] column on action_items.
-- An array would let a "source event" point at a deleted row forever; a join
-- table gets referential integrity, a plain-index reverse lookup ("what did
-- this Slack message cause?"), and somewhere for a per-link relevance score.
-- =========================================================================
create table public.action_item_source_events (
  action_item_id      uuid not null references public.action_items (id) on delete cascade,
  normalized_event_id uuid not null references public.normalized_events (id) on delete cascade,
  client_space_id     uuid not null,
  relevance           numeric(4, 3),
  primary key (action_item_id, normalized_event_id)
);

create index aise_event_idx on public.action_item_source_events (normalized_event_id);

alter table public.action_item_source_events enable row level security;

create policy aise_select on public.action_item_source_events for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.action_item_source_events to authenticated;
revoke insert, update, delete on public.action_item_source_events from authenticated, anon;

-- =========================================================================
-- daily_summaries: one briefing per client space per day.
--
-- Client-space scoped, not per project: a client with three initiatives gets
-- one summary covering all of them. `summary_date` is computed in
-- client_spaces.timezone.
-- =========================================================================
create table public.daily_summaries (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  summary_date    date not null,
  headline        text,
  summary         text not null,
  highlights      jsonb not null default '[]'::jsonb,
  metrics         jsonb not null default '{}'::jsonb,  -- event counts, sync health
  llm_run_id      uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  foreign key (llm_run_id, client_space_id)
    references public.llm_runs (id, client_space_id) on delete set null (llm_run_id),
  unique (client_space_id, summary_date)
);

create index daily_summaries_cs_date_idx
  on public.daily_summaries (client_space_id, summary_date desc);

create trigger trg_daily_summaries_updated_at
  before update on public.daily_summaries
  for each row execute function public.set_updated_at();

alter table public.daily_summaries enable row level security;

create policy daily_summaries_select on public.daily_summaries for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.daily_summaries to authenticated;
revoke insert, update, delete on public.daily_summaries from authenticated, anon;

-- =========================================================================
-- milestones: the client space's task board. `project_id` is an optional tag
-- that files a milestone under one initiative; untagged milestones belong to
-- the client space as a whole.
--
-- Human-authored, unlike action_items — so this is fully client-writable by
-- anyone with manager rights on the tagged project, or workspace admins.
-- =========================================================================
create table public.milestones (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null,
  workspace_id    uuid not null,
  project_id      uuid,
  title           text not null check (length(btrim(title)) between 1 and 300),
  description     text,
  status          public.milestone_status not null default 'planned',
  due_date        date,
  completed_at    timestamptz,
  position        integer not null default 0,  -- manual board ordering
  created_by      uuid references public.users (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete set null (project_id)
);

create index milestones_cs_status_idx on public.milestones (client_space_id, status, due_date);
create index milestones_project_idx on public.milestones (project_id)
  where project_id is not null;

create trigger trg_milestones_updated_at
  before update on public.milestones
  for each row execute function public.set_updated_at();

alter table public.milestones enable row level security;

-- Same two-armed shape as action_items.
create policy milestones_select on public.milestones for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );
create policy milestones_write on public.milestones for all to authenticated
  using (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    or (project_id is not null and project_id in (select public.manageable_project_ids()))
    or (project_id is null and client_space_id in (select public.current_client_space_ids()))
  )
  with check (
    public.has_workspace_role(workspace_id, array['owner', 'admin']::public.workspace_role[])
    or (project_id is not null and project_id in (select public.manageable_project_ids()))
    or (project_id is null and client_space_id in (select public.current_client_space_ids()))
  );

grant select, insert, update, delete on public.milestones to authenticated;
