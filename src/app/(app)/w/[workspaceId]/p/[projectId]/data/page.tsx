import { createClient } from "@/lib/supabase/server";
import { isoDaysAgo, projectDayKey, projectToday, utcWindowForDay } from "@/lib/date/project-day";
import { isGoogleService, type ConnectorProvider, type GoogleService } from "@/components/items/provider-badge";
import { parseProjectDataSearchParams } from "./filters";
import { DayRail } from "./day-rail";
import { ConnectorStrip } from "./connector-strip";
import { DayLinkage } from "./day-linkage";
import type { DayActionPoint, DayEvent, DayIndexEntry, IntegrationSummary } from "./types";

// The manual "Extract for this day" button below runs generateActionItems
// synchronously in a Server Action rather than through the QStash-queued
// /api/jobs/llm route — see actions.ts's doc comment — so this route needs
// the same extended budget that route sets for its own Anthropic calls.
export const maxDuration = 60;

// The rail only shows days that actually have activity in this window, not
// a fixed empty calendar grid — a project with sparse history gets a short,
// honest rail instead of 60 mostly-blank rows.
const DAY_INDEX_LOOKBACK_DAYS = 60;
const DAY_INDEX_ROW_LIMIT = 5000;

/** Which Google sub-services a merged `google` integration currently has
 * enabled — `null` in its config means off (see connectors/google/config.ts).
 * Read here rather than imported from the connector so this page doesn't pull
 * a server-only connector module in just for three key lookups. */
function enabledGoogleServices(config: unknown): GoogleService[] {
  if (!config || typeof config !== "object") return [];
  const record = config as Record<string, unknown>;
  return (["gmail", "drive", "chat"] as GoogleService[]).filter((service) => {
    const sub = record[service];
    return Boolean(sub) && typeof sub === "object";
  });
}

/** normalized_events.metadata is untyped jsonb — only the merged Google
 * connector's normalize() writes a `service` tag, and only with one of three
 * known values. */
function serviceFromMetadata(metadata: unknown): GoogleService | null {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).service;
  return isGoogleService(value) ? value : null;
}

export default async function ProjectDataPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, projectId } = await params;
  const rawSearchParams = await searchParams;
  const filters = parseProjectDataSearchParams(rawSearchParams);
  const supabase = await createClient();

  // The parent layout only selects (id, name); the timezone that drives
  // every day boundary on this page is fetched here instead of widening
  // that shared query for a value only this tab needs.
  const { data: project } = await supabase
    .from("projects")
    .select("timezone")
    .eq("id", projectId)
    .eq("workspace_id", workspaceId)
    .maybeSingle();
  const timezone = project?.timezone ?? "UTC";

  const lookbackCutoff = isoDaysAgo(DAY_INDEX_LOOKBACK_DAYS);

  const [{ data: dayIndexRows }, { data: integrationRows }] = await Promise.all([
    supabase
      .from("normalized_events")
      .select("occurred_at, provider")
      .eq("project_id", projectId)
      .gte("occurred_at", lookbackCutoff)
      .order("occurred_at", { ascending: false })
      .limit(DAY_INDEX_ROW_LIMIT),
    supabase
      .from("integrations")
      .select("id, provider, status, display_name, config")
      .eq("project_id", projectId)
      .order("provider"),
  ]);

  const dayIndexMap = new Map<string, { total: number; byProvider: Partial<Record<ConnectorProvider, number>> }>();
  for (const row of dayIndexRows ?? []) {
    const dayKey = projectDayKey(row.occurred_at, timezone);
    const entry = dayIndexMap.get(dayKey) ?? { total: 0, byProvider: {} };
    entry.total += 1;
    entry.byProvider[row.provider] = (entry.byProvider[row.provider] ?? 0) + 1;
    dayIndexMap.set(dayKey, entry);
  }
  const sortedDayKeys = Array.from(dayIndexMap.keys()).sort((a, b) => b.localeCompare(a));
  const dayIndex: DayIndexEntry[] = sortedDayKeys.map((dayKey) => ({ dayKey, ...dayIndexMap.get(dayKey)! }));

  // An explicit ?date= only wins if that day actually has activity in the
  // indexed window — otherwise fall back to the most recent active day, or
  // today if the project has no activity at all. A stale/hand-edited date
  // degrades gracefully rather than erroring.
  const selectedDay = filters.date && dayIndexMap.has(filters.date) ? filters.date : sortedDayKeys[0] ?? projectToday(timezone);

  const truncated = (dayIndexRows?.length ?? 0) >= DAY_INDEX_ROW_LIMIT;

  const integrations: IntegrationSummary[] = (integrationRows ?? []).map((row) => ({
    id: row.id,
    provider: row.provider,
    status: row.status,
    displayName: row.display_name,
    googleServices: row.provider === "google" ? enabledGoogleServices(row.config) : [],
  }));

  const window = utcWindowForDay(selectedDay);
  const { data: eventRows } = await supabase
    .from("normalized_events")
    .select("id, provider, type, actor, actor_display, title, body, occurred_at, resource_url, processed_at, metadata")
    .eq("project_id", projectId)
    .gte("occurred_at", window.gte)
    .lt("occurred_at", window.lt)
    .order("occurred_at", { ascending: true });

  // The query above deliberately over-fetches a day on either side (see
  // utcWindowForDay) because a project-local day isn't a UTC day — this is
  // the filter that actually buckets rows into the selected local day.
  const dayEvents: DayEvent[] = (eventRows ?? [])
    .filter((row) => projectDayKey(row.occurred_at, timezone) === selectedDay)
    .map((row) => ({
      id: row.id,
      provider: row.provider,
      service: serviceFromMetadata(row.metadata),
      type: row.type,
      actor: row.actor,
      actorDisplay: row.actor_display,
      title: row.title,
      body: row.body,
      occurredAt: row.occurred_at,
      resourceUrl: row.resource_url,
      processed: row.processed_at !== null,
    }));

  const dayEventIds = dayEvents.map((event) => event.id);

  // Action points are grouped by *source message day*, not by
  // action_items.for_date (the day the LLM run happened) — an item citing
  // messages from two days will legitimately appear on both; that's correct
  // given the message->action-point provenance this tab exists to show, not
  // a bug to "fix" by switching back to for_date.
  let dayActionPoints: DayActionPoint[] = [];
  if (dayEventIds.length > 0) {
    const { data: sourceRows } = await supabase
      .from("action_item_source_events")
      .select(
        "normalized_event_id, action_items!inner(id, title, description, kind, priority, confidence_score, status, for_date, due_at, owner_hint)",
      )
      .in("normalized_event_id", dayEventIds);

    const itemsById = new Map<string, DayActionPoint>();
    for (const row of sourceRows ?? []) {
      const item = row.action_items;
      if (!item) continue;
      const existing = itemsById.get(item.id);
      if (existing) {
        existing.sourceEventIds.push(row.normalized_event_id);
        continue;
      }
      itemsById.set(item.id, {
        id: item.id,
        title: item.title,
        description: item.description,
        kind: item.kind,
        priority: item.priority,
        confidenceScore: item.confidence_score,
        status: item.status,
        forDate: item.for_date,
        dueAt: item.due_at,
        ownerHint: item.owner_hint,
        sourceEventIds: [row.normalized_event_id],
      });
    }
    dayActionPoints = Array.from(itemsById.values());
  }

  // Connector-strip counts reflect every provider active on this day,
  // regardless of the current connector filter, so switching connectors
  // doesn't change the numbers on the chips themselves.
  const countsByProvider: Partial<Record<string, number>> = {};
  const countsByGoogleService: Partial<Record<string, number>> = {};
  for (const event of dayEvents) {
    countsByProvider[event.provider] = (countsByProvider[event.provider] ?? 0) + 1;
    if (event.provider === "google" && event.service) {
      countsByGoogleService[event.service] = (countsByGoogleService[event.service] ?? 0) + 1;
    }
  }

  // Two independent dimensions: `connector` narrows by provider, `service`
  // additionally narrows a google integration's events by which sub-service
  // produced them (the three used to be three providers — see filters.ts).
  const filteredEvents = dayEvents.filter((event) => {
    if (filters.connector !== "all" && event.provider !== filters.connector) return false;
    if (filters.service !== "all" && event.service !== filters.service) return false;
    return true;
  });
  const filteredEventIds = new Set(filteredEvents.map((event) => event.id));
  const filteredActionPoints =
    filters.connector === "all" && filters.service === "all"
      ? dayActionPoints
      : dayActionPoints.filter((item) => item.sourceEventIds.some((id) => filteredEventIds.has(id)));

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-lg font-semibold">Project Data</h1>
        <p className="text-sm text-muted-foreground">
          Browse ingested messages day by day, connector by connector, and see what was extracted from them.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-[220px_1fr]">
        <div className="space-y-2">
          <h2 className="text-xs font-medium text-muted-foreground uppercase">
            Days {truncated ? `(last ${DAY_INDEX_LOOKBACK_DAYS}d, truncated)` : `(last ${DAY_INDEX_LOOKBACK_DAYS}d)`}
          </h2>
          <DayRail days={dayIndex} selectedDay={selectedDay} connector={filters.connector} service={filters.service} />
        </div>

        <div className="space-y-4">
          <ConnectorStrip
            integrations={integrations}
            countsByProvider={countsByProvider}
            countsByGoogleService={countsByGoogleService}
            totalCount={dayEvents.length}
            selectedDay={selectedDay}
            connector={filters.connector}
            service={filters.service}
            workspaceId={workspaceId}
            projectId={projectId}
          />

          <DayLinkage
            events={filteredEvents}
            actionPoints={filteredActionPoints}
            timezone={timezone}
            workspaceId={workspaceId}
            projectId={projectId}
            selectedDay={selectedDay}
          />
        </div>
      </div>
    </div>
  );
}
