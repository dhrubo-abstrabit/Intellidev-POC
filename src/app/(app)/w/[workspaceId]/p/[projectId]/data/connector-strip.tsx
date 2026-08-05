import Link from "next/link";
import { Button } from "@/components/ui/button";
import { PROVIDER_LABEL } from "@/components/items/provider-badge";
import { projectDataHref, type ProjectDataFilters } from "./filters";
import type { IntegrationSummary } from "./types";

/** Server Component, same href-building approach as DayRail. Shows this
 * project's connected integrations only (not every connector_provider enum
 * value, most of which have no connector implementation yet) — a connected
 * connector with zero events on the selected day still gets a chip, just
 * with a "0" count, so "nothing came in from Drive today" is visible rather
 * than the connector silently not appearing. */
export function ConnectorStrip({
  integrations,
  countsByProvider,
  totalCount,
  selectedDay,
  connector,
  workspaceId,
  projectId,
}: {
  integrations: IntegrationSummary[];
  countsByProvider: Partial<Record<string, number>>;
  totalCount: number;
  selectedDay: string;
  connector: ProjectDataFilters["connector"];
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
        render={<Link href={projectDataHref({ date: selectedDay, connector: "all" })} data-testid="connector-all" />}
        nativeButton={false}
        variant={connector === "all" ? "secondary" : "ghost"}
        size="sm"
      >
        All ({totalCount})
      </Button>
      {integrations.map((integration) => {
        const count = countsByProvider[integration.provider] ?? 0;
        return (
          <Button
            key={integration.id}
            render={
              <Link
                href={projectDataHref({ date: selectedDay, connector: integration.provider })}
                data-testid={`connector-${integration.provider}`}
              />
            }
            nativeButton={false}
            variant={connector === integration.provider ? "secondary" : "ghost"}
            size="sm"
            className={count === 0 ? "text-muted-foreground" : undefined}
          >
            {PROVIDER_LABEL[integration.provider]} ({count})
          </Button>
        );
      })}
    </div>
  );
}
