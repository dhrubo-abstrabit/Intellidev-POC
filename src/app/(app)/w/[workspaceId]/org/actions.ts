"use server";

import { revalidatePath } from "next/cache";
import { requireUser } from "@/lib/auth";
import { requirePermission, tenantScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import type { Json } from "@/lib/db/database.types";

async function recordAudit(
  tenantId: string,
  actorUserId: string,
  action: string,
  targetUserId: string,
  metadata: Json,
): Promise<void> {
  const service = createServiceClient();
  await service.from("audit_logs").insert([
    {
      tenant_id: tenantId,
      actor_user_id: actorUserId,
      actor_type: "user",
      action,
      target_type: "tenant_member",
      target_id: targetUserId,
      metadata,
    },
  ]);
}

export async function changeTenantMemberRole(
  tenantId: string,
  targetUserId: string,
  role: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", tenantScope(tenantId));

  const supabase = await createClient();

  const { data: allowed } = await supabase.rpc("assignable_roles", {
    p_scope_level: "tenant",
    p_scope_id: tenantId,
  });
  if (!allowed?.some((r) => r.key === role)) {
    throw new Error("You cannot assign that role.");
  }

  const { data: row, error } = await supabase
    .from("tenant_members")
    .update({ role })
    .eq("tenant_id", tenantId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  // guard_last_tenant_owner raises this rather than letting the last owner
  // demote themselves and orphan the organisation.
  if (error?.message.includes("must keep at least one owner")) {
    throw new Error("This organisation must keep at least one owner.");
  }
  if (error || !row) {
    throw new Error("Could not change this member's role.");
  }

  await recordAudit(tenantId, user.id, "tenant_member.role_changed", targetUserId, { new_role: role });
  revalidatePath("/", "layout");
  return { message: "Role updated." };
}

/**
 * Removes someone from the organisation entirely.
 *
 * This is the destructive one, and the only offboarding action that actually
 * finishes the job: tenant_members is the FK target for workspace_members and
 * space_members, so deleting this row cascades every workspace, client space
 * and project membership beneath it. Removing someone from a single workspace
 * or space deliberately does NOT do this — losing one engagement is not the
 * same as leaving the company.
 *
 * It also frees a seat, which is why the seat cap counts this table.
 */
export async function removeTenantMember(
  tenantId: string,
  targetUserId: string,
): Promise<{ message: string }> {
  const user = await requireUser();
  await requirePermission("member.manage", tenantScope(tenantId));

  if (targetUserId === user.id) {
    throw new Error("You cannot remove yourself from the organisation.");
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("tenant_members")
    .delete()
    .eq("tenant_id", tenantId)
    .eq("user_id", targetUserId)
    .select("user_id")
    .maybeSingle();

  if (error?.message.includes("must keep at least one owner")) {
    throw new Error("This organisation must keep at least one owner.");
  }
  if (error || !row) {
    throw new Error("Could not remove this member.");
  }

  await recordAudit(tenantId, user.id, "tenant_member.removed", targetUserId, {});
  revalidatePath("/", "layout");
  return { message: "Removed from the organisation." };
}
