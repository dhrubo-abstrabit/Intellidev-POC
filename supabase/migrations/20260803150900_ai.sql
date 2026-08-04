-- =========================================================================
-- llm_runs: full audit record of every model call. SERVICE-ROLE ONLY —
-- prompts carry cross-project context and system-prompt IP; responses carry
-- pre-filter model output. `prompt_version` + `prompt` + `model` stored per
-- run is what makes "why did the model say that last Tuesday" answerable
-- after the prompt template has since been edited.
-- =========================================================================
create table public.llm_runs (
  id              uuid primary key default gen_random_uuid(),
  workspace_id    uuid not null,
  project_id      uuid not null,
  kind            public.llm_run_kind not null,
  status          public.llm_run_status not null default 'queued',
  model           text not null,
  provider        text not null default 'anthropic',
  prompt_version  text not null,
  input_event_ids uuid[] not null default '{}',  -- immutable audit record, not a queried relationship
  prompt          jsonb,   -- full messages array, for replay/debugging
  response        jsonb,
  prompt_tokens        integer,
  completion_tokens    integer,
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
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  constraint llm_runs_id_workspace_id_key unique (id, workspace_id)
);

create unique index llm_runs_idempotency_uniq
  on public.llm_runs (idempotency_key) where idempotency_key is not null;
create index llm_runs_project_recent_idx on public.llm_runs (project_id, created_at desc);

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
-- =========================================================================
create table public.action_items (
  id               uuid primary key default gen_random_uuid(),
  workspace_id     uuid not null,
  project_id       uuid not null,
  llm_run_id       uuid,
  kind             public.action_item_kind not null default 'action',
  title            text not null check (length(btrim(title)) between 1 and 300),
  description      text,
  priority         public.action_item_priority not null default 'medium',
  confidence_score numeric(4, 3) not null check (confidence_score between 0 and 1),
  status           public.action_item_status not null default 'pending',
  for_date         date not null,  -- project-local day (via projects.timezone); drives "Today"
  due_at           timestamptz,
  owner_hint       text,           -- LLM's guess at the responsible human, free text
  assignee_id      uuid references public.users (id) on delete set null,
  dedupe_hash      text not null,  -- normalized-title hash; the spec's "avoid duplicates / merge similar"
  superseded_by    uuid references public.action_items (id) on delete set null,
  resolved_at      timestamptz,
  snoozed_until    timestamptz,
  generated_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  foreign key (llm_run_id, workspace_id)
    references public.llm_runs (id, workspace_id) on delete set null,
  constraint action_items_id_workspace_id_key unique (id, workspace_id)
);

-- Enforces "avoid duplicates, merge similar recommendations" in the data
-- layer, not just the prompt: re-running generation upserts on this key
-- instead of inserting a near-duplicate. Only open items are constrained —
-- a resolved item and a later, unrelated item may legitimately share a hash.
create unique index action_items_open_dedupe_uniq
  on public.action_items (project_id, dedupe_hash)
  where status in ('pending', 'in_progress');

create index action_items_pending_today_idx
  on public.action_items (project_id, for_date desc, priority desc)
  where status in ('pending', 'in_progress');
create index action_items_ws_pending_idx
  on public.action_items (workspace_id, for_date desc)
  where status = 'pending';
create index action_items_assignee_open_idx
  on public.action_items (assignee_id, for_date desc)
  where status in ('pending', 'in_progress') and assignee_id is not null;
create index action_items_snoozed_idx
  on public.action_items (snoozed_until)
  where status = 'snoozed';

create trigger trg_action_items_updated_at
  before update on public.action_items
  for each row execute function public.set_updated_at();

alter table public.action_items enable row level security;

create policy action_items_select on public.action_items for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
create policy action_items_update on public.action_items for update to authenticated
  using (workspace_id in (select public.current_workspace_ids()))
  with check (workspace_id in (select public.current_workspace_ids()));
grant select on public.action_items to authenticated;
revoke insert, delete on public.action_items from authenticated, anon;
revoke update on public.action_items from authenticated;
grant update (status, assignee_id, snoozed_until, resolved_at, priority)
  on public.action_items to authenticated;

-- =========================================================================
-- action_item_source_events: join table, not a uuid[] column on
-- action_items. An array would let a "source event" point at a deleted row
-- forever; a join table gets referential integrity, a plain-index reverse
-- lookup ("what did this Slack message cause?"), and somewhere for a
-- per-link relevance score to live.
-- =========================================================================
create table public.action_item_source_events (
  action_item_id      uuid not null references public.action_items (id) on delete cascade,
  normalized_event_id uuid not null references public.normalized_events (id) on delete cascade,
  workspace_id         uuid not null,
  relevance            numeric(4, 3),
  primary key (action_item_id, normalized_event_id)
);

create index aise_event_idx on public.action_item_source_events (normalized_event_id);

alter table public.action_item_source_events enable row level security;

create policy aise_select on public.action_item_source_events for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.action_item_source_events to authenticated;
revoke insert, update, delete on public.action_item_source_events from authenticated, anon;

-- =========================================================================
-- daily_summaries
-- =========================================================================
create table public.daily_summaries (
  id           uuid primary key default gen_random_uuid(),
  workspace_id uuid not null,
  project_id   uuid not null,
  summary_date date not null,
  headline     text,
  summary      text not null,
  highlights   jsonb not null default '[]'::jsonb,
  metrics      jsonb not null default '{}'::jsonb,  -- event counts, sync health
  llm_run_id   uuid,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  foreign key (project_id, workspace_id)
    references public.projects (id, workspace_id) on delete cascade,
  unique (project_id, summary_date)
);

create index daily_summaries_project_date_idx
  on public.daily_summaries (project_id, summary_date desc);

create trigger trg_daily_summaries_updated_at
  before update on public.daily_summaries
  for each row execute function public.set_updated_at();

alter table public.daily_summaries enable row level security;

create policy daily_summaries_select on public.daily_summaries for select to authenticated
  using (workspace_id in (select public.current_workspace_ids()));
grant select on public.daily_summaries to authenticated;
revoke insert, update, delete on public.daily_summaries from authenticated, anon;
