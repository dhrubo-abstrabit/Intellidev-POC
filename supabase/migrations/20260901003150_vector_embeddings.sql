-- =========================================================================
-- search_chunks.embedding and tasks.embedding were declared halfvec(1024)
-- for a model that had not been chosen yet. The model is now OpenAI's
-- text-embedding-3-small, requested at 1024 dimensions via the API's
-- `dimensions` parameter (Matryoshka-trained truncation — the reduced
-- vector is produced server-side and already L2-normalized; there is no
-- client-side slicing or renormalizing anywhere in this codebase).
--
-- Switched to plain `vector(1024)`, not halfvec:
--   * halfvec exists to halve storage on LARGE embeddings (3072-dim
--     text-embedding-3-large, where it is also REQUIRED because HNSW caps
--     plain `vector` at 2000 dims). At 1024 it saves 2048 bytes/row and
--     costs precision for nothing.
--   * `supabase gen types` emits `unknown` for a halfvec column and
--     `string | null` for a plain vector column. With halfvec, every write
--     site needs an `as unknown` cast — a permanent, pointless tax.
--
-- Both columns are empty in every environment (confirmed: no application
-- code writes either one on main), so this is a plain type change, not a
-- data migration, and the HNSW rebuilds below cost nothing today. This file
-- would need CONCURRENTLY handling if it ever had to run against live data.
-- =========================================================================

-- Index dropped BEFORE the column type change, NOT after. ALTER COLUMN TYPE
-- validates every dependent index against the NEW type inside the same
-- statement, and halfvec_cosine_ops genuinely cannot operate on `vector`
-- data. Verified empirically on a reference branch; this ordering is
-- load-bearing, not stylistic.
drop index if exists public.search_chunks_embedding_idx;
alter table public.search_chunks
  alter column embedding type vector(1024);
create index search_chunks_embedding_idx
  on public.search_chunks using hnsw (embedding vector_cosine_ops);

-- tasks.embedding is changed here even though nothing yet writes it. One
-- app, one embedding model, one dimensionality — leaving a halfvec(1024)
-- column behind guarantees a future reader has to re-derive which of the
-- two is real. The deliberately-absent piece is a WRITER: see
-- src/services/action-items/generate.ts. This column stays null until a
-- task-dedupe feature is designed that feeds kNN candidates into the LLM
-- consolidation call as a signal, rather than auto-merging on raw cosine
-- distance — see the note on find_similar_open_tasks below for why that
-- matters here specifically.
drop index if exists public.tasks_embedding_idx;
alter table public.tasks
  alter column embedding type vector(1024);
create index tasks_embedding_idx
  on public.tasks using hnsw (embedding vector_cosine_ops)
  where status in ('pending', 'in_progress');

-- =========================================================================
-- match_search_chunks: kNN retrieval over the client space's indexed
-- history, for injection into the extraction prompt (retrieval-augmented
-- task extraction) and for resolving citations back to their source event.
--
-- SERVICE-ROLE ONLY. Called from src/services/search/retrieve.ts, which
-- already runs under the service client. Not exposed to `authenticated`:
-- this is SECURITY DEFINER and takes p_client_space_id from its caller, so
-- an authenticated grant would be a cross-tenant read. A future user-facing
-- semantic search needs a SEPARATE, SECURITY INVOKER variant so
-- search_chunks_select applies — do not widen this one's grants.
--
-- `operator(public.<=>)`, not bare `<=>`: `set search_path = ''` is applied
-- while Postgres analyses a LANGUAGE SQL body at CREATE time, and an
-- operator cannot be schema-qualified with ordinary dot notation. Verified
-- empirically on this project — bare `<=>` fails with "operator does not
-- exist" even though pgvector is deliberately installed on the search path
-- (see 20260901000100_extensions.sql).
--
-- `set hnsw.iterative_scan = 'strict_order'` (pgvector >= 0.8.0; this
-- project is on 0.8.2): every predicate below (client_space_id, project_id,
-- embed_status, the exclusion list) is a POST-filter relative to the HNSW
-- ordered scan. Without iterative scan, a filtered query can silently
-- return fewer rows than p_limit because the first ef_search candidates all
-- got filtered out — a quietly-degraded prompt, which nobody notices.
-- strict_order (not relaxed_order) keeps exact distance ordering; at this
-- table's size the extra cost is irrelevant.
--
-- citable_event_id is resolved here, server-side, rather than by the app
-- layer re-deriving it: a normalized_event chunk's source_id IS its event
-- id; an event_attachment chunk's source_id is the attachment's own id, so
-- it's resolved via a left join to event_attachments.normalized_event_id;
-- a context_document chunk has no owning event and resolves to null.
-- task_sources.normalized_event_id is NOT NULL, so a null citable_event_id
-- means that chunk cannot be recorded as a task_sources citation — an
-- accepted gap while context_documents has no writer at all (deferred).
--
-- p_max_distance is a PROMPT-BUDGET gate, not a decision threshold. A false
-- positive here costs input tokens; it cannot write anything on its own —
-- a chunk only ever reaches task_sources if the model explicitly cites its
-- ephemeral per-run label AND that label resolves to a non-null
-- citable_event_id (see generate.ts). That is the structural difference
-- from the task-dedupe kNN this project tried once and reverted
-- (find_similar_open_tasks — deliberately NOT recreated here), where a
-- mis-calibrated distance silently merged unrelated tasks by itself.
-- Calibrate the default from real retrieved distances (recorded in
-- llm_runs.prompt by the consumer) rather than from intuition.
-- =========================================================================
create or replace function public.match_search_chunks(
  p_client_space_id    uuid,
  p_embedding          vector(1024),
  p_project_id         uuid    default null,
  p_limit              int     default 12,
  p_max_distance       double precision default 0.65,
  p_embedding_model    text    default null,
  p_exclude_source_ids uuid[]  default '{}'::uuid[],
  p_one_per_source     boolean default true
)
returns table (
  chunk_id          uuid,
  source_kind       public.chunk_source,
  source_id         uuid,
  provider          public.connector_provider,
  title             text,
  content           text,
  occurred_at       timestamptz,
  source_url        text,
  citable_event_id  uuid,
  distance          double precision
)
language sql
security definer
stable
set search_path = ''
set hnsw.iterative_scan = 'strict_order'
as $$
  with ranked as (
    select
      sc.id, sc.source_kind, sc.source_id, sc.provider, sc.title, sc.content,
      sc.occurred_at, sc.source_url,
      case sc.source_kind
        when 'normalized_event' then sc.source_id
        when 'event_attachment' then ea.normalized_event_id
        else null
      end as citable_event_id,
      sc.embedding operator(public.<=>) p_embedding as distance
    from public.search_chunks sc
    left join public.event_attachments ea
      on ea.id = sc.source_id and sc.source_kind = 'event_attachment'
    where sc.client_space_id = p_client_space_id
      and sc.embed_status = 'embedded'
      and sc.embedding is not null
      -- Mirrors search_chunks_select's own two-armed predicate: a
      -- space-level chunk (project_id null) is in scope for every project.
      and (p_project_id is null or sc.project_id is null or sc.project_id = p_project_id)
      -- A model swap makes old vectors incomparable rather than merely
      -- stale (see search_chunks.embedding_model's own column comment).
      -- retrieve.ts always passes its EMBEDDING_MODEL constant.
      and (p_embedding_model is null or sc.embedding_model = p_embedding_model)
      -- The caller's own inputs — e.g. today's own normalized_events AND
      -- event_attachments ids, so retrieval never hands back text that's
      -- already in the prompt verbatim.
      and not (sc.source_id = any (p_exclude_source_ids))
    order by sc.embedding operator(public.<=>) p_embedding
    -- Over-fetch so the per-source collapse below still has p_limit distinct
    -- sources to choose from. 4x is a guess sized for chat-length sources
    -- (1-2 chunks each); a long document could still under-fill.
    limit case when p_one_per_source then p_limit * 4 else p_limit end
  ),
  collapsed as (
    select distinct on (r.source_id) r.*
    from ranked r
    where p_one_per_source
    order by r.source_id, r.distance
  )
  select id, source_kind, source_id, provider, title, content, occurred_at,
         source_url, citable_event_id, distance
  from (
    select * from collapsed
    union all
    select * from ranked where not p_one_per_source
  ) final
  where final.distance <= p_max_distance
  order by final.distance
  limit p_limit;
$$;

revoke execute on function public.match_search_chunks(
  uuid, vector, uuid, int, double precision, text, uuid[], boolean
) from public, anon, authenticated;
grant execute on function public.match_search_chunks(
  uuid, vector, uuid, int, double precision, text, uuid[], boolean
) to service_role;

-- =========================================================================
-- Deliberately absent from this migration: find_similar_open_tasks (or any
-- task-dedupe-by-raw-distance function). A prior attempt at this shipped,
-- then was reverted, after a raw cosine-distance auto-merge silently folded
-- ~42 topically-unrelated Slack messages into one unrelated task under a
-- 384-dim embedding model whose short-text vectors turned out to be far
-- more anisotropic than assumed. That is not what match_search_chunks above
-- does — its results only ever reach a prompt as advisory context, or a
-- task_sources row when the MODEL explicitly cites a chunk's ephemeral
-- label — but a future task-dedupe feature should still feed kNN
-- candidates into an LLM consolidation call as a signal, never auto-merge
-- on distance alone. Do not resurrect find_similar_open_tasks; see
-- supabase/tests/vector_search_test.sql for a guard test asserting it
-- does not exist.
-- =========================================================================
