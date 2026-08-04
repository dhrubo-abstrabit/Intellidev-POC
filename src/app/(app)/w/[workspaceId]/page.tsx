import Link from "next/link";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { CreateProjectForm } from "@/components/dashboard/create-project-form";
import { createClient } from "@/lib/supabase/server";

export default async function WorkspaceHomePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const supabase = await createClient();

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, description, status, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      <section>
        <h1 className="mb-4 text-lg font-semibold">Projects</h1>
        {!projects || projects.length === 0 ? (
          <p className="text-sm text-muted-foreground">No projects yet — create your first one below.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <Link key={project.id} href={`/w/${workspaceId}/p/${project.id}`}>
                <Card className="transition-colors hover:border-foreground/30">
                  <CardHeader>
                    <CardTitle className="text-base">{project.name}</CardTitle>
                    {project.description ? <CardDescription>{project.description}</CardDescription> : null}
                  </CardHeader>
                  <CardContent className="text-xs text-muted-foreground">Status: {project.status}</CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <Card>
          <CardHeader>
            <CardTitle className="text-base">New project</CardTitle>
          </CardHeader>
          <CardContent>
            <CreateProjectForm workspaceId={workspaceId} />
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
