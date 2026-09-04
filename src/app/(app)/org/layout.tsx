import { createClient } from "@/lib/supabase/server";
import { WorkspaceSidebar } from "@/components/dashboard/workspace-sidebar";

/**
 * The organisation screen sits at the TOP LEVEL, not under /w/:workspaceId,
 * and it needs its own layout to explain why.
 *
 * It was nested for a while, because w/[workspaceId]/layout.tsx is where the
 * sidebar and the page padding come from and a bare route looked like a
 * different application. That turned out to strand exactly the person the
 * screen exists for: someone invited to the organisation ALONE — a billing
 * admin — has a tenant_members row and no workspace, so /w/:workspaceId/org
 * had no id to resolve. They landed on /, which redirected to /onboarding,
 * where they created a SECOND organisation and orphaned the membership they
 * had just accepted.
 *
 * So the shell is reproduced here instead, with the sidebar told there may be
 * no workspace at all.
 */
export default async function OrgLayout({ children }: { children: React.ReactNode }) {
  const supabase = await createClient();

  // Both come back empty for a tenant-only member, which is the point.
  const [{ data: workspaces }, { data: projects }] = await Promise.all([
    supabase.from("workspaces").select("id, name").order("created_at", { ascending: true }),
    supabase.from("projects").select("id, name").order("created_at", { ascending: false }),
  ]);

  const current = workspaces?.[0] ?? null;

  return (
    <div className="flex min-h-screen flex-col md:flex-row">
      <WorkspaceSidebar
        workspaceId={current?.id ?? null}
        current={current}
        workspaces={workspaces ?? []}
        projects={current ? (projects ?? []) : []}
      />
      <div className="min-h-screen flex-1 bg-muted p-6">{children}</div>
    </div>
  );
}
