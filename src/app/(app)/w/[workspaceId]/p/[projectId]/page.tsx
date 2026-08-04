import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";

export default async function ProjectOverviewPage({
  params,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const supabase = await createClient();

  const [{ data: integrations }, { count: pendingCount }] = await Promise.all([
    supabase
      .from("integrations")
      .select("id, provider, status, last_sync_succeeded_at")
      .eq("project_id", projectId),
    supabase
      .from("action_items")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .in("status", ["pending", "in_progress"]),
  ]);

  const connectedCount = (integrations ?? []).filter((i) => i.status === "connected").length;
  const lastSync = (integrations ?? [])
    .map((i) => i.last_sync_succeeded_at)
    .filter((d): d is string => Boolean(d))
    .sort()
    .at(-1);

  return (
    <div className="mx-auto max-w-3xl space-y-6">
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
            <Link href={`/w/${workspaceId}/p/${projectId}/items`} className="text-foreground underline">
              View all
            </Link>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Connected services</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-sm">
            {!integrations || integrations.length === 0 ? (
              <p className="text-muted-foreground">
                No integrations yet.{" "}
                <Link href={`/w/${workspaceId}/p/${projectId}/integrations`} className="text-foreground underline">
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
