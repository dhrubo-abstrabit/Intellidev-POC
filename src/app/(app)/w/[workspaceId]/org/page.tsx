import { notFound } from "next/navigation";
import { requireUser, assertWorkspaceMembership } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { MembersView, type MemberRow, type AssignableRole } from "@/components/dashboard/members-view";
import { changeTenantMemberRole, removeTenantMember } from "./actions";

/**
 * The organisation screen — the tenant level, which had no route at all before
 * this.
 *
 * It lives UNDER the workspace segment rather than at a bare /org so it
 * inherits w/[workspaceId]/layout.tsx: the sidebar, the page padding, the
 * whole shell. That layout is where those come from, and a top-level route
 * rendered outside it looked like a different application — no navigation, no
 * padding, content flush against the viewport. Being nested does not make this
 * workspace-scoped: the tenant is resolved FROM the workspace below, and
 * everything shown belongs to the tenant.
 *
 * It answers two questions nothing else can: who is on the company roster (as
 * opposed to in one workspace or one client engagement), and how many seats
 * the plan allows. Removing someone here is the one action that actually
 * offboards them, because tenant_members is the FK target every deeper
 * membership hangs from.
 */
export default async function OrgPage({ params }: { params: Promise<{ workspaceId: string }> }) {
  const { workspaceId } = await params;
  const user = await requireUser();
  await assertWorkspaceMembership(workspaceId);

  const supabase = await createClient();

  // Resolve the tenant FROM the workspace rather than taking the first visible
  // one: same answer today (a user has one tenant), but it stays correct the
  // moment someone belongs to two.
  const { data: workspace } = await supabase
    .from("workspaces")
    .select("tenant_id, tenants(id, name)")
    .eq("id", workspaceId)
    .maybeSingle();
  const tenant = workspace?.tenants;
  if (!tenant) notFound();

  const [{ data: memberRows }, { data: assignable }, { data: roleCatalog }, { data: subscription }] =
    await Promise.all([
      supabase
        .from("tenant_members")
        // FK-hinted: tenant_members reaches users twice (user_id, invited_by).
        .select("user_id, role, users!tenant_members_user_id_fkey(email, full_name)")
        .eq("tenant_id", tenant.id)
        .order("joined_at", { ascending: true }),
      supabase.rpc("assignable_roles", { p_scope_level: "tenant", p_scope_id: tenant.id }),
      supabase.from("roles").select("key, label").eq("scope_level", "tenant"),
      // Gated by billing.read, so an ordinary member simply gets null here and
      // the seat card does not render. No role check in this file.
      supabase.from("tenant_subscriptions").select("plan, seats, status").eq("tenant_id", tenant.id).maybeSingle(),
    ]);

  if (!memberRows) notFound();

  const roleLabels = Object.fromEntries((roleCatalog ?? []).map((r) => [r.key, r.label]));

  const members: MemberRow[] = memberRows.map((row) => ({
    userId: row.user_id,
    role: row.role,
    email: row.users?.email ?? "—",
    fullName: row.users?.full_name ?? null,
  }));

  const assignableRoles: AssignableRole[] = (assignable ?? []).map((r) => ({
    key: r.key,
    label: r.label,
    description: r.description,
  }));

  const used = members.length;
  const seats = subscription?.seats ?? null;
  const full = seats !== null && used >= seats;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">{tenant.name}</h1>
        <p className="text-sm text-muted-foreground">Organisation roster and plan.</p>
      </div>

      {subscription ? (
        <Card>
          <CardHeader>
            <CardTitle>Plan and seats</CardTitle>
            <CardDescription>
              Every person on the roster uses one seat, however many workspaces or client spaces they belong to.
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-wrap items-center gap-6">
            <div>
              <p className="text-xs text-muted-foreground uppercase">Plan</p>
              <p className="font-medium">
                {subscription.plan}{" "}
                <Badge variant={subscription.status === "active" ? "secondary" : "destructive"}>
                  {subscription.status}
                </Badge>
              </p>
            </div>
            <div>
              <p className="text-xs text-muted-foreground uppercase">Seats used</p>
              <p className="font-medium tabular-nums">
                {used}
                {seats === null ? " (unlimited)" : ` of ${seats}`}
              </p>
            </div>
            {full ? (
              <p className="text-sm text-destructive">
                All seats are in use. Remove someone, or upgrade, before inviting anyone new.
              </p>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      <MembersView
        title="Organisation members"
        description="Everyone with an account in this organisation. Removing someone here revokes every workspace and client-space membership they have."
        members={members}
        assignableRoles={assignableRoles}
        currentUserId={user.id}
        roleLabels={roleLabels}
        changeRoleAction={changeTenantMemberRole.bind(null, tenant.id)}
        removeAction={removeTenantMember.bind(null, tenant.id)}
        removeDescriptionTemplate="{email} loses access to EVERYTHING in this organisation — every workspace, every client space, every project. This frees their seat and cannot be undone."
      />
    </div>
  );
}
