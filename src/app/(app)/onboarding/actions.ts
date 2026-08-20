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

  // A workspace cannot exist without a tenant above it — workspaces.tenant_id
  // is NOT NULL, and the workspaces_insert policy requires the caller to
  // already be a super_admin of that tenant (see
  // supabase/migrations/20260820100400_tenancy.sql). This app has no
  // tenant/billing UI yet, so "create a workspace" provisions a brand-new
  // tenant behind the scenes, one per workspace, invisible to the user.
  // handle_new_tenant makes the creator that tenant's super_admin atomically,
  // so the workspace insert right after satisfies its own RLS check without
  // a second round trip.
  //
  // `tenants.slug` is globally unique — and because RLS scopes every SELECT
  // to tenants this user already administers, a pre-check ("does this slug
  // exist?") would be blind to collisions with OTHER tenants' rows.
  // Insert-and-retry-on-conflict is the only version of this that's actually
  // correct, not just usually-correct. `workspaces.slug` only has to be
  // unique PER TENANT, so reusing the same slug for both here can never
  // collide on the workspace side: this is that brand-new tenant's first
  // and only workspace.
  for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt++) {
    const slug = attempt === 0 ? baseSlug : `${baseSlug}-${Math.random().toString(36).slice(2, 6)}`;

    const { data: tenant, error: tenantError } = await supabase
      .from("tenants")
      .insert({ name: parsed.data.name, slug, owner_id: user.id })
      .select("id")
      .single();

    if (tenantError) {
      if (tenantError.code !== POSTGRES_UNIQUE_VIOLATION) {
        return { error: "Could not create workspace. Please try again." };
      }
      continue; // slug collision, retry with a randomized suffix
    }

    const { data: workspace, error: workspaceError } = await supabase
      .from("workspaces")
      .insert({ tenant_id: tenant.id, name: parsed.data.name, slug, owner_id: user.id })
      .select("id")
      .single();
    if (workspaceError || !workspace) {
      return { error: "Could not create workspace. Please try again." };
    }

    const audit = createServiceClient();
    await audit.from("audit_logs").insert([
      {
        tenant_id: tenant.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "tenant.created",
        target_type: "tenant",
        target_id: tenant.id,
      },
      {
        tenant_id: tenant.id,
        workspace_id: workspace.id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "workspace.created",
        target_type: "workspace",
        target_id: workspace.id,
      },
    ]);

    redirect(`/w/${workspace.id}`);
  }

  return { error: "Could not create a unique workspace URL. Please try a different name." };
}
