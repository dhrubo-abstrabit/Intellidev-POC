import { notFound } from "next/navigation";
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
      <h1 className="text-lg font-semibold">{project.name}</h1>
      {children}
    </div>
  );
}
