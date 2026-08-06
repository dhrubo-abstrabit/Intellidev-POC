import { createClient } from "@/lib/supabase/server";
import { ContextForm } from "./context-form";

export default async function ProjectContextPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const supabase = await createClient();

  const { data: project } = await supabase
    .from("projects")
    .select("description")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Project Context</h1>
        <p className="text-sm text-muted-foreground">
          Background the AI reads when generating action items — goals, conventions, who&apos;s who, anything
          worth knowing about this project.
        </p>
      </div>

      <ContextForm workspaceId={workspaceId} projectId={projectId} initialValue={project?.description ?? ""} />
    </div>
  );
}
