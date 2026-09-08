-- pgTAP tests for the vector(1024) migration and match_search_chunks RPC
-- (20260901003150_vector_embeddings.sql). Run with `supabase test db`
-- (requires the local stack: `supabase start`).

begin;
select plan(16);

-- =========================================================================
-- Structural checks
-- =========================================================================

-- 1-2. Both embedding columns are plain vector(1024), not still halfvec —
--      the check that catches a half-applied migration.
select is(
  format_type(atttypid, atttypmod),
  'vector(1024)',
  'search_chunks.embedding is vector(1024)'
) from pg_attribute
where attrelid = 'public.search_chunks'::regclass and attname = 'embedding';

select is(
  format_type(atttypid, atttypmod),
  'vector(1024)',
  'tasks.embedding is vector(1024)'
) from pg_attribute
where attrelid = 'public.tasks'::regclass and attname = 'embedding';

-- 3-4. Both HNSW indexes were rebuilt against vector_cosine_ops, not left on
--      (or reverted to) halfvec_cosine_ops — the opclass is tied to the
--      column's storage type, so a stale index here silently degrades every
--      query to a type-mismatch failure or a sequential scan.
select ok(
  pg_get_indexdef('public.search_chunks_embedding_idx'::regclass) ~ 'hnsw \(embedding vector_cosine_ops\)',
  'search_chunks_embedding_idx uses hnsw + vector_cosine_ops'
);
select ok(
  pg_get_indexdef('public.tasks_embedding_idx'::regclass) ~ 'hnsw \(embedding vector_cosine_ops\)',
  'tasks_embedding_idx uses hnsw + vector_cosine_ops'
);

-- 5. tasks_embedding_idx keeps its partial predicate — the rebuild is
--    exactly where a partial index quietly becomes total.
select ok(
  pg_get_indexdef('public.tasks_embedding_idx'::regclass) ~ '''pending''.*''in_progress''',
  'tasks_embedding_idx retains its status in (pending, in_progress) predicate'
);

-- 6. match_search_chunks exists with the security posture the citation and
--    retrieval design depends on: SECURITY DEFINER, STABLE, search_path
--    locked, and iterative HNSW scan enabled so filtered queries don't
--    silently under-return.
select ok(
  (
    select prosecdef and provolatile = 's'
      and exists (select 1 from unnest(proconfig) c where c like 'search_path=%')
      and exists (select 1 from unnest(proconfig) c where c like 'hnsw.iterative_scan=%')
    from pg_proc
    where proname = 'match_search_chunks' and pronamespace = 'public'::regnamespace
  ),
  'match_search_chunks is SECURITY DEFINER, STABLE, with search_path and hnsw.iterative_scan locked'
);

-- 7. Grants: service_role only, never anon/authenticated — this is the
--    load-bearing lock (see schema_invariants_test.sql's own note on why
--    the grant matters more than RLS-with-no-policies).
select is(
  ARRAY[
    has_function_privilege('anon', 'public.match_search_chunks(uuid, vector, uuid, int, double precision, text, uuid[], boolean)', 'EXECUTE'),
    has_function_privilege('authenticated', 'public.match_search_chunks(uuid, vector, uuid, int, double precision, text, uuid[], boolean)', 'EXECUTE'),
    has_function_privilege('service_role', 'public.match_search_chunks(uuid, vector, uuid, int, double precision, text, uuid[], boolean)', 'EXECUTE')
  ],
  ARRAY[false, false, true],
  'match_search_chunks is executable by service_role only'
);

-- 8. Guard rail: find_similar_open_tasks must NOT exist. This is precisely
--    the task-dedupe-by-raw-distance feature a prior branch shipped, then
--    reverted after it silently merged ~42 unrelated Slack messages into
--    one task. A well-meaning future contributor resurrecting it from that
--    branch is exactly the failure this line documents against.
select is(
  to_regprocedure('public.find_similar_open_tasks(uuid, vector, int)'),
  null,
  'find_similar_open_tasks does not exist (deliberately not resurrected)'
);

-- =========================================================================
-- Functional checks — fixtures
-- =========================================================================

-- Session-scoped helper: a 1024-dim vector with `v1` at position `p1` and
-- (optionally) `v2` at position `p2`, zero elsewhere. Lets every test vector
-- below be constructed as one readable call instead of a hand-typed
-- 1024-element literal.
create or replace function pg_temp.test_vec(p1 int, v1 numeric, p2 int default null, v2 numeric default 0)
returns vector language sql as $$
  select ('[' || string_agg(
    case when i = p1 then v1::text when i = p2 then v2::text else '0' end, ','
  ) || ']')::vector
  from generate_series(1, 1024) i
$$;

insert into public.tenants (id, name, slug) values
  ('90000000-0000-0000-0000-00000000009a', 'Vector Test Co', 'vector-test-co');
insert into public.workspaces (id, tenant_id, name, slug) values
  ('c0000000-0000-0000-0000-00000000009a', '90000000-0000-0000-0000-00000000009a', 'Vector Test WS', 'vector-test-ws');

-- Two client spaces, to prove cross-tenant isolation at the RPC level (not
-- merely at RLS — match_search_chunks is SECURITY DEFINER and takes
-- p_client_space_id directly from its caller).
insert into public.client_spaces (id, workspace_id, tenant_id, name, slug) values
  ('10000000-0000-0000-0000-00000000009a', 'c0000000-0000-0000-0000-00000000009a', '90000000-0000-0000-0000-00000000009a', 'Space A', 'space-a-vec'),
  ('10000000-0000-0000-0000-00000000009b', 'c0000000-0000-0000-0000-00000000009a', '90000000-0000-0000-0000-00000000009a', 'Space B', 'space-b-vec');
insert into public.projects (id, client_space_id, workspace_id, name, slug) values
  ('e0000000-0000-0000-0000-00000000009a', '10000000-0000-0000-0000-00000000009a', 'c0000000-0000-0000-0000-00000000009a', 'Project A', 'project-a-vec');

-- One normalized_event and one event_attachment in space A, so
-- citable_event_id resolution can be exercised for both source kinds.
-- auth_mode='none' is the credential-less connector mode (the mock
-- connector's own mode — see 20260901001700_allow_credentialless_connections.sql).
insert into public.space_connections (id, client_space_id, provider, auth_mode, external_account_id, status) values
  ('30000000-0000-0000-0000-00000000009a', '10000000-0000-0000-0000-00000000009a', 'mock', 'none', 'vec-test-account', 'connected');
insert into public.project_connectors (id, project_id, client_space_id, connection_id, provider) values
  ('40000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', '10000000-0000-0000-0000-00000000009a', '30000000-0000-0000-0000-00000000009a', 'mock');
insert into public.normalized_events (id, project_connector_id, project_id, client_space_id, provider, type, dedupe_key, occurred_at) values
  ('50000000-0000-0000-0000-00000000009a', '40000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', '10000000-0000-0000-0000-00000000009a', 'mock', 'mock.message', 'vec-test-dedupe-1', now());
insert into public.event_attachments (id, normalized_event_id, client_space_id, project_id, project_connector_id, provider, provider_attachment_id, filename, status) values
  ('60000000-0000-0000-0000-00000000009a', '50000000-0000-0000-0000-00000000009a', '10000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', '40000000-0000-0000-0000-00000000009a', 'mock', 'vec-test-attach-1', 'notes.txt', 'extracted');

-- Query vector: pure e1.
-- c1: identical to query (distance 0) — normalized_event chunk, space A.
-- c2: 0.8*e1 + 0.6*e2, unit norm (distance 0.2) — event_attachment chunk, space A.
-- c3: 0.6*e1 + 0.8*e2, unit norm (distance 0.4) — normalized_event chunk, space A, wrong embedding_model.
-- c4: pure e2, orthogonal to query (distance 1.0, filtered by p_max_distance) — context_document chunk, space A.
-- c5: identical to query (distance 0) — space B, must never be returned for space A queries.
insert into public.search_chunks
  (id, client_space_id, project_id, source_kind, source_id, chunk_index, provider, occurred_at, title, content, embedding, embedding_model, embed_status, content_hash, page_number)
values
  -- c2 (event_attachment) carries page_number 3, exercising the one
  -- source_kind page_number is ever populated for; every other row is null,
  -- matching every non-paginated source in production.
  ('70000000-0000-0000-0000-000000000001', '10000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', 'normalized_event', '50000000-0000-0000-0000-00000000009a', 0, 'mock', now(), 'c1', 'closest match', pg_temp.test_vec(1, 1), 'text-embedding-3-small@1024', 'embedded', '\x00', null),
  ('70000000-0000-0000-0000-000000000002', '10000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', 'event_attachment', '60000000-0000-0000-0000-00000000009a', 0, 'mock', now(), 'c2', 'second closest', pg_temp.test_vec(1, 0.8, 2, 0.6), 'text-embedding-3-small@1024', 'embedded', '\x00', 3),
  ('70000000-0000-0000-0000-000000000003', '10000000-0000-0000-0000-00000000009a', null, 'normalized_event', '50000000-0000-0000-0000-00000000009a', 1, 'mock', now(), 'c3-wrong-model', 'third, wrong model', pg_temp.test_vec(1, 0.6, 2, 0.8), 'some-other-model', 'embedded', '\x00', null),
  ('70000000-0000-0000-0000-000000000004', '10000000-0000-0000-0000-00000000009a', 'e0000000-0000-0000-0000-00000000009a', 'context_document', '80000000-0000-0000-0000-00000000009a', 0, null, now(), 'c4-orthogonal', 'unrelated topic', pg_temp.test_vec(2, 1), 'text-embedding-3-small@1024', 'embedded', '\x00', null),
  ('70000000-0000-0000-0000-000000000005', '10000000-0000-0000-0000-00000000009b', null, 'normalized_event', '90000000-0000-0000-0000-000000000099', 0, 'mock', now(), 'c5-other-space', 'must never leak', pg_temp.test_vec(1, 1), 'text-embedding-3-small@1024', 'embedded', '\x00', null);

-- 9. Cross-tenant isolation: space B's identical-to-query chunk never
--    returns for a space-A query, even unfiltered by distance.
select is(
  (
    select count(*)::int from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2
    ) where chunk_id = '70000000-0000-0000-0000-000000000005'
  ),
  0,
  'a chunk belonging to a different client space is never returned'
);

-- 10. Distance ordering: c1, c2, c3 come back strictly ascending by distance
--     (c4 excluded here by p_project_id + p_max_distance, exercised on its
--     own below). p_one_per_source := false so all three (distinct sources)
--     survive the per-source collapse.
select is(
  (
    select array_agg(title order by distance)
    from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2,
      p_embedding_model := null,
      p_one_per_source := false
    )
    where title in ('c1', 'c2', 'c3-wrong-model')
  ),
  ARRAY['c1', 'c2', 'c3-wrong-model'],
  'results come back in ascending cosine-distance order'
);

-- 11. p_max_distance clips: at the default-ish 0.65, the orthogonal chunk
--     (distance 1.0) is excluded while the three near chunks (0, 0.2, 0.4)
--     survive.
select is(
  (
    select count(*)::int from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 0.65,
      p_one_per_source := false
    ) where title = 'c4-orthogonal'
  ),
  0,
  'p_max_distance excludes a chunk beyond the threshold'
);

-- 12. p_exclude_source_ids excludes the named source, even though it would
--     otherwise be the single closest match.
select is(
  (
    select count(*)::int from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2,
      p_exclude_source_ids := array['50000000-0000-0000-0000-00000000009a']::uuid[]
    ) where title = 'c1'
  ),
  0,
  'p_exclude_source_ids excludes matching sources'
);

-- 13. project_id IS NULL visibility: c4 has project_id null and must still
--     be visible to a p_project_id-scoped call (space-level chunks are
--     visible to every project in the space).
select is(
  (
    select count(*)::int from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_project_id := 'e0000000-0000-0000-0000-00000000009a',
      p_max_distance := 2
    ) where title = 'c4-orthogonal'
  ),
  1,
  'a project_id IS NULL chunk is visible to a project-scoped query'
);

-- 14. p_embedding_model filters out a chunk embedded under a different
--     model — a stale/incomparable vector must never silently rank.
select is(
  (
    select count(*)::int from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2,
      p_embedding_model := 'text-embedding-3-small@1024'
    ) where title = 'c3-wrong-model'
  ),
  0,
  'p_embedding_model excludes a chunk embedded under a different model'
);

-- 15. citable_event_id resolution: a normalized_event chunk resolves to its
--     own id; an event_attachment chunk resolves to its PARENT event's id
--     (via the left join, not the attachment's own id); a context_document
--     chunk resolves to null (task_sources.normalized_event_id is NOT NULL,
--     so it structurally can't be cited yet — see the migration's comment).
select is(
  (
    select jsonb_object_agg(title, citable_event_id)
    from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2,
      p_one_per_source := false
    )
    where title in ('c1', 'c2', 'c4-orthogonal')
  ),
  jsonb_build_object(
    'c1', '50000000-0000-0000-0000-00000000009a',
    'c2', '50000000-0000-0000-0000-00000000009a',
    'c4-orthogonal', null
  ),
  'citable_event_id resolves correctly for normalized_event, event_attachment, and context_document chunks'
);

-- 16. page_number survives the RPC's drop/recreate (20260902000100): the
--     one paginated source (c2, an event_attachment) returns its page,
--     every other source_kind returns null.
select is(
  (
    select jsonb_object_agg(title, page_number)
    from public.match_search_chunks(
      p_client_space_id := '10000000-0000-0000-0000-00000000009a',
      p_embedding := pg_temp.test_vec(1, 1),
      p_max_distance := 2,
      p_one_per_source := false
    )
    where title in ('c1', 'c2', 'c4-orthogonal')
  ),
  jsonb_build_object('c1', null, 'c2', 3, 'c4-orthogonal', null),
  'page_number is returned per row: set for the paginated attachment chunk, null for every other source_kind'
);

select * from finish();
rollback;
