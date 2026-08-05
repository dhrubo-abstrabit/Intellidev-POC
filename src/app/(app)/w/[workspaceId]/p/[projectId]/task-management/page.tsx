import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import { BOARD_STATUSES, type ActionItemRow, type SourceEvent, type WorkspaceMember } from "@/components/items/types";
import { parseTaskManagementSearchParams } from "./filters";
import { ViewToggle } from "./view-toggle";
import { ItemFilters } from "./item-filters";
import { ListView } from "./list-view";
import { BoardView } from "./board-view";
import { TaskDetailSheet } from "./task-detail-sheet";

export default async function TaskManagementPage({
  params,
  searchParams,
}: {
  params: Promise<{ workspaceId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { workspaceId, projectId } = await params;
  const rawSearchParams = await searchParams;
  const filters = parseTaskManagementSearchParams(rawSearchParams);
  const openItemId = Array.isArray(rawSearchParams.item) ? rawSearchParams.item[0] : rawSearchParams.item;
  const supabase = await createClient();

  let itemsQuery = supabase
    .from("action_items")
    .select(
      "id, title, description, kind, priority, confidence_score, status, for_date, due_at, owner_hint, assignee_id, snoozed_until, assignee:users!action_items_assignee_id_fkey(id, full_name, avatar_url)",
    )
    .eq("project_id", projectId);

  if (filters.q) {
    itemsQuery = itemsQuery.ilike("title", `%${filters.q}%`);
  }
  if (filters.priority.length > 0) {
    itemsQuery = itemsQuery.in("priority", filters.priority);
  }
  if (filters.kind.length > 0) {
    itemsQuery = itemsQuery.in("kind", filters.kind);
  }
  if (filters.assignee === "unassigned") {
    itemsQuery = itemsQuery.is("assignee_id", null);
  } else if (filters.assignee) {
    itemsQuery = itemsQuery.eq("assignee_id", filters.assignee);
  }

  // Kanban's four columns are the status filter; List uses the status param
  // (default pending/in_progress) — one query builder, so the two views
  // can't drift on the other filters' semantics.
  itemsQuery =
    filters.view === "kanban" ? itemsQuery.in("status", BOARD_STATUSES) : itemsQuery.in("status", filters.status);

  itemsQuery =
    filters.sort === "priority"
      ? itemsQuery.order("priority", { ascending: false }).order("for_date", { ascending: false })
      : itemsQuery.order("for_date", { ascending: false }).order("priority", { ascending: false });

  const [{ data: items }, { data: memberRows }, { count: snoozedCount }] = await Promise.all([
    itemsQuery,
    supabase
      .from("workspace_members")
      .select("users:users!workspace_members_user_id_fkey(id, full_name, email, avatar_url)")
      .eq("workspace_id", workspaceId),
    supabase
      .from("action_items")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "snoozed"),
  ]);

  const members: WorkspaceMember[] = (memberRows ?? [])
    .map((row) => row.users)
    .filter((user): user is NonNullable<typeof user> => user !== null);

  const rows: ActionItemRow[] = (items ?? []).map((item) => ({ ...item, assignee: item.assignee ?? null }));
  const openItem = rows.find((row) => row.id === openItemId) ?? null;

  // Only fetched when a detail sheet is actually open, and only for that one
  // item — the "why was this created" trail back to the Slack messages that
  // generated it, not something every row in the list/board needs.
  let sourceEvents: SourceEvent[] = [];
  if (openItem) {
    const { data: sourceRows } = await supabase
      .from("action_item_source_events")
      .select("normalized_events(id, type, actor, actor_display, title, body, occurred_at)")
      .eq("action_item_id", openItem.id);

    sourceEvents = (sourceRows ?? [])
      .map((row) => row.normalized_events)
      .filter((event): event is NonNullable<typeof event> => event !== null)
      .map((event) => ({
        id: event.id,
        type: event.type,
        actor: event.actor,
        actorDisplay: event.actor_display,
        title: event.title,
        body: event.body,
        occurredAt: event.occurred_at,
      }))
      .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-lg font-semibold">Task Tracking</h1>
          <p className="text-sm text-muted-foreground">Assign and track action items</p>
        </div>
        <ViewToggle view={filters.view} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2">
        <ItemFilters filters={filters} members={members} />
        {snoozedCount ? (
          <Link href="?view=list&status=snoozed" className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            Snoozed ({snoozedCount})
          </Link>
        ) : null}
      </div>

      {filters.view === "kanban" ? (
        <BoardView
          key={JSON.stringify({ q: filters.q, priority: filters.priority, kind: filters.kind, assignee: filters.assignee, sort: filters.sort })}
          workspaceId={workspaceId}
          projectId={projectId}
          items={rows}
          members={members}
        />
      ) : (
        <ListView workspaceId={workspaceId} projectId={projectId} items={rows} members={members} />
      )}

      <TaskDetailSheet
        item={openItem}
        sourceEvents={sourceEvents}
        workspaceId={workspaceId}
        projectId={projectId}
        members={members}
      />
    </div>
  );
}
