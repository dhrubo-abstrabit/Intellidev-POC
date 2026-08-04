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

  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

    const { data: project, error } = await supabase
      .from("projects")
      .insert({
        workspace_id: workspaceId,
        name: parsed.data.name,
        description: parsed.data.description,
        slug,
        created_by: user.id,
      })
      .select("id")
      .single();

    if (!error && project) {
      const audit = createServiceClient();
      await audit.from("audit_logs").insert({
        workspace_id: workspaceId,
        project_id: project.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "project.created",
        target_type: "project",
        target_id: project.id,
      });

      redirect(`/w/${workspaceId}`);
    }

    if (error?.code !== POSTGRES_UNIQUE_VIOLATION) {
      // Most likely cause: the caller isn't a member of this workspace, so
      // the `is_workspace_member(workspace_id)` check in the INSERT policy
      // failed and Postgres/PostgREST reported it as a generic RLS denial.
      return { error: "Could not create project. You may not have access to this workspace." };
    }
  }

  return { error: "Could not create a unique project URL. Please try a different name." };
}
