import { notFound } from "next/navigation";
import { createClient } from "@/lib/supabase/server";
import { resolveProjectScope } from "@/lib/scope";
import { isoDaysAgo, projectDayKey, projectToday, utcWindowForDay } from "@/lib/date/project-day";
import { isGoogleService, type ConnectorProvider, type GoogleService } from "@/components/items/provider-badge";
import { parseProjectDataSearchParams } from "./filters";
import { DayPicker } from "./day-picker";
import { ConnectorStrip } from "./connector-strip";
import { DayLinkage } from "./day-linkage";
import type { AttachmentSummary } from "@/components/items/types";
import type { DayActionPoint, DayEvent, DayIndexEntry, IntegrationSummary } from "./types";

// The manual "Extract for this day" button below runs generateActionItems
// synchronously in a Server Action rather than through the pgmq-queued
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

  // timezone moved off `projects` onto `client_spaces` (see
  // src/lib/scope.ts) — normalized_events and integrations key on
  // client_space_id now too, not project_id.
  const scope = await resolveProjectScope(workspaceId, projectId);
  if (!scope) {
    notFound();
  }
  const { clientSpaceId, timezone } = scope;

  const supabase = await createClient();

  const lookbackCutoff = isoDaysAgo(DAY_INDEX_LOOKBACK_DAYS);

  const [{ data: dayIndexRows }, { data: integrationRows }] = await Promise.all([
    supabase
      .from("normalized_events")
      .select("occurred_at, provider")
      .eq("client_space_id", clientSpaceId)
      .gte("occurred_at", lookbackCutoff)
      .order("occurred_at", { ascending: false })
      .limit(DAY_INDEX_ROW_LIMIT),
    supabase
      .from("integrations")
      .select("id, provider, status, display_name, config")
      .eq("client_space_id", clientSpaceId)
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

  // An explicit ?date= wins outright now that the day picker includes a
  // calendar for jumping to any date, not just ones with indexed activity —
  // a day with zero events already renders a clean empty state (see
  // DayLinkage), so there's nothing to degrade. Falls back to the most
  // recent active day, or today, only when no date was requested at all.
  const selectedDay = filters.date ?? sortedDayKeys[0] ?? projectToday(timezone);

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
    .eq("client_space_id", clientSpaceId)
    .gte("occurred_at", window.gte)
    .lt("occurred_at", window.lt)
    .order("occurred_at", { ascending: true });

  // The query above deliberately over-fetches a day on either side (see
  // utcWindowForDay) because a project-local day isn't a UTC day — this is
  // the filter that actually buckets rows into the selected local day.
  const dayRows = (eventRows ?? []).filter((row) => projectDayKey(row.occurred_at, timezone) === selectedDay);
  const dayEventIds = dayRows.map((row) => row.id);

  // Grouped by normalized_event_id ahead of the map below so each DayEvent
  // gets its own attachments without a per-row query. One event carrying
  // more than one file (a Slack message with two uploads, a multi-attachment
  // email) is the reason this is a list, not a single nullable column.
  const attachmentsByEvent = new Map<string, AttachmentSummary[]>();
  if (dayEventIds.length > 0) {
    const { data: attachmentRows } = await supabase
      .from("event_attachments")
      .select("id, normalized_event_id, filename, mime_type, size_bytes, status, skip_reason")
      .in("normalized_event_id", dayEventIds);
    for (const row of attachmentRows ?? []) {
      const list = attachmentsByEvent.get(row.normalized_event_id) ?? [];
      list.push({
        id: row.id,
        filename: row.filename,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        status: row.status as AttachmentSummary["status"],
        skipReason: row.skip_reason,
      });
      attachmentsByEvent.set(row.normalized_event_id, list);
    }
  }

  const dayEvents: DayEvent[] = dayRows.map((row) => ({
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
    attachments: attachmentsByEvent.get(row.id) ?? [],
  }));

  // Action points are grouped by *source message day*, not by
  // tasks.for_date (the day the LLM run happened) — an item citing
  // messages from two days will legitimately appear on both; that's correct
  // given the message->action-point provenance this tab exists to show, not
  // a bug to "fix" by switching back to for_date.
  let dayActionPoints: DayActionPoint[] = [];
  if (dayEventIds.length > 0) {
    const { data: sourceRows } = await supabase
      .from("task_sources")
      .select(
        "normalized_event_id, tasks!inner(id, title, description, kind, priority, confidence, status, for_date, due_at, owner_hint)",
      )
      .in("normalized_event_id", dayEventIds);

    const itemsById = new Map<string, DayActionPoint>();
    for (const row of sourceRows ?? []) {
      const item = row.tasks;
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
        confidenceScore: item.confidence,
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

      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-border bg-card px-4 py-2.5">
          <DayPicker days={dayIndex} selectedDay={selectedDay} connector={filters.connector} service={filters.service} />
          <span className="text-sm text-muted-foreground">
            {dayEvents.length} message{dayEvents.length === 1 ? "" : "s"}
            {truncated ? ` · last ${DAY_INDEX_LOOKBACK_DAYS}d truncated` : ""}
          </span>
        </div>

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
  );
}
