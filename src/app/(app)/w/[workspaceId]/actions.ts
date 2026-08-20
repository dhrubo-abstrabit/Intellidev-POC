"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createProjectSchema, slugify } from "@/lib/validation/workspace";

export interface CreateProjectResult {
  error?: string;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";
const MAX_SLUG_ATTEMPTS = 5;

export async function createProject(
  workspaceId: string,
  _prev: CreateProjectResult,
  formData: FormData,
): Promise<CreateProjectResult> {
  const user = await requireUser();

  const parsed = createProjectSchema.safeParse({
    name: formData.get("name"),
    description: formData.get("description") || undefined,
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const baseSlug = slugify(parsed.data.name);

  // A project cannot exist without a client space above it — projects.
  // client_space_id is NOT NULL, and its composite FK requires a real
  // client_spaces row already scoped to this workspace (see
  // supabase/migrations/20260820100600_client_spaces.sql /
  // 20260820100700_projects.sql). This app provisions exactly one client
  // space per project, created together and never surfaced in the UI — see
  // src/lib/scope.ts for the full rationale. Need the workspace's tenant_id
  // for the client space insert's own NOT NULL column.
  const { data: workspaceRow } = await supabase.from("workspaces").select("tenant_id").eq("id", workspaceId).maybeSingle();
  if (!workspaceRow) {
    return { error: "Could not create project. You may not have access to this workspace." };
  }

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

    // Inserted first, on the SAME slug the project below will use:
    // client_spaces' own unique(workspace_id, slug) is what actually needs
    // catching here — projects' equivalent constraint is scoped to
    // (client_space_id, slug), which can never collide under the 1:1
    // mapping (a brand-new client space has no other projects to collide
    // with).
    const { data: clientSpace, error: clientSpaceError } = await supabase
      .from("client_spaces")
      .insert({ workspace_id: workspaceId, tenant_id: workspaceRow.tenant_id, name: parsed.data.name, slug })
      .select("id")
      .single();

    if (clientSpaceError) {
      if (clientSpaceError.code !== POSTGRES_UNIQUE_VIOLATION) {
        // Most likely cause: the caller isn't an owner/admin of this
        // workspace, so client_spaces_insert's has_workspace_role check
        // failed and Postgres/PostgREST reported it as a generic RLS denial.
        return { error: "Could not create project. You may not have access to this workspace." };
      }
      continue; // slug collision, retry with a randomized suffix
    }

    const { data: project, error: projectError } = await supabase
      .from("projects")
      .insert({
        client_space_id: clientSpace.id,
        workspace_id: workspaceId,
        name: parsed.data.name,
        description: parsed.data.description,
        slug,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (projectError || !project) {
      return { error: "Could not create project. Please try again." };
    }

    const audit = createServiceClient();
    await audit.from("audit_logs").insert([
      {
        workspace_id: workspaceId,
        actor_user_id: user.id,
        actor_type: "user",
        action: "client_space.created",
        target_type: "client_space",
        target_id: clientSpace.id,
      },
      {
        workspace_id: workspaceId,
        client_space_id: clientSpace.id,
        project_id: project.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "project.created",
        target_type: "project",
        target_id: project.id,
      },
    ]);

    redirect(`/w/${workspaceId}`);
  }

  return { error: "Could not create a unique project URL. Please try a different name." };
}
