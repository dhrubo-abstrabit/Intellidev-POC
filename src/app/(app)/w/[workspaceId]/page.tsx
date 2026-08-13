import Link from "next/link";
import { CreateProjectForm } from "@/components/dashboard/create-project-form";
import { createClient } from "@/lib/supabase/server";

const STATUS_STYLE: Record<string, string> = {
  active: "bg-brand-success/10 text-brand-success",
  paused: "bg-brand-warning/10 text-brand-warning",
  archived: "bg-brand-n-200 text-brand-n-600",
};

export default async function WorkspaceHomePage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const supabase = await createClient();

  const { data: projects } = await supabase
    .from("projects")
    .select("id, name, description, status, created_at")
    .eq("workspace_id", workspaceId)
    .order("created_at", { ascending: false });

  return (
    <div className="mx-auto max-w-4xl space-y-10">
      <section>
        <h1 className="mb-5 text-xl font-extrabold text-brand-n-900">
          Projects
        </h1>
        {!projects || projects.length === 0 ? (
          <div className="rounded-2xl border border-dashed border-brand-n-300 bg-brand-n-0 p-8 text-center text-sm text-brand-n-500">
            No projects yet — create your first one below.
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {projects.map((project) => (
              <Link key={project.id} href={`/w/${workspaceId}/p/${project.id}`}>
                <div className="h-full rounded-2xl border border-brand-n-200 bg-brand-n-0 p-5 shadow-sm transition-colors hover:border-brand-teal-400">
                  <div className="mb-2 flex items-start justify-between gap-2">
                    <h2 className="font-bold text-brand-n-900">
                      {project.name}
                    </h2>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-semibold capitalize ${STATUS_STYLE[project.status] ?? "bg-brand-n-200 text-brand-n-600"}`}
                    >
                      {project.status}
                    </span>
                  </div>
                  {project.description ? <p className="text-sm text-brand-n-600">{project.description}</p> : null}
                </div>
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <div className="rounded-2xl border border-brand-n-200 bg-brand-n-0 p-6 shadow-sm">
          <h2 className="mb-4 text-base font-bold text-brand-n-900">
            New project
          </h2>
          <CreateProjectForm workspaceId={workspaceId} />
        </div>
      </section>
    </div>
  );
}
