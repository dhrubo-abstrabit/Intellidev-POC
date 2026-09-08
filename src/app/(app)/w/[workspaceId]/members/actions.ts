"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { requirePermission, workspaceScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/database.types";

export interface MemberActionResult {
  error?: string;
}

/**
 * Writes an audit row for a membership change.
 *
 * Best-effort and deliberately not error-checked, matching the existing
 * audit calls in team-members/actions.ts: an audit failure must not turn a
 * completed role change into a thrown action. audit_logs.tenant_id is NOT
 * NULL, so the tenant is resolved first and the write skipped if it cannot be.
 */
async function recordMembershipAudit(
  workspaceId: string,
  actorUserId: string,
  action: string,
  targetUserId: string,
  metadata: Json,
): Promise<void> {
  const service = createServiceClient();
  const { data: workspace } = await service
    .from("workspaces")
    .select("tenant_id")
    .eq("id", workspaceId)
    .maybeSingle();
  if (!workspace) return;

  await service.from("audit_logs").insert([
    {
      tenant_id: workspace.tenant_id,
      workspace_id: workspaceId,
      actor_user_id: actorUserId,
      actor_type: "user",
      action,
      target_type: "workspace_member",
      target_id: targetUserId,
      metadata,
    },
  ]);
}

/**
 * Changes a workspace member's role.
 *
 * Three independent checks stand between a caller and this write, and all
 * three are load-bearing:
 *
 *   1. requirePermission — member.manage at this workspace, so the failure is
 *      a sentence rather than a silent zero-row update.
 *   2. assignable_roles — the DB decides which roles this caller may hand
 *      out, applying both the `assignable` flag and the rank ceiling that
 *      stops someone granting a role above their own. Validating against this
 *      list rather than a hard-coded array is what keeps a new role working
 *      here with no code change.
 *   3. The wm_write RLS policy on the update itself, which runs through the
 *      user-scoped client and would refuse the write even if the two checks
 *      above were somehow bypassed.
 *
 * The last-admin guard (guard_last_workspace_admin) is enforced by a trigger
 * and surfaces here as a Postgres error, which is translated below rather
 * than duplicated as an app-side count.
 */
export async function changeWorkspaceMemberRole(
  workspaceId: string,
  targetUserId: string,
  role: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", workspaceScope(workspaceId));

  const supabase = await createClient();

  const { data: allowed } = await supabase.rpc("assignable_roles", {
    p_scope_level: "workspace",
    p_scope_id: workspaceId,
  });
  if (!allowed?.some((r) => r.key === role)) {
    throw new Error("You cannot assign that role.");
  }

  const { data: row, error } = await supabase
    .from("workspace_members")
    .update({ role })
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  if (error) {
    // The trigger's message is the clearest explanation available; surface it
    // rather than a generic failure.
    if (error.message.includes("must keep at least one admin")) {
      throw new Error("This workspace must keep at least one admin.");
    }
    throw new Error("Could not change this member's role.");
  }
  if (!row) {
    throw new Error("Could not change this member's role.");
  }

  await recordMembershipAudit(workspaceId, user.id, "workspace_member.role_changed", targetUserId, {
    new_role: role,
  });

  revalidatePath(`/w/${workspaceId}/members`);
  return { message: "Role updated." };
}

/**
 * Removes someone from the workspace.
 *
 * Note what this does NOT do: it leaves their tenant_members row alone, so
 * they stay on the organisation roster and keep any client-space access
 * granted separately. Removing someone from the company is a tenant-level
 * action, and conflating the two here would make "remove from this workspace"
 * silently destroy access nobody asked to revoke.
 */
export async function removeWorkspaceMember(
  workspaceId: string,
  targetUserId: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", workspaceScope(workspaceId));

  const supabase = await createClient();
  // .select().maybeSingle() after the delete: RLS refusing it produces zero
  // affected rows and no Postgres error, so an unguarded .delete() would
  // report a false success to the caller's toast.
  const { data: row, error } = await supabase
    .from("workspace_members")
    .delete()
    .eq("workspace_id", workspaceId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  if (error?.message.includes("must keep at least one admin")) {
    throw new Error("This workspace must keep at least one admin.");
  }
  if (error || !row) {
    throw new Error("Could not remove this member.");
  }

  await recordMembershipAudit(workspaceId, user.id, "workspace_member.removed", targetUserId, {});

  revalidatePath(`/w/${workspaceId}/members`);
  return { message: "Member removed." };
}
