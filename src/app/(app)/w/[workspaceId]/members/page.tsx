import { notFound } from "next/navigation";
import { requireUser, assertWorkspaceMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { MembersView, type MemberRow, type AssignableRole } from "@/components/dashboard/members-view";
import { InvitationsPanel, type PendingInvite, type InviteRole } from "@/components/dashboard/invitations-panel";
import { changeWorkspaceMemberRole, removeWorkspaceMember } from "./actions";

/**
 * Workspace membership and invitations.
 *
 * There is no role check anywhere in this file. Whether the viewer may manage
 * membership or invite is answered by `assignable_roles` coming back non-empty
 * — that RPC applies the permission check, the `assignable` flag and the rank
 * ceiling in one place, server-side. A hard-coded set like
 * team-members/page.tsx's old `MANAGE_ROLES` is exactly what this design
 * removes: that one listed "owner", which is not even a valid workspace role,
 * and nothing caught it because the string never had to match anything.
 */
export default async function MembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await requireUser();
  await assertWorkspaceMembership(workspaceId);

  const supabase = await createClient();

  const [{ data: memberRows }, { data: assignable }, { data: roleCatalog }, { data: inviteRows }] =
    await Promise.all([
      supabase
        .from("workspace_members")
        // Hinted with the FK name: workspace_members reaches users twice
        // (user_id and invited_by), so a bare `users(...)` embed is ambiguous.
        .select("user_id, role, joined_at, users!workspace_members_user_id_fkey(email, full_name)")
        .eq("workspace_id", workspaceId)
        .order("joined_at", { ascending: true }),
      supabase.rpc("assignable_roles", { p_scope_level: "workspace", p_scope_id: workspaceId }),
      // Labels for the read-only view. Read from the catalog rather than a
      // hard-coded map so a new role renders with its real name on day one.
      supabase.from("roles").select("key, label").eq("scope_level", "workspace"),
      // Via RPC so Postgres decides what has expired — its clock is the one
      // accept_invitation() compares against. SECURITY INVOKER, so the
      // invitations_select policy still gates who sees anything at all.
      supabase.rpc("pending_invitations", { p_scope_level: "workspace", p_scope_id: workspaceId }),
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
        title="Workspace members"
        description="People with access to this workspace. Admins manage client spaces, projects and people — they do not read client activity."
        members={members}
        assignableRoles={assignableRoles}
        currentUserId={user.id}
        roleLabels={roleLabels}
        changeRoleAction={changeWorkspaceMemberRole.bind(null, workspaceId)}
        removeAction={removeWorkspaceMember.bind(null, workspaceId)}
        removeDescriptionTemplate="{email} loses access to this workspace. They stay on the organisation roster and keep any client-space access granted separately."
      />
      <InvitationsPanel level="workspace" scopeId={workspaceId} invites={invites} roles={inviteRoles} />
    </div>
  );
}
