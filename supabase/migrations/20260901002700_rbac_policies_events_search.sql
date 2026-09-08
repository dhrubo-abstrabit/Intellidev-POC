-- =========================================================================
-- RBAC, part 6 of 6 (b): policy rewrite — sync bookkeeping, events,
-- attachments and the search index. Everything gated on `data.read`.
--
-- THESE ARE THE HOT TABLES. normalized_events, event_attachments and
-- search_chunks are the ones sized in the millions, and they are the reason
-- space_ids_with() and project_ids_with() take a permission LITERAL rather
-- than a row column: the predicate shape is unchanged, so Postgres still
-- hoists each `in (select ...)` into an InitPlan evaluated once per
-- statement. Verified with `explain (analyze, verbose)` — see the pgTAP
-- suite and the plan capture in the PR.
--
-- The two-armed predicates are reproduced EXACTLY as they were, including
-- the difference between them:
--
--   * normalized_events and event_attachments declare project_id NOT NULL,
--     so their second arm is a bare `project_id in (...)`.
--   * search_chunks, context_documents and tasks allow a null project_id
--     (space-level rows), so theirs is `project_id is null or ...`.
--
-- Getting that backwards on the first group would be harmless; getting it
-- backwards on the second would hide every space-level row. Left alone.
--
-- No workspace- or tenant-level role holds data.read, so
-- space_ids_with('data.read') returns only spaces the caller actually joined.
-- That is how "workspace admins manage a space and read none of it" survives
-- the rewrite — as an absent row in the grid rather than as two helpers that
-- have to be kept in agreement by hand.
-- =========================================================================

-- =========================================================================
-- Sync bookkeeping. Read-only to clients; the engine writes as service role.
-- =========================================================================
drop policy sync_jobs_select on public.sync_jobs;
create policy sync_jobs_select on public.sync_jobs for select to authenticated
  using (client_space_id in (select public.space_ids_with('data.read')));

drop policy sync_batches_select on public.sync_batches;
create policy sync_batches_select on public.sync_batches for select to authenticated
  using (client_space_id in (select public.space_ids_with('data.read')));

drop policy sync_batch_members_select on public.sync_batch_members;
create policy sync_batch_members_select on public.sync_batch_members for select to authenticated
  using (client_space_id in (select public.space_ids_with('data.read')));

-- =========================================================================
-- Ingested events and their attachments. project_id is NOT NULL on both.
-- =========================================================================
drop policy normalized_events_select on public.normalized_events;
create policy normalized_events_select on public.normalized_events for select to authenticated
  using (
    client_space_id in (select public.space_ids_with('data.read'))
    and project_id in (select public.project_ids_with('data.read'))
  );

drop policy event_attachments_select on public.event_attachments;
create policy event_attachments_select on public.event_attachments for select to authenticated
  using (
    client_space_id in (select public.space_ids_with('data.read'))
    and project_id in (select public.project_ids_with('data.read'))
  );

-- =========================================================================
-- search_chunks: one index over events, attachments and context documents.
-- project_id is nullable here — a space-level context document produces
-- chunks with no project.
-- =========================================================================
drop policy search_chunks_select on public.search_chunks;
create policy search_chunks_select on public.search_chunks for select to authenticated
  using (
    client_space_id in (select public.space_ids_with('data.read'))
    and (project_id is null or project_id in (select public.project_ids_with('data.read')))
  );
