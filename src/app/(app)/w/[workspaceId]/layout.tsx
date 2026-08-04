import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";

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
  const [{ data: allWorkspaces }, { data: current }] = await Promise.all([
    supabase.from("workspaces").select("id, name").order("created_at", { ascending: true }),
    supabase.from("workspaces").select("id, name").eq("id", workspaceId).maybeSingle(),
  ]);

  if (!current) {
    notFound();
  }

  return (
    <div>
      <div className="border-b px-6 py-3">
        <WorkspaceSwitcher current={current} workspaces={allWorkspaces ?? []} />
      </div>
      <div className="p-6">{children}</div>
    </div>
  );
}
