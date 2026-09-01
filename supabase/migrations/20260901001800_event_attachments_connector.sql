-- =========================================================================
-- Restores a connector reference on event_attachments.
--
-- The v2 draft dropped it, on the reasoning that an attachment hangs off its
-- normalized event and the connector is reachable through that. True for
-- reads — but the DOWNLOAD path needs it directly, and cannot get there
-- cheaply or safely:
--
--   * Attachment bytes are fetched with the CREDENTIALS OF THE CONNECTOR THAT
--     SAW THE FILE. A project may scope several connectors (a Slack and a
--     Google one, or two Slack workspaces), so "pending attachments for this
--     project" is not a set one credential can service. Using the wrong one
--     fails at the provider with a 401/404 that looks like a missing file.
--   * download_ref is provider-shaped, so the row is already only meaningful
--     in the context of the connector that produced it.
--
-- Without this column the attachments job would have to join back through
-- normalized_events on every pass just to re-derive which credential to use,
-- and its work queue could not be indexed on the thing it actually filters by.
--
-- NOT NULL is safe: the table is empty on every environment at the time this
-- runs (the schema was rebuilt, not migrated).
--
-- The FK is three columns, matching raw_events and normalized_events — so an
-- attachment cannot claim a project different from its connector's.
-- =========================================================================
alter table public.event_attachments
  add column project_connector_id uuid not null;

alter table public.event_attachments
  add constraint event_attachments_connector_fkey
  foreign key (project_connector_id, project_id, client_space_id)
  references public.project_connectors (id, project_id, client_space_id) on delete cascade;

-- The attachments job's work queue, now keyed on what it actually filters by.
-- Replaces the project-scoped variant, which would have made every run scan
-- rows it could not service.
drop index if exists public.event_attachments_pending_idx;
create index event_attachments_pending_idx
  on public.event_attachments (project_connector_id, created_at)
  where status = 'pending';
