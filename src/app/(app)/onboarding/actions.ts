"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { createServiceClient } from "@/lib/supabase/service";
import { createWorkspaceSchema, slugify } from "@/lib/validation/workspace";

export interface CreateWorkspaceResult {
  error?: string;
}

const POSTGRES_UNIQUE_VIOLATION = "23505";
const MAX_SLUG_ATTEMPTS = 5;

export async function createWorkspace(
  _prev: CreateWorkspaceResult,
  formData: FormData,
): Promise<CreateWorkspaceResult> {
  const user = await requireUser();

  const parsed = createWorkspaceSchema.safeParse({ name: formData.get("name") });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const supabase = await createClient();
  const baseSlug = slugify(parsed.data.name);

  // `workspaces.slug` is globally unique, not per-user — and because RLS
  // scopes every SELECT to workspaces this user is already a member of, a
  // pre-check ("does this slug exist?") would be blind to collisions with
  // OTHER tenants' rows. Insert-and-retry-on-conflict is the only version of
  // this that's actually correct, not just usually-correct.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

    const { data: workspace, error } = await supabase
      .from("workspaces")
      .insert({ name: parsed.data.name, slug, owner_id: user.id })
      .select("id")
      .single();

    if (!error && workspace) {
      const audit = createServiceClient();
      await audit.from("audit_logs").insert({
        workspace_id: workspace.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "workspace.created",
        target_type: "workspace",
        target_id: workspace.id,
      });

      redirect(`/w/${workspace.id}`);
    }

    if (error?.code !== POSTGRES_UNIQUE_VIOLATION) {
      return { error: "Could not create workspace. Please try again." };
    }
    // else: slug collision, loop and retry with a randomized suffix.
  }

  return { error: "Could not create a unique workspace URL. Please try a different name." };
}
