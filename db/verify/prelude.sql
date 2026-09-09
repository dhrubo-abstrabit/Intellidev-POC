-- What Supabase provides, stood up by hand so the baseline can be replayed locally.
--
-- `supabase db dump --schema public` deliberately omits everything outside `public`, which
-- means baseline/product-schema.sql is NOT replayable on its own: it references
-- `extensions.digest`, the `public.vector` type, and `auth.users` / `auth.uid()`. Discovering
-- that at the point you need to rebuild a database would be a bad time, so the dependency is
-- written down here instead.
--
-- This is a verification fixture, not a migration. It is never applied to a real database —
-- there, Supabase owns all three of these.

-- Supabase puts extensions in their own schema. The baseline needs exactly two things from
-- there: `digest` (pgcrypto), called by accept_invitation(), and the `citext` type, used for
-- four case-insensitive email columns.
CREATE SCHEMA IF NOT EXISTS "extensions";
CREATE EXTENSION IF NOT EXISTS "pgcrypto" WITH SCHEMA "extensions";
CREATE EXTENSION IF NOT EXISTS "citext" WITH SCHEMA "extensions";

-- pgvector is installed into public on this project, hence the public.vector(384) columns.
CREATE EXTENSION IF NOT EXISTS "vector" WITH SCHEMA "public";

-- The identity table. public.users.id is a foreign key onto this, which is what makes
-- Supabase Auth the source of identity for the whole model.
CREATE SCHEMA IF NOT EXISTS "auth";

CREATE TABLE IF NOT EXISTS "auth"."users" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "email" text
);

-- The real one reads the request's JWT claims. This is the same contract: every helper
-- function in the product schema resolves the caller through it, so a test that sets
-- `request.jwt.claims` exercises the true authorization path rather than a stand-in.
CREATE OR REPLACE FUNCTION "auth"."uid"() RETURNS uuid
    LANGUAGE "sql" STABLE
    AS $$
  SELECT NULLIF(
    current_setting('request.jwt.claims', true)::json ->> 'sub',
    ''
  )::uuid
$$;

-- Roles exist in the supabase/postgres image already; granting is all that is needed.
GRANT USAGE ON SCHEMA "auth" TO "authenticated", "anon", "service_role";
GRANT SELECT ON "auth"."users" TO "authenticated", "service_role";
