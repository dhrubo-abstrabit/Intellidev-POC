import "server-only";
import { createClient } from "@/lib/supabase/server";

/**
 * Resolved identity of a `/w/:workspaceId/p/:projectId` URL under the
 * 4-level schema (tenant -> workspace -> client_space -> project). A project
 * does not own most of its data directly — space_connections, events,
 * llm_runs, daily_summaries all key on `client_space_id` (see
 * supabase/migrations/20260901000500_client_spaces.sql and
 * 20260901000600_projects.sql) — so pages/actions that filter those tables
 * need the project's client_space_id, not project_id. `timezone` and
 * `tenant_id` both live on `client_spaces`, not on `projects`.
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
  tenantId: string;
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
    .select("id, workspace_id, client_space_id, client_spaces(timezone, tenant_id)")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  // client_space_id is NOT NULL on projects and FK-guarantees a client_spaces
  // row exists, so a missing embed here means something is actually wrong —
  // fail scope resolution rather than fabricate a scope with no real tenant.
  if (!data || !data.client_spaces) return null;

  return {
    workspaceId: data.workspace_id,
    projectId: data.id,
    clientSpaceId: data.client_space_id,
    tenantId: data.client_spaces.tenant_id,
    timezone: data.client_spaces.timezone,
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
