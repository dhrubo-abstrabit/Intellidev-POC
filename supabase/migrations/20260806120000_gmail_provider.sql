-- Adds 'gmail' to connector_provider. Postgres forbids USING a new enum
-- value inside the same transaction that added it, so this migration does
-- nothing else — any DDL/DML mentioning 'gmail' must live in a later file
-- (see 20260806120100_connector_config_comments.sql, which only references
-- it in a comment string, not a typed value, so it's safe either way).
alter type public.connector_provider add value if not exists 'gmail';
