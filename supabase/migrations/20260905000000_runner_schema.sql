-- The runner's own schema.
--
-- Everything this system adds lives under `runner`, and nothing here creates or alters an
-- object in `public`. That boundary is what makes it safe for this repo to keep a migration
-- history separate from the one the product schema already has. Those two histories were
-- merged later, which is why this file now sits among the product migrations. See
-- DATABASE.md.
--
-- Tenancy is not reimplemented. Every policy below calls the product's own helper functions,
-- so a user sees exactly the spaces and projects they see everywhere else, and a change to
-- their model propagates here for free.

CREATE SCHEMA IF NOT EXISTS "runner";

GRANT USAGE ON SCHEMA "runner" TO "authenticated", "service_role";

--------------------------------------------------------------------------------
-- project_repos — which repositories a project may target
--------------------------------------------------------------------------------
-- The GitHub App is installed at *space* level, so it can cover an entire org. Without this
-- table any project in the space could dispatch against any repository in that org: the
-- broker checks that a run's requested host matches its task, but nothing constrains which
-- repos a project is entitled to. This makes that entitlement explicit and enforceable.
--
-- `task_specs.repo_id` is a foreign key into this table rather than free text, so an
-- unauthorised repository is not merely rejected — it cannot be recorded in the first place.

CREATE TABLE "runner"."project_repos" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "client_space_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    -- The installation this repo is reached through. Text, because it is GitHub's id and we
    -- neither mint nor own it.
    "installation_ref" text NOT NULL,
    "owner" text NOT NULL,
    "repo" text NOT NULL,
    -- Cached so dispatch does not need a GitHub round trip to learn the default branch.
    "default_branch" text,
    "added_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
    "added_at" timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT "project_repos_project_repo_uniq" UNIQUE ("project_id", "owner", "repo"),
    -- The composite reference is the point: a row cannot claim a project and a space that
    -- do not actually belong together. Copied from public.project_members, which solves the
    -- same problem the same way.
    CONSTRAINT "project_repos_project_space_fkey"
        FOREIGN KEY ("project_id", "client_space_id")
        REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE
);

CREATE INDEX "project_repos_project_idx" ON "runner"."project_repos" ("project_id");

--------------------------------------------------------------------------------
-- integrations — what is connected, at whichever level it is connected
--------------------------------------------------------------------------------
-- One row per connected thing, and the row the UI renders. `project_id IS NULL` means the
-- integration serves every project in the space, which is how a harness seat and a GitHub
-- installation are shared; MCP servers and skills are per project.
--
-- The scope rule is a CHECK rather than a convention because it is exactly the kind of
-- invariant that holds until one code path forgets it.

CREATE TABLE "runner"."integrations" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "client_space_id" uuid NOT NULL,
    "project_id" uuid,
    "kind" text NOT NULL,
    -- Server id, installation id, harness id, skill id. Namespaced by `kind`.
    "ref" text NOT NULL,
    "display_name" text NOT NULL,
    -- Non-secret configuration: a skill's settings, a server's URL, a harness's model
    -- override. Anything secret belongs in runner.credentials, never here.
    "settings" jsonb DEFAULT '{}'::jsonb NOT NULL,
    -- So the UI can say "Linear needs reconnecting" instead of a run failing obscurely.
    "status" text DEFAULT 'connected' NOT NULL,
    "connected_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
    "connected_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,

    CONSTRAINT "integrations_kind_check"
        CHECK ("kind" IN ('mcp', 'github', 'harness', 'skill')),
    CONSTRAINT "integrations_status_check"
        CHECK ("status" IN ('connected', 'needs_reauth', 'revoked')),
    -- A GitHub installation is space-wide and cannot be scoped to a project (per-project
    -- repository scoping is runner.project_repos). A harness is space-wide but may be
    -- overridden for one project. MCP servers and skills are always per project.
    CONSTRAINT "integrations_scope_matches_kind" CHECK (
        CASE "kind"
            WHEN 'github'  THEN "project_id" IS NULL
            WHEN 'harness' THEN true
            WHEN 'mcp'     THEN "project_id" IS NOT NULL
            WHEN 'skill'   THEN "project_id" IS NOT NULL
        END
    ),
    CONSTRAINT "integrations_space_fkey"
        FOREIGN KEY ("client_space_id")
        REFERENCES "public"."client_spaces"("id") ON DELETE CASCADE,
    -- MATCH SIMPLE, so a NULL project_id skips this check entirely — which is what a
    -- space-level row wants, while a project-level row is still forced to agree.
    CONSTRAINT "integrations_project_space_fkey"
        FOREIGN KEY ("project_id", "client_space_id")
        REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE
);

-- Two partial indexes, because "one per space" and "one per project" are different keys and
-- a single unique constraint over a nullable column would enforce neither.
CREATE UNIQUE INDEX "integrations_space_uniq"
    ON "runner"."integrations" ("client_space_id", "kind", "ref")
    WHERE "project_id" IS NULL;
CREATE UNIQUE INDEX "integrations_project_uniq"
    ON "runner"."integrations" ("project_id", "kind", "ref")
    WHERE "project_id" IS NOT NULL;

CREATE INDEX "integrations_space_kind_idx"
    ON "runner"."integrations" ("client_space_id", "kind");

--------------------------------------------------------------------------------
-- credentials — the secret material, and nothing else
--------------------------------------------------------------------------------
-- Split from `integrations` so the two have different reachability: the UI selects freely
-- from integrations and can never touch ciphertext, because this table has RLS enabled and
-- no policies at all.
--
-- Envelope-encrypted with KMS rather than stored in plaintext, and rather than held in
-- Secrets Manager. Encryption at rest protects against a stolen disk, not against a database
-- dump, a leaked connection string, or SQL injection — the ciphertext here is useless without
-- a KMS decrypt, which is IAM-scoped and CloudTrail-audited. Secrets Manager would be the
-- obvious alternative but bills per secret per month, which does not survive one row per
-- project per integration, and cannot be updated in the same transaction as the row pointing
-- at it — which matters because a refresh-token rotation is exactly a read-modify-write.
--
-- Not every integration has a row here. A GitHub installation id is not secret and the App's
-- private key lives in Secrets Manager, so the key mints repository-scoped tokens on demand;
-- a skill is configuration. Only MCP tokens and harness seats need storing.

CREATE TABLE "runner"."credentials" (
    "integration_id" uuid PRIMARY KEY
        REFERENCES "runner"."integrations"("id") ON DELETE CASCADE,
    "ciphertext" bytea NOT NULL,
    -- The data key, itself encrypted by the customer master key.
    "wrapped_key" bytea NOT NULL,
    -- Which CMK wrapped it, so a key rotation can find what still needs re-wrapping.
    "key_arn" text NOT NULL,
    -- Access-token expiry. NULL means long-lived, which is the case for a harness seat.
    "expires_at" timestamptz,
    -- Refresh before this, not on expiry: a token that dies mid-push fails the push, and a
    -- run forty minutes in has no way to recover it.
    "refresh_after" timestamptz,
    "rotated_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "credentials_refresh_idx"
    ON "runner"."credentials" ("refresh_after")
    WHERE "refresh_after" IS NOT NULL;

--------------------------------------------------------------------------------
-- task_specs — the runner's fields on a product task
--------------------------------------------------------------------------------
-- `public.tasks` stays the dispatchable entity; this is its 1:1 extension. Six nullable
-- columns on their table would be NULL for every ingest-generated row, and "is this
-- runnable?" would become a six-way null check. Here the predicate is simply whether a spec
-- row exists.
--
-- Tenancy is inherited through `task_id`: a policy that joins to public.tasks is filtered by
-- their policy, so there is no denormalised copy of client_space_id to drift.

CREATE TABLE "runner"."task_specs" (
    "task_id" uuid PRIMARY KEY
        REFERENCES "public"."tasks"("id") ON DELETE CASCADE,
    "repo_id" uuid NOT NULL
        REFERENCES "runner"."project_repos"("id") ON DELETE RESTRICT,
    "base_branch" text NOT NULL,
    "harness" text NOT NULL,
    "acceptance_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "details" text,
    "mcp_server_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "created_by" uuid REFERENCES "public"."users"("id") ON DELETE SET NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL
);

CREATE INDEX "task_specs_repo_idx" ON "runner"."task_specs" ("repo_id");

--------------------------------------------------------------------------------
-- runs — one attempt at a task
--------------------------------------------------------------------------------
-- A task may be attempted more than once, so run state is here rather than on the task. It
-- also means the product's coarse task_status (pending / in_progress / done / dismissed /
-- snoozed) stays truthful without needing new enum values — every partial index on
-- public.tasks filters on that enum, so adding to it would silently drop agent tasks off
-- their board.

CREATE TABLE "runner"."runs" (
    "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
    "task_id" uuid NOT NULL REFERENCES "public"."tasks"("id") ON DELETE CASCADE,
    "client_space_id" uuid NOT NULL,
    "project_id" uuid NOT NULL,
    "status" text NOT NULL,
    "harness" text NOT NULL,
    "branch" text NOT NULL,
    "started_at" timestamptz DEFAULT now() NOT NULL,
    "ended_at" timestamptz,
    -- Highest sequence number stored for this run: the gate that makes event append
    -- idempotent under replay. -1 rather than 0, because seq 0 is a real event.
    "seq_hwm" integer DEFAULT -1 NOT NULL,
    "records" jsonb DEFAULT '[]'::jsonb NOT NULL,
    "pr_url" text,
    "failure_reason" text,
    -- Container name locally, task ARN on Fargate.
    "handle" text,

    CONSTRAINT "runs_project_space_fkey"
        FOREIGN KEY ("project_id", "client_space_id")
        REFERENCES "public"."projects"("id", "client_space_id") ON DELETE CASCADE
);

CREATE INDEX "runs_task_idx" ON "runner"."runs" ("task_id");
CREATE INDEX "runs_project_idx" ON "runner"."runs" ("project_id");
-- The reconciler looks a run up by handle on every ECS task-state-change event.
CREATE INDEX "runs_handle_idx" ON "runner"."runs" ("handle");
-- And its sweep filters on exactly this.
CREATE INDEX "runs_status_idx" ON "runner"."runs" ("status");

--------------------------------------------------------------------------------
-- run_events — the append-only log
--------------------------------------------------------------------------------
-- No denormalised tenancy columns. The policy reaches tenancy through `runs`, and because
-- RLS applies to every table a query touches — including inside a policy's own subquery —
-- runs' policy filters it automatically. One less pair of columns that could disagree with
-- their parent.
--
-- Inserts come from the broker as the service role, which bypasses RLS, so the subquery costs
-- nothing on the write path.

CREATE TABLE "runner"."run_events" (
    "run_id" uuid NOT NULL REFERENCES "runner"."runs"("id") ON DELETE CASCADE,
    "seq" integer NOT NULL,
    "ts" timestamptz NOT NULL,
    "type" text NOT NULL,
    "stage" text,
    -- The whole canonical event, so the log replays without reconstructing it.
    "body" jsonb NOT NULL,
    -- Insertion order, independent of seq: a replay after a reconnect inserts older seqs
    -- after newer ones, and "what arrived when" cannot be answered from seq.
    "received_at" timestamptz DEFAULT now() NOT NULL,

    -- (run, seq) is the natural key, and making it the primary key is what lets
    -- ON CONFLICT DO NOTHING absorb a replay without reading first.
    CONSTRAINT "run_events_pkey" PRIMARY KEY ("run_id", "seq")
);

--------------------------------------------------------------------------------
-- run_tokens — a run's own bearer, hashed
--------------------------------------------------------------------------------
-- Durable because the in-memory registry this replaces cannot survive a second instance: a
-- token minted by one control-plane process is unverifiable by another, so behind a load
-- balancer roughly half of a container's broker calls would fail. That is the kind of fault
-- that appears only under the configuration you deploy, which is why it is a table now
-- rather than after the first outage.
--
-- Only the fingerprint is stored, so a database dump does not yield working tokens.

CREATE TABLE "runner"."run_tokens" (
    -- sha256 of the token, hex. Never the token itself.
    "fingerprint" text PRIMARY KEY NOT NULL,
    "run_id" uuid NOT NULL REFERENCES "runner"."runs"("id") ON DELETE CASCADE,
    "issued_at" timestamptz DEFAULT now() NOT NULL,
    "expires_at" timestamptz NOT NULL,
    -- Set the moment the run settles, so a leaked token outlives its run by nothing.
    "revoked_at" timestamptz
);

CREATE INDEX "run_tokens_run_idx" ON "runner"."run_tokens" ("run_id");

--------------------------------------------------------------------------------
-- Row-level security
--------------------------------------------------------------------------------
-- Enabled on every table. Where a table has no policy, that is deliberate and means no JWT
-- can reach it at all.

ALTER TABLE "runner"."project_repos" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."integrations"  ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."credentials"   ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."task_specs"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."runs"          ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."run_events"    ENABLE ROW LEVEL SECURITY;
ALTER TABLE "runner"."run_tokens"    ENABLE ROW LEVEL SECURITY;

-- Grants come before policies matter: RLS filters rows, but a missing GRANT denies the table
-- outright. Explicit per table rather than ALL TABLES IN SCHEMA, so a table added later does
-- not silently inherit access.
GRANT SELECT, INSERT, UPDATE, DELETE ON "runner"."project_repos" TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "runner"."integrations"  TO "authenticated";
GRANT SELECT, INSERT, UPDATE, DELETE ON "runner"."task_specs"    TO "authenticated";
GRANT SELECT                         ON "runner"."runs"          TO "authenticated";
GRANT SELECT                         ON "runner"."run_events"    TO "authenticated";

-- Never reachable with a user's JWT, belt and braces alongside having no policies.
REVOKE ALL ON "runner"."credentials" FROM "authenticated", "anon";
REVOKE ALL ON "runner"."run_tokens"  FROM "authenticated", "anon";

GRANT ALL ON ALL TABLES IN SCHEMA "runner" TO "service_role";

-- project_repos ---------------------------------------------------------------
-- Reading a project's repositories needs project access; changing the list is a space-admin
-- act, because it decides what agent runs are able to touch.

CREATE POLICY "project_repos_select" ON "runner"."project_repos"
    FOR SELECT TO "authenticated"
    USING ("project_id" IN (SELECT "public"."current_project_ids"()));

CREATE POLICY "project_repos_write" ON "runner"."project_repos"
    TO "authenticated"
    USING ("client_space_id" IN (SELECT "public"."manageable_client_space_ids"()))
    WITH CHECK ("client_space_id" IN (SELECT "public"."manageable_client_space_ids"()));

-- integrations ----------------------------------------------------------------
-- Read mirrors public.tasks_select exactly: in one of my spaces, and either space-wide or in
-- a project I can see.

CREATE POLICY "integrations_select" ON "runner"."integrations"
    FOR SELECT TO "authenticated"
    USING (
        "client_space_id" IN (SELECT "public"."current_client_space_ids"())
        AND ("project_id" IS NULL OR "project_id" IN (SELECT "public"."current_project_ids"()))
    );

-- Writes are split by scope, and the split is the whole point: a project member may connect
-- an MCP server to their own project but must not be able to touch the space's shared harness
-- seat or its GitHub installation. Permissive policies OR together, so each row is governed by
-- whichever of these two matches its shape.

CREATE POLICY "integrations_write_space" ON "runner"."integrations"
    TO "authenticated"
    USING (
        "project_id" IS NULL
        AND "client_space_id" IN (SELECT "public"."manageable_client_space_ids"())
    )
    WITH CHECK (
        "project_id" IS NULL
        AND "client_space_id" IN (SELECT "public"."manageable_client_space_ids"())
    );

CREATE POLICY "integrations_write_project" ON "runner"."integrations"
    TO "authenticated"
    USING (
        "project_id" IS NOT NULL
        AND "project_id" IN (SELECT "public"."manageable_project_ids"())
    )
    WITH CHECK (
        "project_id" IS NOT NULL
        AND "project_id" IN (SELECT "public"."manageable_project_ids"())
    );

-- task_specs ------------------------------------------------------------------
-- Tenancy through the task. The subquery is filtered by public.tasks' own policy, so this
-- says "a task I can see" without restating what that means.

CREATE POLICY "task_specs_select" ON "runner"."task_specs"
    FOR SELECT TO "authenticated"
    USING ("task_id" IN (SELECT "id" FROM "public"."tasks"));

-- Creating runnable work is a manage-level act, and the repository must belong to the same
-- project as the task — the check that stops a task in project A from targeting project B's
-- repository.
CREATE POLICY "task_specs_write" ON "runner"."task_specs"
    TO "authenticated"
    USING (
        EXISTS (
            SELECT 1 FROM "public"."tasks" t
            WHERE t."id" = "task_specs"."task_id"
              AND t."project_id" IN (SELECT "public"."manageable_project_ids"())
        )
    )
    WITH CHECK (
        EXISTS (
            SELECT 1 FROM "public"."tasks" t
            JOIN "runner"."project_repos" pr ON pr."id" = "task_specs"."repo_id"
            WHERE t."id" = "task_specs"."task_id"
              AND t."project_id" IN (SELECT "public"."manageable_project_ids"())
              AND pr."project_id" = t."project_id"
        )
    );

-- runs and run_events ---------------------------------------------------------
-- Read-only to people. Runs are created and advanced by the control plane as the service
-- role; a user dispatches through an endpoint, never by inserting a row.

CREATE POLICY "runs_select" ON "runner"."runs"
    FOR SELECT TO "authenticated"
    USING ("project_id" IN (SELECT "public"."current_project_ids"()));

CREATE POLICY "run_events_select" ON "runner"."run_events"
    FOR SELECT TO "authenticated"
    USING ("run_id" IN (SELECT "id" FROM "runner"."runs"));
