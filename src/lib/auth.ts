import "server-only";
import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export interface AuthedUser {
  id: string;
  email: string | undefined;
}

/**
 * Returns the current user, or null if there isn't one. Use in places that
 * render differently for signed-in vs. signed-out (e.g. the root page).
 */
export async function getUser(): Promise<AuthedUser | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();
  if (error || !data?.claims) return null;
  return { id: data.claims.sub, email: data.claims.email as string | undefined };
}

/**
 * Returns the current user or redirects to /login. Call this at the top of
 * every Server Action and every Server Component under a protected route —
 * proxy.ts refreshes sessions and redirects page navigations, but it does
 * NOT protect Server Actions (they're POSTs to whatever route rendered
 * them, not separate routes proxy can gate by path). This is the real
 * enforcement point.
 */
export async function requireUser(): Promise<AuthedUser> {
  const user = await getUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

/**
 * Throws unless the current user is a member of `workspaceId` AND
 * `projectId` belongs to it — checked via the user-scoped Supabase client,
 * so RLS's `is_workspace_member`-gated `projects` select policy IS the
 * membership check (there's no separate authorization query to keep in
 * sync). Membership only, not a role check — callers that need owner/admin
 * rely on RLS write policies (e.g. `integrations_update_admin`) to enforce
 * that, the same boundary `integrations/actions.ts` already used before
 * this was extracted here for reuse across integrations/ and settings/.
 */
export async function assertProjectMembership(workspaceId: string, projectId: string): Promise<void> {
  const supabase = await createClient();
  const { data: project } = await supabase
    .from("projects")
    .select("id")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  if (!project) {
    throw new Error("Not a member of this workspace, or project not found.");
  }
}
