import { ChevronDownIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsiblePanel,
} from "@/components/ui/collapsible";
import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveProjectScope } from "@/lib/scope";
import { can, spaceScope, projectScope } from "@/lib/authz";
import { listConnectors } from "@/connectors/registry";
import { AsyncButton } from "@/components/dashboard/async-button";
import { ConfirmActionButton } from "@/components/dashboard/confirm-action-button";
import { ConnectProviderButton } from "@/components/dashboard/connect-provider-button";
import { IntegrationConfigForm } from "@/components/dashboard/integration-config-form";
import { GoogleIntegrationConfigForm } from "@/components/dashboard/google-integration-config-form";
import { getConfigSchema } from "@/lib/db/schemas/integration-config";
import { GOOGLE_CONFIG_SECTIONS } from "@/connectors/google/config";
import {
  connectMock,
  createIntegrationConnectSession,
  disconnectIntegration,
  finalizeConnection,
  reconcileConnections,
  syncNow,
} from "./actions";

const STATUS_VARIANT: Record<
  string,
  "default" | "secondary" | "destructive" | "outline"
> = {
  connected: "default",
  pending: "secondary",
  degraded: "secondary",
  error: "destructive",
  revoked: "outline",
  disconnected: "outline",
};

/** Providers that merged into `google` and no longer have a connector
 * registered. Their enum values survive for historical rows — none can exist
 * yet on this freshly-rebuilt v2 schema, but a project_connectors row with
 * one of these providers would otherwise render a "connected" card that can
 * never sync again. Kept as a defensive check, matching the same guard the
 * pre-v2 design needed once real usage accumulates. */
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
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
}) {
  const { workspaceId, projectId } = await params;

  // project_connectors is project-scoped now, unlike the old client-space-
  // wide integrations table — still resolve the project's client space
  // (needed by other pages/actions in this scope) but the query below
  // filters on project_id directly (see src/lib/scope.ts).
  const scope = await resolveProjectScope(workspaceId, projectId);
  if (!scope) {
    notFound();
  }

  // UI-only. Every one of these actions re-checks server-side with
  // requirePermission (see integrations/actions.ts, where the service-role
  // client means RLS never runs) — this just stops rendering controls that
  // would fail, and says why on hover instead of on click.
  const [canManageConnections, canConfigureProject, canSync] = await Promise.all([
    can("connection.manage", spaceScope(scope.clientSpaceId)),
    can("project.manage", projectScope(scope.projectId)),
    can("sync.trigger", projectScope(scope.projectId)),
  ]);
  const connectionsReason = canManageConnections
    ? undefined
    : "Only space admins can connect or disconnect providers.";
  const syncReason = canSync ? undefined : "You do not have permission to run a sync.";
  const configReason = canConfigureProject
    ? undefined
    : "Only people who can manage this project may change its connector settings.";

  const supabase = await createClient();

  // Grant health/label live on space_connections (client-space scoped, one
  // row per provider account); this project's own scoping (config, sync
  // schedule/health) lives on project_connectors — see
  // supabase/migrations/20260901000800_connectors.sql.
  // enabled=false means this project disconnected it — the row (and its
  // synced history, per raw_events/normalized_events' cascade FK to it)
  // survives so a reconnect resumes rather than re-ingesting from scratch,
  // but it must not show as "Connected" — see disconnectIntegration's own
  // comment for why this is a soft disable, not a delete.
  const { data: projectConnectorRows } = await supabase
    .from("project_connectors")
    .select(
      "id, provider, config, sync_enabled, last_sync_succeeded_at, last_error, space_connections(status, external_account_label)",
    )
    .eq("project_id", projectId)
    .eq("enabled", true)
    .order("created_at", { ascending: true });

  const integrations = (projectConnectorRows ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.space_connections?.status ?? "pending",
    displayName: row.space_connections?.external_account_label ?? null,
    lastSyncSucceededAt: row.last_sync_succeeded_at,
    lastError: row.last_error,
    syncEnabled: row.sync_enabled,
    config: row.config,
  }));

  // A project_connectors row existing at all means this project is
  // connected to that provider — disconnecting deletes the row (see
  // disconnectIntegration), so unlike the old status-flag design there is no
  // "disconnected but still listed" state left to filter out here.
  const connectedProviders = new Set(integrations.map((i) => i.provider));
  const availableConnectors = listConnectors().filter(
    (c) => !connectedProviders.has(c.id),
  );
  // Only a Nango-backed provider can have an orphaned connection (one that
  // exists on Nango's side with no local row yet — see reconcileConnections'
  // doc comment) — an available `mock` slot has nothing for the sweep to
  // find, so don't show the button when it's the only thing available.
  const hasNangoAvailable = availableConnectors.some(
    (c) => c.nangoProviderConfigKey,
  );

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-lg font-semibold">Integrations</h1>
        <p className="text-sm text-muted-foreground">
          Connect and manage the sources this project pulls activity from.
        </p>
      </div>

      <section>
        <h2 className="mb-4 text-base font-semibold">Connected</h2>
        {!integrations || integrations.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No integrations connected yet.
          </p>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            {integrations.map((integration) => {
              const config = (integration.config ?? {}) as Record<
                string,
                unknown
              >;
              const isRetired = RETIRED_GOOGLE_PROVIDERS.includes(
                integration.provider,
              );
              const entry = isRetired
                ? undefined
                : getConfigSchema(integration.provider);

              return (
                <Card key={integration.id}>
                  <Collapsible>
                    <CardHeader className="">
                      <div className="flex flex-row items-start justify-between gap-2">
                        <div>
                          <CardTitle className="text-base">
                            {integration.displayName ?? integration.provider}
                          </CardTitle>
                          <CardDescription className="capitalize">
                            {integration.provider}
                          </CardDescription>
                        </div>
                        <div className="flex items-center gap-2">
                          <Badge
                            variant={
                              STATUS_VARIANT[integration.status] ?? "outline"
                            }
                          >
                            {integration.status}
                          </Badge>
                          <CollapsibleTrigger
                            className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                            aria-label={`Toggle ${integration.displayName ?? integration.provider} details`}
                            data-testid={`toggle-${integration.provider}`}
                          >
                            <ChevronDownIcon className="size-4 transition-transform group-data-panel-open:rotate-180" />
                          </CollapsibleTrigger>
                        </div>
                      </div>
                      <div>
                        <div className="flex gap-2">
                          {/* A retired provider has no connector left to run,
                            so Sync now is hidden — Disconnect still works
                            (disconnectIntegration already best-effort
                            catches a failed revoke, including the
                            getConnector throw for these providers). */}
                          {isRetired ? null : (
                            <AsyncButton
                              action={syncNow.bind(
                                null,
                                workspaceId,
                                projectId,
                                integration.id,
                              )}
                              loadingMessage="Queuing sync…"
                              size="sm"
                              disabledReason={syncReason}
                              data-testid={`sync-${integration.provider}`}
                            >
                              Sync now
                            </AsyncButton>
                          )}
                          <ConfirmActionButton
                            action={disconnectIntegration.bind(
                              null,
                              workspaceId,
                              projectId,
                              integration.id,
                            )}
                            triggerLabel="Disconnect"
                            triggerVariant="default"
                            disabledReason={connectionsReason}
                            confirmLabel="Disconnect"
                            loadingMessage="Disconnecting…"
                            title={`Disconnect ${integration.displayName ?? integration.provider}?`}
                            description="This detaches the connector from this project. Other projects sharing the same connection are unaffected; you can reconnect later."
                            data-testid={`disconnect-${integration.provider}`}
                          />
                        </div>
                      </div>
                    </CardHeader>
                    <CollapsiblePanel keepMounted>
                      <CardContent className="space-y-3 text-xs text-muted-foreground mt-2">
                        {integration.lastSyncSucceededAt ? (
                          <p>
                            Last synced{" "}
                            {new Date(
                              integration.lastSyncSucceededAt,
                            ).toLocaleString()}
                          </p>
                        ) : null}
                        {integration.lastError ? (
                          <p className="text-destructive">
                            {integration.lastError}
                          </p>
                        ) : null}

                        {isRetired ? (
                          <p
                            className="rounded-md border border-brand-warning/30 bg-brand-warning/10 px-3 py-2 text-brand-warning"
                            data-testid={`retired-${integration.provider}`}
                          >
                            This connector has moved. Gmail, Google Drive and
                            Google Chat are now one “Google” connector —
                            disconnect this one and connect Google instead, then
                            enable the services you want. Data already synced
                            from here is kept.
                          </p>
                        ) : null}

                        {integration.provider === "google" ? (
                          <p data-testid="google-service-summary">
                            {googleServiceSummary(config).join(" · ")}
                          </p>
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
                        {entry ? (
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
                              disabledReason={configReason}
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
          <div className="mb-4 flex items-center justify-between gap-2">
            <h2 className="text-base font-semibold">Available</h2>
            {/* Covers the case reconcileConnections' event-driven trigger
              can't: the whole browser closed or crashed mid-flow, not just
              the Connect UI popup (see ConnectProviderButton's `close`
              handler and reconcileConnections' own doc comment). */}
            {hasNangoAvailable ? (
              <AsyncButton
                action={reconcileConnections.bind(null, workspaceId, projectId)}
                loadingMessage="Checking…"
                size="sm"
                variant="outline"
                disabledReason={connectionsReason}
                data-testid="check-connections"
              >
                Check for connections
              </AsyncButton>
            ) : null}
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            {availableConnectors.map((connector) => (
              <Card key={connector.id}>
                <CardHeader>
                  <CardTitle className="text-base">
                    {connector.displayName}
                  </CardTitle>
                </CardHeader>
                <CardContent>
                  {connector.nangoProviderConfigKey ? (
                    <ConnectProviderButton
                      disabledReason={connectionsReason}
                      provider={connector.id}
                      workspaceId={workspaceId}
                      projectId={projectId}
                      createConnectSession={createIntegrationConnectSession}
                      finalizeConnection={finalizeConnection}
                      reconcileConnections={reconcileConnections}
                    />
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
