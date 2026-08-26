-- =========================================================================
-- Extensions. Ordered FIRST, before anything that references them.
--
-- This ordering is not cosmetic: the previous schema shipped the pg_net
-- dispatcher before the extension and failed on the cloud project with
-- `schema "net" does not exist` while passing locally (the CLI's own
-- bootstrap registers pg_net in the local image). Declaring every extension
-- up front makes that class of failure structurally impossible.
--
-- gen_random_uuid() is core in PG13+, no extension needed.
-- =========================================================================
create extension if not exists pgcrypto with schema extensions;  -- gen_random_bytes, digest
create extension if not exists citext   with schema extensions;  -- case-insensitive email
create extension if not exists pg_trgm  with schema extensions;  -- fuzzy text matching

-- pg_net installs into its own `net` schema via its extension script; it does
-- not take a `with schema` clause the way the three above do.
create extension if not exists pg_net;

-- =========================================================================
-- pgvector. Deliberately installed WITHOUT a `with schema extensions` clause,
-- unlike pgcrypto/citext/pg_trgm above — this one lands on the search path.
--
-- Reason: every SECURITY DEFINER function in this schema sets
-- `search_path = ''`. config.toml's `extra_search_path = ["public",
-- "extensions"]` applies only to PostgREST's request connections, NOT inside
-- a `search_path = ''` function body. With the type and its operators in
-- `extensions`, any similarity search inside such a function fails at runtime
-- with `operator does not exist: extensions.halfvec <=> extensions.halfvec`,
-- and operators cannot be schema-qualified with ordinary syntax — it would
-- take `operator(extensions.<=>)` at every single call site.
--
-- Keeping vector on the search path costs nothing here: `public` is exactly
-- the blast radius of the schema reset this migration set is part of.
--
-- Verified on the cloud project 2026-08-26: pgvector 0.8.2 available, and a
-- halfvec(1024) column with an hnsw (halfvec_cosine_ops) index both build
-- successfully. halfvec requires >= 0.7.0.
-- =========================================================================
create extension if not exists vector;
