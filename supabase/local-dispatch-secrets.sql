-- One-time per `supabase db reset` (Vault secrets don't survive a reset).
-- Run with: npx supabase db execute -f supabase/local-dispatch-secrets.sql
-- Not a migration — this is local-only, per-environment config, never
-- committed as schema. Values here must match .env.development.local's
-- CRON_SECRET and NEXT_PUBLIC_APP_URL exactly.

select vault.create_secret('local-dev-job-dispatch-secret', 'job_dispatch_secret')
where not exists (select 1 from vault.decrypted_secrets where name = 'job_dispatch_secret');

select vault.create_secret('http://host.docker.internal:3000', 'app_base_url')
where not exists (select 1 from vault.decrypted_secrets where name = 'app_base_url');
