import Link from "next/link";
import { PlusIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { notFound } from "next/navigation";
import { Card, CardAction, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { resolveProjectScope } from "@/lib/scope";

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  // Only needed to confirm this project exists/is a member of workspaceId —
  // project_connectors and tasks both carry project_id directly now, so
  // neither query below needs the resolved client_space_id.
  const scope = await resolveProjectScope(workspaceId, projectId);
  if (!scope) {
    notFound();
  }

  const supabase = await createClient();

  // Grant health (status) lives on space_connections; this project's own
  // sync bookkeeping (last_sync_succeeded_at) lives on project_connectors —
  // see supabase/migrations/20260901000800_connectors.sql. Filtered by
  // project_id, not client_space_id: a sibling project scoping the same
  // connection has its own separate project_connectors row and must not
  // inflate this project's counts.
  const [{ data: projectConnectorRows }, { count: pendingCount }] = await Promise.all([
    supabase
      .from("project_connectors")
      .select("id, provider, last_sync_succeeded_at, space_connections(status)")
      .eq("project_id", projectId)
      .eq("enabled", true),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .in("status", ["pending", "in_progress"]),
  ]);

  const integrations = (projectConnectorRows ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.space_connections?.status ?? "pending",
    lastSyncSucceededAt: row.last_sync_succeeded_at,
  }));

  const connectedCount = integrations.filter((i) => i.status === "connected").length;
  const lastSync = integrations
    .map((i) => i.lastSyncSucceededAt)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-lg font-semibold">Overview</h1>
        <p className="text-sm text-muted-foreground">A snapshot of this project&apos;s activity and connections.</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Pending action items</CardDescription>
            <CardTitle className="text-2xl" data-testid="pending-count">
              {pendingCount ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Connected integrations</CardDescription>
            <CardTitle className="text-2xl">
              {connectedCount} / {integrations?.length ?? 0}
            </CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Last sync</CardDescription>
            <CardTitle className="text-2xl">{lastSync ? new Date(lastSync).toLocaleString() : "Never"}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 sm:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Today&apos;s action items</CardTitle>
          </CardHeader>
          <CardContent className="text-sm text-muted-foreground">
            <p>{pendingCount ?? 0} pending.</p>
            <Link
              href={`/w/${workspaceId}/p/${projectId}/task-management`}
              className="text-brand-teal-600 underline hover:text-brand-teal-700"
            >
              View all
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected services</CardTitle>
            {integrations && integrations.length > 0 ? (
              <CardAction>
                <Button
                  render={<Link href={`/w/${workspaceId}/p/${projectId}/integrations`} aria-label="Connect services" />}
                  nativeButton={false}
                  variant="ghost"
                  size="icon-sm"
                  className="text-brand-teal-600 hover:text-brand-teal-700"
                >
                  <PlusIcon aria-hidden="true" />
                </Button>
              </CardAction>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!integrations || integrations.length === 0 ? (
              <p className="text-muted-foreground">
                No integrations yet.{" "}
                <Link
                  href={`/w/${workspaceId}/p/${projectId}/integrations`}
                  className="text-brand-teal-600 underline hover:text-brand-teal-700"
                >
                  Connect one
                </Link>
                .
              </p>
            ) : (
              integrations.map((integration) => (
                <div key={integration.id} className="flex items-center justify-between">
                  <span className="capitalize">{integration.provider}</span>
                  <Badge variant={integration.status === "connected" ? "default" : "outline"}>
                    {integration.status}
                  </Badge>
                </div>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
