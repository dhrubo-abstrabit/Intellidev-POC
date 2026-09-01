-- =========================================================================
-- llm_runs: full audit record of every model call. SERVICE-ROLE ONLY —
-- prompts carry cross-project context and system-prompt IP; responses carry
-- pre-filter model output. prompt_version + prompt + model stored per run is
-- what makes "why did the model say that last Tuesday" answerable after the
-- template has since been edited.
--
-- Carries tenant_id so usage metering is one GROUP BY, and client_space_id so
-- it can be joined to the work it produced. Both are FK'd, and the composite
-- below keeps the pair honest.
-- =========================================================================
create table public.llm_runs (
  id                    uuid primary key default gen_random_uuid(),
  tenant_id             uuid not null references public.tenants (id) on delete cascade,
  client_space_id       uuid not null,
  kind                  public.llm_run_kind not null,
  status                public.llm_run_status not null default 'queued',
  model                 text not null,
  provider              text not null default 'anthropic',
  prompt_version        text not null,
  prompt                jsonb,   -- full messages array, for replay/debugging
  response              jsonb,
  prompt_tokens         integer,
  completion_tokens     integer,
  cache_read_tokens     integer,
  cache_creation_tokens integer,
  cost_usd              numeric(10, 6),
  latency_ms            integer,
  error_message         text,
  idempotency_key       text,
  started_at            timestamptz,
  finished_at           timestamptz,
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  -- Ties the space to the tenant structurally: without this the two FKs are
  -- independent and a run could name a client space belonging to a different
  -- tenant, quietly corrupting the metering rollup.
  foreign key (client_space_id, tenant_id)
    references public.client_spaces (id, tenant_id) on delete cascade,
  constraint llm_runs_id_client_space_id_key unique (id, client_space_id)
);

create unique index llm_runs_idempotency_uniq
  on public.llm_runs (idempotency_key) where idempotency_key is not null;
create index llm_runs_cs_recent_idx on public.llm_runs (client_space_id, created_at desc);
create index llm_runs_tenant_metering_idx on public.llm_runs (tenant_id, created_at desc);

create trigger trg_llm_runs_updated_at
  before update on public.llm_runs
  for each row execute function public.set_updated_at();

alter table public.llm_runs enable row level security;
revoke all on public.llm_runs from anon, authenticated;

-- =========================================================================
-- tasks: the client space's board. Formerly `action_items`.
--
-- `project_id` is NULLABLE and MODEL-ASSIGNED. Null means "relevant to the
-- client, not to a specific initiative" and stays visible to every space
-- member. Note the deliberate asymmetry with normalized_events.project_id,
-- which is NOT NULL: an event belongs to whichever project scoped its
-- connector, but a task synthesised from several events may legitimately span
-- them.
--
-- `workspace_id` is carried solely so assignee_team_member_id can reach
-- team_members, which is workspace-scoped. It is not in any RLS predicate.
-- =========================================================================
create table public.tasks (
  id                      uuid primary key default gen_random_uuid(),
  client_space_id         uuid not null,
  workspace_id            uuid not null,
  project_id              uuid,
  llm_run_id              uuid,
  kind                    public.task_kind not null default 'action',
  title                   text not null check (length(btrim(title)) between 1 and 300),
  description             text,
  priority                public.task_priority not null default 'medium',
  status                  public.task_status not null default 'pending',
  confidence              numeric(4, 3) not null check (confidence between 0 and 1),
  for_date                date not null,   -- space-local calendar day
  due_at                  timestamptz,
  owner_hint              text,            -- model's free-text guess, display only
  assignee_id             uuid references public.users (id) on delete set null,
  assignee_team_member_id uuid,

  -- The dedupe surface: kNN target when tonight's drafts are compared against
  -- open work. This is what demotes dedupe_hash below to a backstop.
  embedding               halfvec(1024),
  embedding_model         text,
  embedding_src_hash      bytea,

  -- Race backstop only. Retrieval over `embedding` is the real dedupe; this
  -- catches the narrow case of two concurrent runs producing an identical
  -- title before either has embedded.
  dedupe_hash             text not null,
  -- RESTORED from the previous schema. Records what a merge absorbed —
  -- task_sources shows which EVENTS fed a task, never which TASK was folded
  -- into it. Without this the merge chain is unrecoverable, which is a
  -- regression in exactly the area retrieval-dedupe is meant to strengthen.
  superseded_by           uuid references public.tasks (id) on delete set null,

  resolved_at             timestamptz,
  snoozed_until           timestamptz,
  generated_at            timestamptz not null default now(),
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),

  foreign key (client_space_id, workspace_id)
    references public.client_spaces (id, workspace_id) on delete cascade,
  -- Column-list form of `on delete set null` is REQUIRED, not the bare form:
  -- client_space_id is `not null`, so nulling both referencing columns when a
  -- project is deleted would itself violate that constraint. The original
  -- design of this schema carried the bare form and would have failed on the
  -- first project deletion.
  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete set null (project_id),
  foreign key (llm_run_id, client_space_id)
    references public.llm_runs (id, client_space_id) on delete set null (llm_run_id),
  foreign key (assignee_team_member_id, workspace_id)
    references public.team_members (id, workspace_id)
    on delete set null (assignee_team_member_id),

  -- Forces every write to set one assignee column and null the other, so
  -- every reader resolves "the assignee" with a plain ?? instead of needing a
  -- documented tie-break rule for "what if both are set".
  constraint tasks_single_assignee_chk
    check (assignee_id is null or assignee_team_member_id is null),
  constraint tasks_embedded_has_model_chk
    check (embedding is null or embedding_model is not null)
);

-- Only OPEN tasks are constrained: a resolved task and a later, unrelated
-- task may legitimately share a hash.
create unique index tasks_open_dedupe_uniq
  on public.tasks (client_space_id, dedupe_hash)
  where status in ('pending', 'in_progress');

-- The board query.
create index tasks_board_idx
  on public.tasks (client_space_id, for_date desc, priority desc)
  where status in ('pending', 'in_progress');
create index tasks_project_open_idx
  on public.tasks (project_id, for_date desc)
  where status in ('pending', 'in_progress') and project_id is not null;
create index tasks_assignee_open_idx
  on public.tasks (assignee_id, for_date desc)
  where status in ('pending', 'in_progress') and assignee_id is not null;

-- kNN dedupe target, restricted to open work — the only set tonight's drafts
-- are compared against.
create index tasks_embedding_idx
  on public.tasks using hnsw (embedding halfvec_cosine_ops)
  where status in ('pending', 'in_progress');

-- The wake-up scan. The previous schema had this index and nothing that read
-- it; the job is still owed, but the index is the cheap half.
create index tasks_snoozed_idx on public.tasks (snoozed_until) where status = 'snoozed';

create trigger trg_tasks_updated_at
  before update on public.tasks
  for each row execute function public.set_updated_at();

comment on column public.tasks.assignee_team_member_id is
  'A team_members roster contact assigned to this task — mutually exclusive '
  'with assignee_id (see tasks_single_assignee_chk). A roster contact has no '
  'login, so there is no "my tasks" access path for this column and '
  'deliberately no index mirroring tasks_assignee_open_idx.';

alter table public.tasks enable row level security;

-- Two-armed predicate. Untagged tasks belong to the client space and are
-- visible to every space member. Tagged tasks additionally require access to
-- that project — which, for the default visibility='space', every space
-- member already has, so this only bites for 'restricted' projects.
create policy tasks_select on public.tasks for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );
create policy tasks_update on public.tasks for update to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  )
  with check (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );

grant select on public.tasks to authenticated;
revoke insert, delete on public.tasks from authenticated, anon;
revoke update on public.tasks from authenticated;
-- Only the human-owned columns. title/confidence/dedupe_hash/llm_run_id/
-- embedding/generated_at are model provenance, not user input.
grant update (status, assignee_id, assignee_team_member_id, snoozed_until, resolved_at, priority, due_at)
  on public.tasks to authenticated;

-- =========================================================================
-- task_sources: the provenance chain.
--
-- A join table, not a uuid[] column: an array would let a source point at a
-- deleted row forever, and gives nowhere for the per-link role and relevance
-- to live. `role` + `linked_at` is what renders "created from Slack 19 Aug,
-- enriched by meeting notes 20 Aug".
--
-- `chunk_id` records WHICH chunk matched, not merely which event — the
-- difference between showing the user a paragraph and showing them a
-- 400-message thread.
-- =========================================================================
create table public.task_sources (
  task_id             uuid not null references public.tasks (id) on delete cascade,
  normalized_event_id uuid not null
                        references public.normalized_events (id) on delete cascade,
  client_space_id     uuid not null references public.client_spaces (id) on delete cascade,
  chunk_id            uuid references public.search_chunks (id) on delete set null,
  role                text not null default 'mentioned'
                        check (role in ('created_from', 'enriched', 'mentioned')),
  relevance           numeric(4, 3) check (relevance is null or relevance between 0 and 1),
  llm_run_id          uuid references public.llm_runs (id) on delete set null,
  linked_at           timestamptz not null default now(),
  primary key (task_id, normalized_event_id)
);

-- Reverse lookup: "what did this message cause?"
create index task_sources_event_idx on public.task_sources (normalized_event_id);
create index task_sources_timeline_idx on public.task_sources (task_id, role, linked_at);

alter table public.task_sources enable row level security;

create policy task_sources_select on public.task_sources for select to authenticated
  using (client_space_id in (select public.current_client_space_ids()));
grant select on public.task_sources to authenticated;
revoke insert, update, delete on public.task_sources from authenticated, anon;

-- =========================================================================
-- daily_summaries: one briefing per client space per day.
--
-- RESTORED. client_spaces is annotated as the nightly digest scope and
-- llm_run_kind lists 'daily_summary'; dropping this table left that run with
-- nowhere to write its output.
--
-- Client-space scoped, not per project: a client with three initiatives gets
-- one summary covering all of them. summary_date is computed in the space's
-- timezone.
-- =========================================================================
create table public.daily_summaries (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null references public.client_spaces (id) on delete cascade,
  summary_date    date not null,
  headline        text,
  summary         text not null,
  highlights      jsonb not null default '[]'::jsonb,
  metrics         jsonb not null default '{}'::jsonb,   -- event counts, sync health
  llm_run_id      uuid references public.llm_runs (id) on delete set null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (client_space_id, summary_date),
  check (jsonb_typeof(highlights) = 'array'),
  check (jsonb_typeof(metrics) = 'object')
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
