import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";
import { AppHeader } from "@/components/dashboard/app-header";

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
      <AppHeader
        workspaceSwitcher={<WorkspaceSwitcher current={current} workspaces={allWorkspaces ?? []} />}
        nav={
          <>
            <Link href={`/w/${workspaceId}`} className="hover:text-brand-teal-600">
              Overview
            </Link>
            <Link href={`/w/${workspaceId}/team-members`} className="hover:text-brand-teal-600">
              Team Members
            </Link>
          </>
        }
      />
      <div className="min-h-[calc(100vh-3.25rem)] bg-brand-n-50 p-6">{children}</div>
    </div>
  );
}
