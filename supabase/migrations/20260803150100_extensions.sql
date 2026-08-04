-- Extensions used across the schema.
-- gen_random_uuid() is core in PG13+, no extension needed.
create extension if not exists pgcrypto with schema extensions;  -- gen_random_bytes, digest
create extension if not exists citext   with schema extensions;  -- case-insensitive email
create extension if not exists pg_trgm  with schema extensions;  -- future text search
