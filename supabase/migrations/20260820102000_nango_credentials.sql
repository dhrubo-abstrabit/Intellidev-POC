-- =========================================================================
-- Nango migration for connector_credentials, ported onto the 4-level
-- schema. Unlike the pre-4-level version this superseded, this is a
-- straight cutover, not a two-step additive migration: no integration has
-- ever been connected through the legacy AES-256-GCM path on this schema
-- (it was replaced before this schema's first real deploy), so there is no
-- "reconnect everyone through Nango" transition window to protect. See
-- NANGO_MIGRATION_LOG.md for the full rationale (D-001 through D-017).
--
-- connector_credentials keeps its role as the mapping table (D-008): a row
-- now identifies a Nango connection via the two columns added below, rather
-- than a locally-sealed secret. No column-name changes are needed on this
-- table to port this — client_space_id/workspace_id scoping was already in
-- place before Nango landed on this branch.
-- =========================================================================
alter table public.connector_credentials
  add column nango_connection_id text,
  add column nango_provider_config_key text;

comment on column public.connector_credentials.nango_connection_id is
  'Nango''s own (random UUID) identifier for this OAuth connection. See '
  'NANGO_MIGRATION_LOG.md D-008.';

comment on column public.connector_credentials.nango_provider_config_key is
  'The Nango integration id this connection belongs to (e.g. "google", '
  '"slack") — distinct from public.connector_provider, since one Nango '
  'integration (the generic "google" provider) can back the same '
  'provider value this table already used for the merged connector. '
  'See NANGO_MIGRATION_LOG.md D-005.';

-- Nango's connection ids are globally unique on their side; enforce that
-- here too so a bug can't silently attach two local credential rows to the
-- same Nango connection. A plain unique index permits any number of NULLs.
create unique index connector_credentials_nango_connection_id_idx
  on public.connector_credentials (nango_connection_id)
  where nango_connection_id is not null;

-- Nango-era rows never populate the legacy secret columns (there is nothing
-- to encrypt locally once Nango holds the token) — these were `not null`
-- under the pre-Nango design, which would otherwise make a Nango-only row
-- impossible to insert.
alter table public.connector_credentials
  alter column secret_ciphertext drop not null,
  alter column secret_iv drop not null;

-- This index existed to support a proactive "refresh credentials nearing
-- expiry" scan, which was never actually built (services/sync/credentials.ts
-- only ever looks up a single row by id + workspace_id, refreshing
-- on-demand). Nango owns refresh entirely now, so the index has no future
-- the pre-Nango path didn't already forgo.
drop index if exists public.connector_credentials_refresh_due_idx;
