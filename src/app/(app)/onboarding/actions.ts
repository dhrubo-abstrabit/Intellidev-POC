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
  // already hold tenant_role 'owner' (see
  // supabase/migrations/20260901000400_tenancy.sql). This app has no
  // tenant/billing UI yet, so "create a workspace" provisions a brand-new
  // tenant behind the scenes, one per workspace, invisible to the user.
  //
  // Both inserts happen inside the create_tenant_and_workspace RPC (see
  // supabase/migrations/20260901001900_workspace_onboarding_rpc.sql), not as
  // two separate `.from(...).insert()` calls: an INSERT ... RETURNING run as
  // the authenticated user can never see the tenant it just created, because
  // the SELECT policy that would allow it depends on a tenant_members row
  // written by an AFTER INSERT trigger — which fires too late to satisfy
  // that same statement's RETURNING check. The RPC is SECURITY DEFINER, so
  // it bypasses RLS for both inserts entirely and sidesteps the race, while
  // the same AFTER INSERT triggers still fire and grant tenant_members.role
  // = 'owner' / workspace_members.role = 'admin' from auth.uid() exactly as
  // before. Neither insert passes an owner id: `tenants` and `workspaces`
  // have no owner_id column, precisely so those trigger-written role rows
  // stay the only source of truth for ownership.
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

    const { data: result, error: rpcError } = await supabase
      .rpc("create_tenant_and_workspace", { p_name: parsed.data.name, p_slug: slug })
      .single();

    if (rpcError) {
      if (rpcError.code !== POSTGRES_UNIQUE_VIOLATION) {
        return { error: "Could not create workspace. Please try again." };
      }
      continue; // slug collision, retry with a randomized suffix
    }
    if (!result) {
      return { error: "Could not create workspace. Please try again." };
    }

    const audit = createServiceClient();
    await audit.from("audit_logs").insert([
      {
        tenant_id: result.tenant_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "tenant.created",
        target_type: "tenant",
        target_id: result.tenant_id,
      },
      {
        tenant_id: result.tenant_id,
        workspace_id: result.workspace_id,
        actor_user_id: user.id,
        actor_type: "user",
        action: "workspace.created",
        target_type: "workspace",
        target_id: result.workspace_id,
      },
    ]);

    redirect(`/w/${result.workspace_id}`);
  }

  return { error: "Could not create a unique workspace URL. Please try a different name." };
}
