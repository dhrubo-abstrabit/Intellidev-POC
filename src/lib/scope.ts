import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolved identity of a `/w/:workspaceId/p/:projectId` URL under the
 * 4-level schema (tenant -> workspace -> client_space -> project). A project
 * no longer owns its data directly — integrations, events, credentials,
 * llm_runs, daily_summaries all key on `client_space_id` (see
 * supabase/migrations/20260820100600_client_spaces.sql and
 * 20260820100700_projects.sql) — so every page/action that used to filter by
 * `project_id` on those tables needs the project's client_space_id instead.
 * `timezone` also moved off `projects` onto `client_spaces`.
 *
 * This app provisions exactly one client space per project (see
 * createProject in w/[workspaceId]/actions.ts), so resolving "the" client
 * space for a project is unambiguous today. That 1:1 mapping is an app-level
 * choice, not a schema guarantee — a future multi-project client space would
 * make this resolver ambiguous only if a *different* project's id were
 * passed in, which can't happen here since projectId always comes from the
 * URL segment this scope was resolved for.
 */
export interface ProjectScope {
  workspaceId: string;
  projectId: string;
  clientSpaceId: string;
  timezone: string;
}

/**
 * Resolves a project's full scope, or null if `projectId` doesn't exist or
 * doesn't belong to `workspaceId` — through the user-scoped client, so RLS's
 * `current_project_ids()`-gated `projects` select policy IS the membership
 * check (there's no separate authorization query to keep in sync), exactly
 * like the pairwise check this replaces used to reason about `workspace_id`.
 * Use in page/layout components, which want to render `notFound()` rather
 * than throw. Server Actions should use `assertProjectScope` below instead.
 */
export async function resolveProjectScope(workspaceId: string, projectId: string): Promise<ProjectScope | null> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("projects")
    .select("id, workspace_id, client_space_id, client_spaces(timezone)")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!data) return null;

  return {
    workspaceId: data.workspace_id,
    projectId: data.id,
    clientSpaceId: data.client_space_id,
    timezone: data.client_spaces?.timezone ?? "UTC",
  };
}

/**
 * Throws unless `projectId` exists and belongs to `workspaceId`, returning
 * its resolved scope on success. Replaces `assertProjectMembership` — every
 * former caller needed `clientSpaceId` for its own subsequent queries
 * anyway, so this does the membership check and the scope lookup in one
 * round trip instead of two. Membership only, not a role check — callers
 * that need owner/admin rely on RLS write policies (e.g.
 * `integrations_update_admin`) to enforce that, same boundary
 * `assertProjectMembership` used.
 */
export async function assertProjectScope(workspaceId: string, projectId: string): Promise<ProjectScope> {
  const scope = await resolveProjectScope(workspaceId, projectId);
  if (!scope) {
    throw new Error("Not a member of this workspace, or project not found.");
  }
  return scope;
}
