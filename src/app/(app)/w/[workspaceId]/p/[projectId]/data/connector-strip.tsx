import Link from "next/link";
import { Button } from "@/components/ui/button";
import { GOOGLE_SERVICE_LABEL, PROVIDER_LABEL } from "@/components/items/provider-badge";
import { projectDataHref, type ProjectDataFilters } from "./filters";
import type { IntegrationSummary } from "./types";

/** Server Component, same href-building approach as DayRail. Shows this
 * project's connected integrations only (not every connector_provider enum
 * value, most of which have no connector implementation yet) — a connected
 * connector with zero events on the selected day still gets a chip, just
 * with a "0" count, so "nothing came in from Drive today" is visible rather
 * than the connector silently not appearing.
 *
 * A `google` integration renders one chip per ENABLED sub-service rather
 * than a single chip: the three used to be separate providers with their own
 * chips, and collapsing them into one would lose the ability to isolate
 * "just Gmail" on this page. Those chips filter on metadata.service (see
 * ProjectDataFilters.service), not on provider. */
export function ConnectorStrip({
  integrations,
  countsByProvider,
  countsByGoogleService,
  totalCount,
  selectedDay,
  connector,
  service,
  workspaceId,
  projectId,
}: {
  integrations: IntegrationSummary[];
  countsByProvider: Partial<Record<string, number>>;
  countsByGoogleService: Partial<Record<string, number>>;
  totalCount: number;
  selectedDay: string;
  connector: ProjectDataFilters["connector"];
  service: ProjectDataFilters["service"];
  workspaceId: string;
  projectId: string;
}) {
  if (integrations.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No connectors connected yet.{" "}
        <Link href={`/w/${workspaceId}/p/${projectId}/integrations`} className="underline underline-offset-2">
          Connect one
        </Link>
        .
      </p>
    );
  }

  return (
    <div className="flex flex-wrap items-center gap-1.5" data-testid="connector-strip">
      <Button
        render={
          <Link href={projectDataHref({ date: selectedDay, connector: "all", service: "all" })} data-testid="connector-all" />
        }
        nativeButton={false}
        variant={connector === "all" ? "secondary" : "ghost"}
        size="sm"
      >
        All ({totalCount})
      </Button>
      {integrations.flatMap((integration) => {
        // A Google integration with nothing enabled yet (freshly connected,
        // still "pending") falls through to the single-chip branch below, so
        // it doesn't silently vanish from the strip.
        if (integration.provider === "google" && integration.googleServices.length > 0) {
          return integration.googleServices.map((googleService) => {
            const count = countsByGoogleService[googleService] ?? 0;
            return (
              <Button
                key={`${integration.id}-${googleService}`}
                render={
                  <Link
                    href={projectDataHref({ date: selectedDay, connector: "google", service: googleService })}
                    data-testid={`connector-google-${googleService}`}
                  />
                }
                nativeButton={false}
                variant={connector === "google" && service === googleService ? "secondary" : "ghost"}
                size="sm"
                className={count === 0 ? "text-muted-foreground" : undefined}
              >
                {GOOGLE_SERVICE_LABEL[googleService]} ({count})
              </Button>
            );
          });
        }

        const count = countsByProvider[integration.provider] ?? 0;
        return [
          <Button
            key={integration.id}
            render={
              <Link
                href={projectDataHref({ date: selectedDay, connector: integration.provider, service: "all" })}
                data-testid={`connector-${integration.provider}`}
              />
            }
            nativeButton={false}
            variant={connector === integration.provider ? "secondary" : "ghost"}
            size="sm"
            className={count === 0 ? "text-muted-foreground" : undefined}
          >
            {PROVIDER_LABEL[integration.provider]} ({count})
          </Button>,
        ];
      })}
    </div>
  );
}
