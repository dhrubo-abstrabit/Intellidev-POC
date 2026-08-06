import { notFound } from "next/navigation";
import Link from "next/link";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const supabase = await createClient();

  // RLS scopes `projects` to the caller's workspaces, so a projectId from
  // another tenant (or a mismatched workspaceId in the URL) comes back empty
  // rather than needing a separate ownership check.
  const { data: project } = await supabase
    .from("projects")
    .select("id, name")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  if (!project) {
    notFound();
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold">{project.name}</h1>
        <nav className="flex gap-4 text-sm text-muted-foreground">
          <Link href={`/w/${workspaceId}/p/${projectId}`} className="hover:text-foreground">
            Overview
          </Link>
          {/* <Link href={`/w/${workspaceId}/p/${projectId}/items`} className="hover:text-foreground">
            Action Items
          </Link> */}
          <Link href={`/w/${workspaceId}/p/${projectId}/data`} className="hover:text-foreground">
            Project Data
          </Link>
          <Link href={`/w/${workspaceId}/p/${projectId}/project-context`} className="hover:text-foreground">
            Project Context
          </Link>
          <Link href={`/w/${workspaceId}/p/${projectId}/task-management`} className="hover:text-foreground">
            Task Tracking
          </Link>
          {/* <Link href={`/w/${workspaceId}/p/${projectId}/activity`} className="hover:text-foreground">
            Activity
          </Link> */}
          <Link href={`/w/${workspaceId}/p/${projectId}/integrations`} className="hover:text-foreground">
            Integrations
          </Link>
        </nav>
      </div>
      {children}
    </div>
  );
}
