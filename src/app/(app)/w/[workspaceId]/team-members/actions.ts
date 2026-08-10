"use server";

import { revalidatePath } from "next/cache";
import { requireUser, assertWorkspaceMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { teamMemberSchema } from "@/lib/validation/team-members";

export interface TeamMemberActionResult {
  error?: string;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";

function parseTeamMemberForm(formData: FormData) {
  return teamMemberSchema.safeParse({
    name: formData.get("name"),
    email: formData.get("email"),
    role: formData.get("role") || undefined,
    description: formData.get("description") || undefined,
  });
}

/**
 * Membership-only guard (assertWorkspaceMembership), then a write through
 * the user-scoped client — the team_members_write_admin RLS policy is the
 * real owner/admin gate, not this action. Mirrors integrations/actions.ts's
 * requireUser() -> membership assert -> user-scoped write -> service-role
 * audit insert -> revalidatePath pattern.
 */
export async function createTeamMember(
  workspaceId: string,
  _prev: TeamMemberActionResult,
  formData: FormData,
): Promise<TeamMemberActionResult> {
  const user = await requireUser();
  await assertWorkspaceMembership(workspaceId);

  const parsed = parseTeamMemberForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("team_members")
    .insert({ workspace_id: workspaceId, created_by: user.id, ...parsed.data })
    .select("id")
    .single();

  if (error || !row) {
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      return { error: "A team member with this email already exists in this workspace." };
    }
    return { error: "Could not add this team member. Only workspace owners/admins can manage the roster." };
  }

  const service = createServiceClient();
  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "team_member.created",
    target_type: "team_member",
    target_id: row.id,
  });

  revalidatePath(`/w/${workspaceId}/team-members`);
  return {};
}

export async function updateTeamMember(
  workspaceId: string,
  teamMemberId: string,
  _prev: TeamMemberActionResult,
  formData: FormData,
): Promise<TeamMemberActionResult> {
  const user = await requireUser();
  await assertWorkspaceMembership(workspaceId);

  const parsed = parseTeamMemberForm(formData);
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("team_members")
    .update(parsed.data)
    .eq("id", teamMemberId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();

  if (error || !row) {
    if (error?.code === POSTGRES_UNIQUE_VIOLATION) {
      return { error: "A team member with this email already exists in this workspace." };
    }
    return { error: "Could not update this team member. Only workspace owners/admins can manage the roster." };
  }

  const service = createServiceClient();
  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "team_member.updated",
    target_type: "team_member",
    target_id: row.id,
  });

  revalidatePath(`/w/${workspaceId}/team-members`);
  return {};
}

/**
 * Throws on failure / returns {message} on success — the contract
 * ConfirmActionButton expects (see disconnectIntegration for the pattern
 * this mirrors).
 */
export async function deleteTeamMember(workspaceId: string, teamMemberId: string): Promise<{ message: string }> {
  const user = await requireUser();
  await assertWorkspaceMembership(workspaceId);

  const supabase = await createClient();
  // .select().maybeSingle() after the delete, not just checking `error`:
  // RLS denying the delete (non-admin) produces zero affected rows with no
  // Postgres error, so an unguarded `.delete()` would silently "succeed"
  // and report a false positive to ConfirmActionButton's toast.
  const { data: row, error } = await supabase
    .from("team_members")
    .delete()
    .eq("id", teamMemberId)
    .eq("workspace_id", workspaceId)
    .select("id")
    .maybeSingle();

  if (error || !row) {
    throw new Error("Could not remove this team member. Only workspace owners/admins can manage the roster.");
  }

  const service = createServiceClient();
  await service.from("audit_logs").insert({
    workspace_id: workspaceId,
    actor_user_id: user.id,
    actor_type: "user",
    action: "team_member.removed",
    target_type: "team_member",
    target_id: teamMemberId,
  });

  revalidatePath(`/w/${workspaceId}/team-members`);
  return { message: "Team member removed" };
}
