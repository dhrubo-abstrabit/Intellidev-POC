-- =========================================================================
-- Admits auth_mode = 'none' to space_connections, and requires that such a
-- row carry NO credential material at all.
--
-- The negative half matters as much as the positive half: without it, 'none'
-- would be a hole through which a row could carry half-configured Nango or
-- api_key fields that nothing validates. A credential-less connection must be
-- genuinely credential-less.
--
-- See 20260901001600_auth_mode_none.sql for why this is a separate file.
-- =========================================================================
alter table public.space_connections
  drop constraint space_connections_auth_mode_chk;

alter table public.space_connections
  add constraint space_connections_auth_mode_chk check (
    (auth_mode = 'nango'   and nango_connection_id is not null
                           and nango_provider_config_key is not null
                           and secret_ciphertext is null)
    or
    (auth_mode = 'api_key' and secret_ciphertext is not null
                           and secret_iv is not null
                           and secret_key_version is not null
                           and nango_connection_id is null)
    or
    (auth_mode = 'none'    and nango_connection_id is null
                           and nango_provider_config_key is null
                           and secret_ciphertext is null
                           and secret_iv is null
                           and secret_key_version is null)
  );

comment on column public.space_connections.auth_mode is
  'nango   - Nango holds token custody; nango_connection_id identifies it. '
  'api_key - a locally-sealed AES-256-GCM secret, for providers with no OAuth '
  '          dance (Supabase, OpenAI Codex). '
  'none    - no credential at all. The mock connector, which is load-bearing '
  '          for tests and local dev without live OAuth.';
