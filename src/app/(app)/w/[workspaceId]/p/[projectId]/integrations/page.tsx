import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { listConnectors } from "@/connectors/registry";
import { connectMock, connectSlack, disconnectIntegration, syncNow } from "./actions";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  connected: "default",
  pending: "secondary",
  degraded: "secondary",
  error: "destructive",
  revoked: "outline",
  disconnected: "outline",
};

export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ slack?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const { slack: slackStatus } = await searchParams;
  const supabase = await createClient();

  const { data: integrations } = await supabase
    .from("integrations")
    .select("id, provider, status, display_name, last_sync_succeeded_at, last_error, sync_enabled")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  const connectedProviders = new Set((integrations ?? []).map((i) => i.provider));
  const availableConnectors = listConnectors().filter((c) => !connectedProviders.has(c.id));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {slackStatus && slackStatus !== "connected" ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Slack connection failed ({slackStatus}). Please try again.
        </p>
      ) : null}

      <section>
        <h2 className="mb-4 text-base font-semibold">Connected</h2>
        {!integrations || integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">No integrations connected yet.</p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((integration) => (
              <Card key={integration.id}>
                <CardHeader className="flex flex-row items-start justify-between gap-2">
                  <div>
                    <CardTitle className="text-base">{integration.display_name ?? integration.provider}</CardTitle>
                    <CardDescription className="capitalize">{integration.provider}</CardDescription>
                  </div>
                  <Badge variant={STATUS_VARIANT[integration.status] ?? "outline"}>{integration.status}</Badge>
                </CardHeader>
                <CardContent className="space-y-3 text-xs text-muted-foreground">
                  {integration.last_sync_succeeded_at ? (
                    <p>Last synced {new Date(integration.last_sync_succeeded_at).toLocaleString()}</p>
                  ) : null}
                  {integration.last_error ? <p className="text-destructive">{integration.last_error}</p> : null}
                  {integration.status !== "disconnected" && integration.status !== "revoked" ? (
                    <div className="flex gap-2">
                      <form action={syncNow.bind(null, workspaceId, projectId)}>
                        <input type="hidden" name="integrationId" value={integration.id} />
                        <Button type="submit" size="sm" data-testid={`sync-${integration.provider}`}>
                          Sync now
                        </Button>
                      </form>
                      <form action={disconnectIntegration.bind(null, workspaceId, projectId)}>
                        <input type="hidden" name="integrationId" value={integration.id} />
                        <Button type="submit" variant="outline" size="sm" data-testid={`disconnect-${integration.provider}`}>
                          Disconnect
                        </Button>
                      </form>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </section>

      {availableConnectors.length > 0 ? (
        <section>
          <h2 className="mb-4 text-base font-semibold">Available</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {availableConnectors.map((connector) => (
              <Card key={connector.id}>
                <CardHeader>
                  <CardTitle className="text-base">{connector.displayName}</CardTitle>
                </CardHeader>
                <CardContent>
                  {connector.id === "slack" ? (
                    <form action={connectSlack.bind(null, workspaceId, projectId)}>
                      <Button type="submit" size="sm" data-testid="connect-slack">
                        Connect
                      </Button>
                    </form>
                  ) : connector.id === "mock" ? (
                    <form action={connectMock.bind(null, workspaceId, projectId)}>
                      <Button type="submit" size="sm" variant="outline" data-testid="connect-mock">
                        Connect
                      </Button>
                    </form>
                  ) : null}
                </CardContent>
              </Card>
            ))}
          </div>
        </section>
      ) : null}
    </div>
  );
}
