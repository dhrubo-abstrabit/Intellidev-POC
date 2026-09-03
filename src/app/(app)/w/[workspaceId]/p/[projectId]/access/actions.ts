"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { requirePermission, spaceScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/database.types";

/**
 * Client-space membership.
 *
 * This is the screen that matters most: the client space is the data boundary,
 * so a role here decides who reads a client's Slack, mail and files. The
 * workspace screen decides who can administer the shape of an engagement; this
 * one decides who can see inside it.
 *
 * Same three-check shape as the workspace actions — requirePermission for a
 * readable failure, assignable_roles so the database decides what may be
 * granted (rank ceiling included), and the sm_write RLS policy on the write
 * itself.
 */

async function recordAudit(
  clientSpaceId: string,
  actorUserId: string,
  action: string,
  targetUserId: string,
  metadata: Json,
): Promise<void> {
  const service = createServiceClient();
  const { data: space } = await service
    .from("client_spaces")
    .select("tenant_id, workspace_id")
    .eq("id", clientSpaceId)
    .maybeSingle();
  if (!space) return;

  // Best-effort, as elsewhere: an audit failure must not turn a completed role
  // change into a thrown action.
  await service.from("audit_logs").insert([
    {
      tenant_id: space.tenant_id,
      workspace_id: space.workspace_id,
      client_space_id: clientSpaceId,
      actor_user_id: actorUserId,
      actor_type: "user",
      action,
      target_type: "space_member",
      target_id: targetUserId,
      metadata,
    },
  ]);
}

export async function changeSpaceMemberRole(
  clientSpaceId: string,
  targetUserId: string,
  role: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", spaceScope(clientSpaceId));

  const supabase = await createClient();

  const { data: allowed } = await supabase.rpc("assignable_roles", {
    p_scope_level: "space",
    p_scope_id: clientSpaceId,
  });
  if (!allowed?.some((r) => r.key === role)) {
    throw new Error("You cannot assign that role.");
  }

  const { data: row, error } = await supabase
    .from("space_members")
    .update({ role })
    .eq("client_space_id", clientSpaceId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  if (error?.message.includes("must keep at least one admin")) {
    throw new Error("This client space must keep at least one admin.");
  }
  if (error || !row) {
    throw new Error("Could not change this member's role.");
  }

  await recordAudit(clientSpaceId, user.id, "space_member.role_changed", targetUserId, { new_role: role });
  revalidatePath("/", "layout");
  return { message: "Role updated." };
}

/**
 * Removes someone from the client space.
 *
 * Their project_members rows cascade away with it (project_members FKs to
 * space_members), which is the intended behaviour: project access without
 * standing in the space is not expressible by design. Their workspace and
 * tenant memberships are untouched — losing access to one client engagement
 * is not the same as leaving the company.
 */
export async function removeSpaceMember(
  clientSpaceId: string,
  targetUserId: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", spaceScope(clientSpaceId));

  const supabase = await createClient();
  // .select().maybeSingle() after the delete: RLS refusing it produces zero
  // affected rows and no error, so an unguarded delete would report a false
  // success to the caller's toast.
  const { data: row, error } = await supabase
    .from("space_members")
    .delete()
    .eq("client_space_id", clientSpaceId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  if (error?.message.includes("must keep at least one admin")) {
    throw new Error("This client space must keep at least one admin.");
  }
  if (error || !row) {
    throw new Error("Could not remove this member.");
  }

  await recordAudit(clientSpaceId, user.id, "space_member.removed", targetUserId, {});
  revalidatePath("/", "layout");
  return { message: "Member removed." };
}
