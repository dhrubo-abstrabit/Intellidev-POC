-- =========================================================================
-- context_documents: business context, PRDs, meeting notes, glossaries.
--
-- Promoted from a `projects.context_docs` jsonb column to a real table,
-- because these now need extraction state, storage paths and Drive sync refs
-- — none of which fit in an array of blobs on the parent row.
--
-- `project_id` nullable: null means the document applies to the whole client
-- space (a company profile, a glossary) rather than one initiative.
-- =========================================================================
create table public.context_documents (
  id                uuid primary key default gen_random_uuid(),
  client_space_id   uuid not null references public.client_spaces (id) on delete cascade,
  project_id        uuid,
  kind              text not null
                      check (kind in ('business_context', 'prd', 'meeting_notes', 'glossary')),
  title             text not null check (length(btrim(title)) between 1 and 300),
  source            text not null check (source in ('upload', 'google_doc', 'pasted')),
  -- {fileId, revisionId} when synced from Drive.
  external_ref      jsonb not null default '{}'::jsonb,
  storage_path      text,
  mime_type         text,
  extracted_text    text,
  extraction_status text not null default 'pending'
                      check (extraction_status in ('pending', 'extracted', 'skipped', 'failed')),
  extraction_error  text,
  -- Re-upload = new row, old row archived. No version chain: the history is
  -- the row sequence, and nothing needs to walk it.
  archived_at       timestamptz,
  created_by        uuid references public.users (id) on delete set null,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now(),

  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  check (jsonb_typeof(external_ref) = 'object')
);

-- Stops a Drive re-sync creating unbounded duplicates of the same document.
-- Only one LIVE row per source file per scope; archived rows are exempt, so
-- the re-upload-and-archive flow still works. `nulls not distinct` matters:
-- without it, two space-level docs (project_id null) would never collide.
create unique index context_documents_live_source_uniq
  on public.context_documents (client_space_id, project_id, external_ref)
  nulls not distinct
  where archived_at is null and external_ref <> '{}'::jsonb;

create index context_documents_space_idx
  on public.context_documents (client_space_id, kind)
  where archived_at is null;
create index context_documents_pending_idx
  on public.context_documents (client_space_id, created_at)
  where extraction_status = 'pending';

create trigger trg_context_documents_updated_at
  before update on public.context_documents
  for each row execute function public.set_updated_at();

alter table public.context_documents enable row level security;

create policy context_documents_select on public.context_documents for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );
create policy context_documents_write on public.context_documents for all to authenticated
  using (
    client_space_id in (select public.manageable_client_space_ids())
    or (project_id is not null and project_id in (select public.manageable_project_ids()))
  )
  with check (
    client_space_id in (select public.manageable_client_space_ids())
    or (project_id is not null and project_id in (select public.manageable_project_ids()))
  );

grant select, insert, update, delete on public.context_documents to authenticated;

-- =========================================================================
-- search_chunks: ONE index over events, attachments and context documents.
-- Feeds retrieval search AND the nightly task dedupe.
--
-- `source_id` is polymorphic with DELIBERATELY no FK. That is what keeps this
-- table cheaply prunable alongside raw_events, and it is the reason the
-- orphan-reaper index below exists: when a source row is pruned, nothing
-- cascades here, so something has to go looking.
--
-- Embedding type is halfvec(1024) — verified available on the target project
-- (pgvector 0.8.2; halfvec needs >= 0.7.0). See the schema note in
-- 20260901000100_extensions.sql for why `vector` is on the search path rather
-- than in the `extensions` schema.
-- =========================================================================
create table public.search_chunks (
  id              uuid primary key default gen_random_uuid(),
  client_space_id uuid not null references public.client_spaces (id) on delete cascade,
  project_id      uuid,   -- null for space-level context documents
  source_kind     public.chunk_source not null,
  source_id       uuid not null,
  chunk_index     smallint not null default 0,
  provider        public.connector_provider,
  occurred_at     timestamptz not null,
  title           text,
  content         text not null,   -- ~1000 chars, 15% overlap
  source_url      text,

  fts             tsvector generated always as (
                    setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                    setweight(to_tsvector('english', coalesce(content, '')), 'B')
                  ) stored,

  embedding       halfvec(1024),
  -- WHICH model produced the vector. Without this a model swap silently makes
  -- old vectors incomparable to new ones rather than obviously stale — the
  -- failure is a quietly worse ranking, which nobody notices.
  embedding_model text,
  embed_status    public.embed_status not null default 'pending',
  embed_attempts  smallint not null default 0,
  embed_error     text,
  embedded_at     timestamptz,
  -- Gates re-embedding: unchanged text is never re-sent to the provider.
  content_hash    bytea not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),

  foreign key (project_id, client_space_id)
    references public.projects (id, client_space_id) on delete cascade,
  -- One row per (source, chunk). Re-chunking a changed document upserts on
  -- this rather than accumulating.
  unique (source_kind, source_id, chunk_index),
  constraint search_chunks_embedded_has_model_chk
    check (embed_status <> 'embedded' or (embedding is not null and embedding_model is not null))
);

create index search_chunks_fts_idx on public.search_chunks using gin (fts);

-- Built here, while the table is empty. An HNSW build on a populated table is
-- slow and memory-hungry; there is no reason to defer it.
create index search_chunks_embedding_idx
  on public.search_chunks using hnsw (embedding halfvec_cosine_ops);

create index search_chunks_space_time_idx
  on public.search_chunks (client_space_id, occurred_at desc);

-- The embed job's work queue. Stays tiny in steady state.
create index search_chunks_embed_queue_idx
  on public.search_chunks (client_space_id, created_at)
  where embed_status = 'pending';

-- The orphan reaper's lookup. raw_events is pruned at 90 days and nothing
-- cascades to this table (source_id has no FK, deliberately), so chunks whose
-- source is gone would otherwise answer searches forever with text nobody can
-- open. A reaper job joins back through this index; without it the reap is a
-- full scan.
create index search_chunks_source_idx on public.search_chunks (source_kind, source_id);

create trigger trg_search_chunks_updated_at
  before update on public.search_chunks
  for each row execute function public.set_updated_at();

alter table public.search_chunks enable row level security;

create policy search_chunks_select on public.search_chunks for select to authenticated
  using (
    client_space_id in (select public.current_client_space_ids())
    and (project_id is null or project_id in (select public.current_project_ids()))
  );
grant select on public.search_chunks to authenticated;
revoke insert, update, delete on public.search_chunks from authenticated, anon;
