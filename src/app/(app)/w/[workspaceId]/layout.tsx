import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceSidebar } from "@/components/dashboard/workspace-sidebar";

export default async function WorkspaceLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string }>;
}) {
  const { workspaceId } = await params;
  const supabase = await createClient();

  // RLS scopes this to workspaces the current user is a member of, so a
  // workspaceId belonging to another tenant (or a typo'd UUID) legitimately
  // comes back empty rather than needing a separate ownership check here.
  const [{ data: allWorkspaces }, { data: current }, { data: projects }] = await Promise.all([
    supabase.from("workspaces").select("id, name").order("created_at", { ascending: true }),
    supabase.from("workspaces").select("id, name").eq("id", workspaceId).maybeSingle(),
    supabase.from("projects").select("id, name").eq("workspace_id", workspaceId).order("created_at", { ascending: false }),
  ]);

  if (!current) {
    notFound();
  }

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <WorkspaceSidebar workspaceId={workspaceId} current={current} workspaces={allWorkspaces ?? []} projects={projects ?? []} />
      <div className="min-h-screen flex-1 bg-muted p-6">{children}</div>
    </div>
  );
}
