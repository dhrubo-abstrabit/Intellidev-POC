import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { createClient } from "@/lib/supabase/server";
import { listConnectors } from "@/connectors/registry";
import { AsyncButton } from "@/components/dashboard/async-button";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { ConnectProviderButton } from "@/components/dashboard/connect-provider-button";
import { IntegrationConfigForm } from "@/components/dashboard/integration-config-form";
import { GoogleIntegrationConfigForm } from "@/components/dashboard/google-integration-config-form";
import { getConfigSchema } from "@/lib/db/schemas/integration-config";
import { GOOGLE_CONFIG_SECTIONS } from "@/connectors/google/config";
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

/** Providers that merged into `google` and no longer have a connector
 * registered. Their enum values survive for historical rows, so a project
 * that connected one before the merge still has a live-looking integration
 * row that can never sync again — it gets a "reconnect as Google" banner
 * instead of Sync-now + a config form. */
const RETIRED_GOOGLE_PROVIDERS = ["gmail", "google_drive", "google_chat"];

/** Compact per-service readout for a merged Google integration's card —
 * `null` in the config means that sub-service is switched off. */
function googleServiceSummary(config: Record<string, unknown>): string[] {
  const gmail = config.gmail as { query?: unknown } | null | undefined;
  const drive = config.drive as { sources?: unknown } | null | undefined;
  const chat = config.chat as { spaceIds?: unknown } | null | undefined;
  const driveSources = Array.isArray(drive?.sources) ? drive.sources.length : 0;
  const chatSpaces = Array.isArray(chat?.spaceIds) ? chat.spaceIds.length : 0;
  return [
    `Gmail: ${gmail ? "on" : "off"}`,
    `Drive: ${drive ? `${driveSources} source${driveSources === 1 ? "" : "s"}` : "off"}`,
    `Chat: ${chat ? `${chatSpaces} space${chatSpaces === 1 ? "" : "s"}` : "off"}`,
  ];
}

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
            {integrations.map((integration) => {
              const config = (integration.config ?? {}) as Record<string, unknown>;
              const isActive = integration.status !== "disconnected" && integration.status !== "revoked";
              const isRetired = RETIRED_GOOGLE_PROVIDERS.includes(integration.provider);
              const entry = isRetired ? undefined : getConfigSchema(integration.provider);

              return (
              <Card key={integration.id} className="transition-colors hover:ring-brand-teal-400">
                <Collapsible>
                  <CardHeader className="flex flex-row items-start justify-between gap-2">
                    <div>
                      <CardTitle className="text-base">{integration.display_name ?? integration.provider}</CardTitle>
                      <CardDescription className="capitalize">{integration.provider}</CardDescription>
                    </div>
                    <div className="flex items-center gap-2">
                      <Badge variant={STATUS_VARIANT[integration.status] ?? "outline"}>{integration.status}</Badge>
                      <CollapsibleTrigger
                        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        aria-label={`Toggle ${integration.display_name ?? integration.provider} details`}
                        data-testid={`toggle-${integration.provider}`}
                      >
                        <ChevronDownIcon className="size-4 transition-transform group-data-panel-open:rotate-180" />
                      </CollapsibleTrigger>
                    </div>
                  </CardHeader>
                  <CollapsiblePanel keepMounted>
                    <CardContent className="space-y-3 text-xs text-muted-foreground">
                      {integration.last_sync_succeeded_at ? (
                        <p>Last synced {new Date(integration.last_sync_succeeded_at).toLocaleString()}</p>
                      ) : null}
                      {integration.last_error ? <p className="text-destructive">{integration.last_error}</p> : null}

                      {isRetired && isActive ? (
                        <p
                          className="rounded-md border border-brand-warning/30 bg-brand-warning/10 px-3 py-2 text-brand-warning"
                          data-testid={`retired-${integration.provider}`}
                        >
                          This connector has moved. Gmail, Google Drive and Google Chat are now one “Google” connector —
                          disconnect this one and connect Google instead, then enable the services you want. Data already
                          synced from here is kept.
                        </p>
                      ) : null}

                      {integration.provider === "google" && isActive ? (
                        <p data-testid="google-service-summary">{googleServiceSummary(config).join(" · ")}</p>
                      ) : null}

                      {isActive ? (
                        <div className="flex gap-2">
                          {/* A retired provider has no connector left to run,
                              so Sync now is hidden — Disconnect still works
                              (disconnectIntegration already best-effort
                              catches a failed revoke, including the
                              getConnector throw for these providers). */}
                          {isRetired ? null : (
                            <AsyncButton
                              action={syncNow.bind(null, workspaceId, projectId, integration.id)}
                              loadingMessage="Queuing sync…"
                              size="sm"
                              data-testid={`sync-${integration.provider}`}
                            >
                              Sync now
                            </AsyncButton>
                          )}
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

                      {/* Every config input is uncontrolled, seeded from the
                          saved config via `defaultValue` — React only applies
                          that at mount and ignores later changes, so after a
                          successful save this re-renders with a DIFFERENT
                          config but the SAME Input instances, which Base UI
                          flags as "changing defaultValue after init." Keying on
                          the actual saved value forces a real remount exactly
                          when the data changed — never on every render (e.g.
                          while showing a validation error after a failed save,
                          where config didn't change and the key stays stable). */}
                      {entry && isActive ? (
                        integration.provider === "google" ? (
                          <GoogleIntegrationConfigForm
                            key={JSON.stringify(config)}
                            workspaceId={workspaceId}
                            projectId={projectId}
                            integrationId={integration.id}
                            sections={GOOGLE_CONFIG_SECTIONS}
                            config={config}
                          />
                        ) : (
                          <IntegrationConfigForm
                            key={JSON.stringify(config)}
                            workspaceId={workspaceId}
                            projectId={projectId}
                            integrationId={integration.id}
                            fields={entry.fields}
                            currentValues={config}
                          />
                        )
                      ) : null}
                    </CardContent>
                  </CollapsiblePanel>
                </Collapsible>
              </Card>
              );
            })}
          </div>
        )}
      </section>

      {availableConnectors.length > 0 ? (
        <section>
          <h2 className="mb-4 text-base font-semibold">Available</h2>
          <div className="grid gap-3 sm:grid-cols-2">
            {availableConnectors.map((connector) => (
              <Card key={connector.id} className="transition-colors hover:ring-brand-teal-400">
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
