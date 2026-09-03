"use server";

import { redirect } from "next/navigation";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";

/**
 * Accepts an invitation and lands the user where it granted them access.
 *
 * All the authorization lives in `accept_invitation()`, which is SECURITY
 * DEFINER for the obvious reason: the caller holds no membership yet, so every
 * RLS write policy in the schema would reject them. It hashes the plaintext
 * token internally, so the hash never travels in a query this layer builds,
 * and it provisions tenant → workspace → space → project in the one order the
 * composite FKs permit — atomically, so a caller either gets the whole scope
 * or none of it.
 *
 * This action therefore does almost nothing, which is the point. Re-checking
 * expiry or revocation here would be a second implementation of a decision the
 * function already makes correctly.
 */
export async function acceptInvitation(token: string): Promise<{ error?: string }> {
  await requireUser();

  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", { p_token: token });

  if (error) {
    // The function raises with a plain sentence — "invitation has expired",
    // "invitation has already been accepted" — which is more useful to the
    // recipient than anything this layer could substitute.
    return { error: error.message.replace(/^.*?:\s*/, "") };
  }

  // Land them on the deepest thing the invitation actually opened up.
  //
  // Read AFTER accepting and through the USER-scoped client, so each query
  // succeeds only because the membership now exists — which makes this a
  // check of what was really granted rather than a guess from the invitation's
  // columns. Prefer a project (the useful screen) over the workspace shell,
  // and fall back to the dashboard if somehow neither is visible.
  const { data: project } = await supabase
    .from("projects")
    .select("id, workspace_id")
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (project) redirect(`/w/${project.workspace_id}/p/${project.id}`);

  const { data: workspace } = await supabase.from("workspaces").select("id").limit(1).maybeSingle();
  redirect(workspace ? `/w/${workspace.id}` : "/");
}
