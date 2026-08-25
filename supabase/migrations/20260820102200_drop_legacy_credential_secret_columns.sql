-- =========================================================================
-- Drops the 7 columns left behind by the AES-256-GCM token-crypto layer
-- that Nango replaced (see 20260820102000_nango_credentials.sql, which
-- dropped their NOT NULL constraints and the one index that covered them,
-- but kept the columns themselves). Confirmed dead before this migration:
-- zero reads/writes anywhere in src/, no constraint, no RLS policy, no
-- trigger/function, no pgTAP assertion, no seed data. See
-- NANGO_MIGRATION_LOG.md for the full rationale.
--
-- secret_ciphertext/secret_iv held the sealed OAuth token blob; secret_key_
-- version/secret_alg recorded which encryption key/algorithm sealed it;
-- access_token_expires_at/refresh_failed_at/refresh_failure_count backed a
-- proactive "refresh nearing expiry" scan that was never built (services/
-- sync/credentials.ts only ever refreshes on-demand, and Nango owns refresh
-- entirely now).
-- =========================================================================
alter table public.connector_credentials
  drop column secret_ciphertext,
  drop column secret_iv,
  drop column secret_key_version,
  drop column secret_alg,
  drop column access_token_expires_at,
  drop column refresh_failed_at,
  drop column refresh_failure_count;
