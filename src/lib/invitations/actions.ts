"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { requireUser } from "@/lib/auth";
import { requirePermission, spaceScope, workspaceScope, type ScopeRef } from "@/lib/authz";
import { appUrl } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { generateInviteToken, hashInviteToken, inviteExpiryFromNow } from "./tokens";
import { sendInviteEmail } from "./email";

const POSTGRES_UNIQUE_VIOLATION = "23505";

export interface InviteResult {
  message: string;
  /** Always returned, whether or not the mail went out — the pending list
   * shows a copy button so an invitation is usable while SES is sandboxed. */
  inviteUrl: string;
  delivered: boolean;
}

const inviteSchema = z.object({
  email: z.string().email("Enter a valid email address."),
  role: z.string().min(1, "Choose a role."),
});

/**
 * Which scopes this app can invite into.
 *
 * Project-scoped invitations are deliberately NOT offered. `project_members`
 * has an FK to `space_members`, so a project invite must also carry a space
 * role or accept_invitation() throws — meaning the form would have to collect
 * two roles to express "put them on this one project". Since anyone on a
 * project necessarily has standing in the space anyway, the simpler path is:
 * invite to the space, then set a per-project override on the roster. Same end
 * state, one decision at a time.
 */
export type InviteScopeLevel = "workspace" | "space";

function scopeRefFor(level: InviteScopeLevel, id: string): ScopeRef {
  return level === "workspace" ? workspaceScope(id) : spaceScope(id);
}

/**
 * Creates an invitation and tries to email it.
 *
 * ORDER IS DELIBERATE: the row is written first, the mail second. The row is
 * the source of truth — an invitation that exists but was not delivered is
 * recoverable from the pending list, while a mail delivered for a row that was
 * rolled back is not recoverable at all. So a send failure downgrades the
 * message and never undoes the invitation.
 *
 * Three checks stand in front of the write, matching the members actions:
 * requirePermission for a readable failure, assignable_roles so the DB decides
 * what this caller may grant (including the rank ceiling), and the
 * invitations_write RLS policy on the insert itself.
 */
export async function createInvitation(
  level: InviteScopeLevel,
  scopeId: string,
  _prev: { error?: string } | undefined,
  formData: FormData,
): Promise<{ error?: string; result?: InviteResult }> {
  const user = await requireUser();
  await requirePermission("member.invite", scopeRefFor(level, scopeId));

  const parsed = inviteSchema.safeParse({
    email: formData.get("email"),
    role: formData.get("role"),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { email, role } = parsed.data;

  const supabase = await createClient();

  // The DB decides what may be granted. Validating against this rather than a
  // hard-coded list is what keeps a newly added role invitable with no code
  // change, and what stops an invitation being a way around the rank ceiling
  // the members screen enforces.
  const { data: allowed } = await supabase.rpc("assignable_roles", {
    p_scope_level: level,
    p_scope_id: scopeId,
  });
  if (!allowed?.some((r) => r.key === role)) {
    return { error: "You cannot invite someone at that role." };
  }

  // Resolve the full scope chain. invitations.tenant_id is NOT NULL and the
  // scope-chain CHECK requires every id above the deepest one to be set.
  let tenantId: string | null = null;
  let workspaceId: string | null = null;
  let clientSpaceId: string | null = null;

  if (level === "workspace") {
    const { data } = await supabase.from("workspaces").select("id, tenant_id").eq("id", scopeId).maybeSingle();
    if (!data) return { error: "Workspace not found." };
    tenantId = data.tenant_id;
    workspaceId = data.id;
  } else {
    const { data } = await supabase
      .from("client_spaces")
      .select("id, tenant_id, workspace_id")
      .eq("id", scopeId)
      .maybeSingle();
    if (!data) return { error: "Client space not found." };
    tenantId = data.tenant_id;
    workspaceId = data.workspace_id;
    clientSpaceId = data.id;
  }

  const token = generateInviteToken();
  const expiresAt = inviteExpiryFromNow();

  const { error } = await supabase.from("invitations").insert({
    tenant_id: tenantId,
    workspace_id: workspaceId,
    client_space_id: clientSpaceId,
    email,
    // A SPACE invitation also grants workspace `member`, and it has to.
    //
    // Every route in this app is /w/:workspaceId/…, and workspaces_select
    // requires workspace.read — which only workspace roles and tenant owners
    // hold. Without this, accepting a space invitation produced exactly what
    // it granted (tenant + space membership, verified in the database) and
    // still left the person on a bare dashboard with no navigable path to the
    // space they had just been given access to.
    //
    // `member` is the lightest role that fixes it: workspace.read, member.read
    // and contact.read, all non-cascading, and NO data access — a space viewer
    // invited this way still cannot read anything they could not read before.
    // The alternative was teaching workspaces_select to accept "can see a
    // client space inside it", which is a resolver change to express something
    // the grid can already say.
    workspace_role: level === "workspace" ? role : "member",
    space_role: level === "space" ? role : null,
    token_hash: hashInviteToken(token),
    expires_at: expiresAt,
    invited_by: user.id,
  });

  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      return { error: "There is already a pending invitation for that address here. Revoke it first, or use Resend." };
    }
    return { error: "Could not create this invitation." };
  }

  const inviteUrl = `${appUrl()}/invite/${token}`;
  const scopeName = await scopeDisplayName(supabase, level, scopeId);

  const mail = await sendInviteEmail({
    to: email,
    inviteUrl,
    invitedBy: user.email ?? "A teammate",
    scopeName,
    roleLabels: allowed.filter((r) => r.key === role).map((r) => r.label),
    expiresAt,
  });

  revalidatePathsFor(level, scopeId);

  return {
    result: {
      inviteUrl,
      delivered: mail.delivered,
      message: mail.delivered
        ? `Invitation sent to ${email}.`
        : mail.reason === "not_configured"
          ? `Invitation created. Email is not configured yet — copy the link to share it.`
          : `Invitation created, but the email could not be sent. Copy the link to share it.`,
    },
  };
}

/**
 * Revokes a pending invitation.
 *
 * `revoked_at` is the ONLY column a client may update on this table — the
 * grant is `update (revoked_at)` and nothing else — so this is the one
 * transition expressible from the app. accepted_at/accepted_by belong to
 * accept_invitation() alone.
 */
export async function revokeInvitation(
  level: InviteScopeLevel,
  scopeId: string,
  invitationId: string,
): Promise<{ message: string }> {
  await requireUser();
  await requirePermission("member.invite", scopeRefFor(level, scopeId));

  const supabase = await createClient();
  const { data: row, error } = await supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .select("id")
    .maybeSingle();

  if (error || !row) {
    throw new Error("Could not revoke this invitation. It may have already been accepted or revoked.");
  }

  revalidatePathsFor(level, scopeId);
  return { message: "Invitation revoked." };
}

/**
 * Resends by revoking the old invitation and creating a new one.
 *
 * NOT an update. `expires_at` is not in the client's update grant, and
 * `invitations_pending_uniq` permits only one live invitation per
 * (tenant, email, exact scope) — so extending in place is impossible and
 * inserting alongside would collide. Revoke-then-create satisfies both, mints
 * a fresh token (invalidating any link already in the wild), and leaves an
 * honest record of how many times someone was chased.
 */
export async function resendInvitation(
  level: InviteScopeLevel,
  scopeId: string,
  invitationId: string,
): Promise<{ message: string; inviteUrl: string }> {
  const user = await requireUser();
  await requirePermission("member.invite", scopeRefFor(level, scopeId));

  const supabase = await createClient();
  const { data: existing } = await supabase
    .from("invitations")
    .select("id, email, tenant_id, workspace_id, client_space_id, workspace_role, space_role")
    .eq("id", invitationId)
    .is("accepted_at", null)
    .is("revoked_at", null)
    .maybeSingle();

  if (!existing) {
    throw new Error("That invitation is no longer pending.");
  }

  const { error: revokeError } = await supabase
    .from("invitations")
    .update({ revoked_at: new Date().toISOString() })
    .eq("id", invitationId);
  if (revokeError) {
    throw new Error("Could not resend this invitation.");
  }

  const token = generateInviteToken();
  const expiresAt = inviteExpiryFromNow();

  const { error: insertError } = await supabase.from("invitations").insert({
    tenant_id: existing.tenant_id,
    workspace_id: existing.workspace_id,
    client_space_id: existing.client_space_id,
    email: existing.email,
    workspace_role: existing.workspace_role,
    space_role: existing.space_role,
    token_hash: hashInviteToken(token),
    expires_at: expiresAt,
    invited_by: user.id,
  });
  if (insertError) {
    throw new Error("Could not resend this invitation.");
  }

  const inviteUrl = `${appUrl()}/invite/${token}`;
  const scopeName = await scopeDisplayName(supabase, level, scopeId);
  const mail = await sendInviteEmail({
    to: existing.email,
    inviteUrl,
    invitedBy: user.email ?? "A teammate",
    scopeName,
    roleLabels: [],
    expiresAt,
  });

  revalidatePathsFor(level, scopeId);
  // The URL is returned because it CANNOT be recovered later: only the SHA-256
  // hash is stored, so this is the one moment the new link exists in a form
  // anyone can copy. The pending list therefore offers "resend" rather than
  // "copy link" for rows that were minted on an earlier request.
  return {
    message: mail.delivered
      ? `Invitation resent to ${existing.email}.`
      : "Invitation renewed. Email is not configured — copy the new link below.",
    inviteUrl,
  };
}

type Client = Awaited<ReturnType<typeof createClient>>;

async function scopeDisplayName(supabase: Client, level: InviteScopeLevel, scopeId: string): Promise<string> {
  const table = level === "workspace" ? "workspaces" : "client_spaces";
  const { data } = await supabase.from(table).select("name").eq("id", scopeId).maybeSingle();
  return data?.name ?? "the workspace";
}

function revalidatePathsFor(level: InviteScopeLevel, scopeId: string): void {
  if (level === "workspace") revalidatePath(`/w/${scopeId}/members`);
  else revalidatePath("/", "layout");
}
