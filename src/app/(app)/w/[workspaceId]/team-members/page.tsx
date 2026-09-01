import { requireUser } from "@/lib/auth";
import { can, workspaceScope } from "@/lib/authz";
import { createClient } from "@/lib/supabase/server";
import { TeamMembersView } from "@/app/(app)/w/[workspaceId]/team-members/team-members-view";

export default async function TeamMembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  await requireUser();
  const supabase = await createClient();

  // canManage is UI-only show/hide for the Add/Edit/Remove controls — the
  // real boundary is the team_members_write RLS policy (contact.manage),
  // which a direct write attempt still has to pass regardless of what this
  // renders.
  //
  // This replaced a hard-coded `MANAGE_ROLES = new Set(["owner", "admin"])`
  // compared against the raw workspace_members.role. That set was wrong in a
  // way nothing could catch: "owner" is not a workspace role at all (the
  // workspace vocabulary is admin/member/viewer), so the check only ever
  // matched on "admin" and the extra entry was silently dead. Asking for the
  // permission instead means the question stays correct when the role
  // vocabulary changes.
  const [{ data: members }, canManage] = await Promise.all([
    supabase.from("team_members").select("*").eq("workspace_id", workspaceId).order("name", { ascending: true }),
    can("contact.manage", workspaceScope(workspaceId)),
  ]);

  return <TeamMembersView workspaceId={workspaceId} members={members ?? []} canManage={canManage} />;
}
