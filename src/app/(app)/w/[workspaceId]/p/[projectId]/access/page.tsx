import { notFound } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { assertProjectScope } from "@/lib/scope";
import { createClient } from "@/lib/supabase/server";
import { MembersView, type MemberRow, type AssignableRole } from "@/components/dashboard/members-view";
import { InvitationsPanel, type PendingInvite, type InviteRole } from "@/components/dashboard/invitations-panel";
import { changeSpaceMemberRole, removeSpaceMember } from "./actions";

/**
 * Access for one client space — the data boundary.
 *
 * Lives under the project route because this app provisions exactly one client
 * space per project (see src/lib/scope.ts), so "this project's access" and
 * "this space's access" are the same question from the user's side. The writes
 * underneath are space-scoped, which is what actually governs the data.
 */
export default async function AccessPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const user = await requireUser();
  const scope = await assertProjectScope(workspaceId, projectId);
  const spaceId = scope.clientSpaceId;

  const supabase = await createClient();

  const [{ data: memberRows }, { data: assignable }, { data: roleCatalog }, { data: inviteRows }] =
    await Promise.all([
      supabase
        .from("space_members")
        // FK-hinted: space_members reaches users twice (user_id, invited_by).
        .select("user_id, role, users!space_members_user_id_fkey(email, full_name)")
        .eq("client_space_id", spaceId)
        .order("joined_at", { ascending: true }),
      supabase.rpc("assignable_roles", { p_scope_level: "space", p_scope_id: spaceId }),
      supabase.from("roles").select("key, label").eq("scope_level", "space"),
      // Via RPC so Postgres decides what has expired — its clock is the one
      // accept_invitation() compares against. SECURITY INVOKER, so the
      // invitations_select policy still gates who sees anything at all.
      supabase.rpc("pending_invitations", { p_scope_level: "space", p_scope_id: spaceId }),
    ]);

  if (!memberRows) notFound();

  const roleLabels = Object.fromEntries((roleCatalog ?? []).map((r) => [r.key, r.label]));

  const members: MemberRow[] = memberRows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    email: row.users?.email ?? "—",
    fullName: row.users?.full_name ?? null,
  }));

  const assignableRoles: AssignableRole[] = (assignable ?? []).map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
  }));

  const inviteRoles: InviteRole[] = assignableRoles.map((r) => ({ key: r.key, label: r.label }));

  const invites: PendingInvite[] = (inviteRows ?? []).map((row) => ({
    id: row.id,
    email: row.email,
    roleLabel: row.role_label,
    invitedBy: row.invited_by,
    expiresAt: row.expires_at,
    expired: row.expired,
  }));

  return (
    <div className="space-y-6">
      <MembersView
        title="Client space access"
        description="Who can read this client's activity, tasks and documents. A viewer can read everything here and change nothing."
        members={members}
        assignableRoles={assignableRoles}
        currentUserId={user.id}
        roleLabels={roleLabels}
        // .bind(null, spaceId) — not an arrow wrapper. See MembersView's prop docs.
        changeRoleAction={changeSpaceMemberRole.bind(null, spaceId)}
        removeAction={removeSpaceMember.bind(null, spaceId)}
        removeDescriptionTemplate="{email} loses access to this client space and every project inside it. Their workspace and organisation membership are unaffected."
      />
      <InvitationsPanel level="space" scopeId={spaceId} invites={invites} roles={inviteRoles} />
    </div>
  );
}
