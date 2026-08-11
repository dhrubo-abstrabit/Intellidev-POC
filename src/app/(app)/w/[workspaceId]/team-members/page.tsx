import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { TeamMembersView } from "@/app/(app)/w/[workspaceId]/team-members/team-members-view";

const MANAGE_ROLES = new Set(["owner", "admin"]);

export default async function TeamMembersPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await requireUser();
  const supabase = await createClient();

  // canManage is UI-only show/hide for the Add/Edit/Remove controls — the
  // real boundary is the team_members_write_admin RLS policy, which a
  // direct write attempt still has to pass regardless of what this renders.
  const [{ data: members }, { data: membership }] = await Promise.all([
    supabase.from("team_members").select("*").eq("workspace_id", workspaceId).order("name", { ascending: true }),
    supabase.from("workspace_members").select("role").eq("workspace_id", workspaceId).eq("user_id", user.id).maybeSingle(),
  ]);

  const canManage = MANAGE_ROLES.has(membership?.role ?? "");

  return <TeamMembersView workspaceId={workspaceId} members={members ?? []} canManage={canManage} />;
}
