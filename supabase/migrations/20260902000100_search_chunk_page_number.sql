-- =========================================================================
-- search_chunks.page_number: which page of a paginated source (currently
-- only PDF attachments — LangChain's PDFLoader splits per page, mammoth/
-- Slack/Gmail/html/text sources have no page concept) a chunk came from.
-- Nullable for exactly that reason; no default, no index (nothing filters
-- on it — it's provenance display data, surfaced via task_sources.chunk_id
-- in the Task Tracking "Source" panel, not a query predicate).
--
-- Instant, non-rewriting: nullable column, no default, no backfill. Existing
-- rows get null, which is the correct answer for them (chunked before this
-- column existed, from the old non-paginated flat-text parse).
-- =========================================================================
alter table public.search_chunks
  add column page_number smallint check (page_number is null or page_number > 0);

comment on column public.search_chunks.page_number is
  'Which page of a paginated source (PDF) this chunk came from. Null for every non-paginated source_kind/parser.';

-- match_search_chunks must be DROPPED and recreated, not `create or
-- replace`d — Postgres refuses to replace a function whose RETURNS TABLE
-- shape changes. Re-issuing the revoke/grant after is required, not
-- defensive: privileges are discarded along with the dropped function, and
-- supabase/tests/vector_search_test.sql asserts them — a forgotten re-grant
-- fails loudly there rather than silently reopening/closing access.
drop function public.match_search_chunks(
  uuid, vector, uuid, int, double precision, text, uuid[], boolean
);

create function public.match_search_chunks(
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
  page_number       smallint,
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
      sc.occurred_at, sc.source_url, sc.page_number,
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
         source_url, citable_event_id, page_number, distance
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
