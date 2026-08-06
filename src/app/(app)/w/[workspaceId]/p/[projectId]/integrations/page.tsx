import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { createClient } from "@/lib/supabase/server";
import { listConnectors } from "@/connectors/registry";
import { AsyncButton } from "@/components/dashboard/async-button";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { ConnectProviderButton } from "@/components/dashboard/connect-provider-button";
import { IntegrationConfigForm } from "@/components/dashboard/integration-config-form";
import { getConfigSchema } from "@/lib/db/schemas/integration-config";
import { connectMock, connectProvider, disconnectIntegration, syncNow } from "./actions";

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  connected: "default",
  pending: "secondary",
  degraded: "secondary",
  error: "destructive",
  revoked: "outline",
  disconnected: "outline",
};

// Keyed by the `status` code the OAuth callback route redirects with (see
// lib/oauth/redirect.ts's integrationsRedirectUrl and
// api/oauth/[provider]/callback/route.ts). Falls back to a generic message
// for any status not listed here, so a new failure mode never renders blank.
const CONNECT_STATUS_MESSAGE: Record<string, string> = {
  denied: "Connection was cancelled.",
  oauth_state_invalid: "That connection link expired or was invalid — try connecting again.",
  oauth_state_provider_mismatch: "That connection link was for a different connector — try connecting again.",
  exchange_failed: "Could not complete the connection with the provider. Please try again.",
  credential_save_failed: "Connected, but saving the credential failed. Please try again.",
  integration_save_failed: "Connected, but saving the integration failed. Please try again.",
  no_refresh_token:
    "Google didn't return a long-lived grant. Remove this app at myaccount.google.com/permissions, then connect again.",
  scope_missing: "Not all requested permissions were granted — disconnect and reconnect to approve the full scope list.",
  invalid: "Connected, but the connector failed its post-connect check.",
};

export default async function IntegrationsPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<{ connect?: string; status?: string }>;
}) {
  const { workspaceId, projectId } = await params;
  const { connect: connectedProvider, status: connectStatus } = await searchParams;
  const supabase = await createClient();

  const { data: integrations } = await supabase
    .from("integrations")
    .select("id, provider, status, display_name, last_sync_succeeded_at, last_error, sync_enabled, config")
    .eq("project_id", projectId)
    .order("created_at", { ascending: true });

  // A disconnected/revoked row is history, not an active occupant of that
  // provider slot — otherwise disconnecting an integration would permanently
  // remove it from "Available" with no way to ever reconnect.
  const activeProviders = new Set(
    (integrations ?? []).filter((i) => i.status !== "disconnected" && i.status !== "revoked").map((i) => i.provider),
  );
  const availableConnectors = listConnectors().filter((c) => !activeProviders.has(c.id));

  return (
    <div className="mx-auto max-w-3xl space-y-8">
      {connectStatus && connectStatus !== "connected" ? (
        <p className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {CONNECT_STATUS_MESSAGE[connectStatus] ?? `Connecting ${connectedProvider ?? "the connector"} failed (${connectStatus}).`}
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
                      <AsyncButton
                        action={syncNow.bind(null, workspaceId, projectId, integration.id)}
                        loadingMessage="Queuing sync…"
                        size="sm"
                        data-testid={`sync-${integration.provider}`}
                      >
                        Sync now
                      </AsyncButton>
                      <ConfirmActionButton
                        action={disconnectIntegration.bind(null, workspaceId, projectId, integration.id)}
                        triggerLabel="Disconnect"
                        confirmLabel="Disconnect"
                        loadingMessage="Disconnecting…"
                        title={`Disconnect ${integration.display_name ?? integration.provider}?`}
                        description="This revokes access and stops future syncs. You can reconnect later."
                        data-testid={`disconnect-${integration.provider}`}
                      />
                    </div>
                  ) : null}
                  {(() => {
                    const entry = getConfigSchema(integration.provider);
                    if (!entry || integration.status === "disconnected" || integration.status === "revoked") return null;
                    const currentValues = (integration.config ?? {}) as Record<string, unknown>;
                    return (
                      <IntegrationConfigForm
                        // Every field below is an uncontrolled input seeded
                        // from `currentValues` via `defaultValue` — React
                        // only applies that at mount and ignores later
                        // changes, so after a successful save re-renders
                        // this with a DIFFERENT currentValues (the newly
                        // saved config) but the SAME Input instances, which
                        // Base UI flags as "changing defaultValue after
                        // init." Keying on the actual saved value forces a
                        // real remount exactly when the data changed —
                        // never on every render (e.g. while showing a
                        // validation error after a failed save, where
                        // config didn't change and the key stays stable).
                        key={JSON.stringify(currentValues)}
                        workspaceId={workspaceId}
                        projectId={projectId}
                        integrationId={integration.id}
                        fields={entry.fields}
                        currentValues={currentValues}
                      />
                    );
                  })()}
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
                  {connector.requiresOAuth ? (
                    <form action={connectProvider.bind(null, connector.id, workspaceId, projectId)}>
                      <ConnectProviderButton provider={connector.id} />
                    </form>
                  ) : connector.id === "mock" ? (
                    <AsyncButton
                      action={connectMock.bind(null, workspaceId, projectId)}
                      loadingMessage="Connecting…"
                      size="sm"
                      variant="outline"
                      data-testid="connect-mock"
                    >
                      Connect
                    </AsyncButton>
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
