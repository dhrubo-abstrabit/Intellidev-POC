import Link from "next/link";
import { createClient } from "@/lib/supabase/server";
import {
  BOARD_STATUSES,
  type ActionItemRow,
  type AssigneeOption,
  type AttachmentSummary,
  type SourceEvent,
} from "@/components/items/types";
import { decodeAssigneeValue, encodeAssigneeValue } from "@/components/items/assignee";
import { parseTaskManagementSearchParams } from "./filters";
import { ViewToggle } from "./view-toggle";
import { ItemFilters } from "./item-filters";
import { ListView } from "./list-view";
import { BoardView } from "./board-view";
import { TaskDetailSheet } from "./task-detail-sheet";

// The "Link" Server Action (actions.ts's linkTaskSource) calls the LLM
// provider synchronously to rewrite the task's description — same rationale
// as data/page.tsx's own maxDuration: a Server Action inherits the invoking
// route segment's config, and this route has one that can call Anthropic.
export const maxDuration = 60;

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
    .from("tasks")
    .select(
      "id, title, description, kind, priority, confidence, status, for_date, due_at, owner_hint, assignee_id, assignee_team_member_id, snoozed_until, assignee:users!tasks_assignee_id_fkey(id, full_name, avatar_url)",
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
    // Two mutually-exclusive assignee columns (see
    // tasks_single_assignee_chk) means "unassigned" has to rule out
    // both, not just assignee_id.
    itemsQuery = itemsQuery.is("assignee_id", null).is("assignee_team_member_id", null);
  } else if (filters.assignee) {
    const target = decodeAssigneeValue(filters.assignee);
    // An unrecognized value degrades to "ignored" rather than throwing —
    // same graceful-degradation rule a stale ?status= already gets under
    // view=kanban below.
    if (target?.kind === "user") itemsQuery = itemsQuery.eq("assignee_id", target.id);
    else if (target?.kind === "team_member") itemsQuery = itemsQuery.eq("assignee_team_member_id", target.id);
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

  const [{ data: items }, { data: memberRows }, { data: rosterRows }, { count: snoozedCount }] = await Promise.all([
    itemsQuery,
    supabase
      .from("workspace_members")
      .select("users:users!workspace_members_user_id_fkey(id, full_name, email, avatar_url)")
      .eq("workspace_id", workspaceId),
    supabase.from("team_members").select("id, name, email, role").eq("workspace_id", workspaceId),
    supabase
      .from("tasks")
      .select("id", { count: "exact", head: true })
      .eq("project_id", projectId)
      .eq("status", "snoozed"),
  ]);

  const users = (memberRows ?? [])
    .map((row) => row.users)
    .filter((user): user is NonNullable<typeof user> => user !== null);
  const roster = rosterRows ?? [];

  // Real workspace users first, then roster contacts — both alphabetical —
  // so the picker/filter can render two labeled groups (a bare name gives
  // no signal about whether that person can actually log in and see this
  // task; see assignee-picker.tsx).
  const assignees: AssigneeOption[] = [
    ...users
      .map((u) => ({
        kind: "user" as const,
        id: u.id,
        value: encodeAssigneeValue("user", u.id),
        name: u.full_name ?? u.email,
        email: u.email,
        avatar_url: u.avatar_url,
        role: null,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    ...roster
      .map((r) => ({
        kind: "team_member" as const,
        id: r.id,
        value: encodeAssigneeValue("team_member", r.id),
        name: r.name,
        email: r.email,
        avatar_url: null,
        role: r.role,
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
  ];
  // Roster contacts are always resolvable this way — assignee_team_member_id
  // is `on delete set null`, so a non-null value always has a live
  // team_members row in this workspace, already in `roster`. No second
  // PostgREST embed needed (an unverified composite-FK embed hint risks a
  // 400 on the whole page query for zero benefit over this free lookup).
  const rosterById = new Map(roster.map((r) => [r.id, r]));

  const rows: ActionItemRow[] = (items ?? []).map((item) => {
    const rosterContact = item.assignee_team_member_id ? rosterById.get(item.assignee_team_member_id) : undefined;
    const assignee = rosterContact
      ? {
          kind: "team_member" as const,
          id: rosterContact.id,
          value: encodeAssigneeValue("team_member", rosterContact.id),
          name: rosterContact.name,
          avatar_url: null,
        }
      : item.assignee
        ? {
            kind: "user" as const,
            id: item.assignee.id,
            value: encodeAssigneeValue("user", item.assignee.id),
            name: item.assignee.full_name,
            avatar_url: item.assignee.avatar_url,
          }
        : null;
    return { ...item, assignee };
  });
  const openItem = rows.find((row) => row.id === openItemId) ?? null;

  // Only fetched when a detail sheet is actually open, and only for that one
  // item — the "why was this created" trail back to the Slack messages that
  // generated it, not something every row in the list/board needs.
  let sourceEvents: SourceEvent[] = [];
  if (openItem) {
    const { data: sourceRows } = await supabase
      .from("task_sources")
      .select(
        "chunk_id, role, linked_by, linked_by_user:users!task_sources_linked_by_fkey(id, full_name), search_chunks(source_kind, source_id, page_number), normalized_events(id, type, actor, actor_display, title, body, occurred_at)",
      )
      .eq("task_id", openItem.id);

    // (task_id, normalized_event_id) is task_sources' primary key, so at
    // most one row per event — this map is exact, not a best-effort
    // last-write-wins the way pageNumberByAttachmentId below has to be.
    const roleAndLinkerByEventId = new Map<string, { role: SourceEvent["role"]; linkedBy: SourceEvent["linkedBy"] }>();
    for (const row of sourceRows ?? []) {
      const eventId = row.normalized_events?.id;
      if (!eventId) continue;
      roleAndLinkerByEventId.set(eventId, {
        role: row.role as SourceEvent["role"],
        linkedBy: row.linked_by_user ? { id: row.linked_by_user.id, name: row.linked_by_user.full_name } : null,
      });
    }

    const eventRows = (sourceRows ?? [])
      .map((row) => row.normalized_events)
      .filter((event): event is NonNullable<typeof event> => event !== null);
    const eventIds = eventRows.map((event) => event.id);

    // A task_sources row's chunk_id may resolve to a search_chunks row whose
    // source_kind is 'event_attachment' — its source_id IS the attachment's
    // own id (see search_chunks' own schema comment). That's the only case
    // page_number ever means anything, so this map is keyed by attachment
    // id, not event id: DOCX/Slack/plain-text chunks carry page_number null,
    // and a chunk_id resolving to a 'normalized_event' chunk has no
    // attachment to attach a page to at all.
    const pageNumberByAttachmentId = new Map<string, number>();
    for (const row of sourceRows ?? []) {
      const chunk = row.search_chunks;
      if (chunk?.source_kind === "event_attachment" && chunk.page_number != null) {
        pageNumberByAttachmentId.set(chunk.source_id, chunk.page_number);
      }
    }

    // Same shape as the Project Data tab's per-day attachment fetch — a
    // handful of source events per item, so one unchunked .in() is fine.
    const attachmentsByEvent = new Map<string, AttachmentSummary[]>();
    if (eventIds.length > 0) {
      const { data: attachmentRows } = await supabase
        .from("event_attachments")
        .select("id, normalized_event_id, filename, mime_type, size_bytes, status, skip_reason")
        .in("normalized_event_id", eventIds);
      for (const row of attachmentRows ?? []) {
        const list = attachmentsByEvent.get(row.normalized_event_id) ?? [];
        list.push({
          id: row.id,
          filename: row.filename,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes,
          status: row.status as AttachmentSummary["status"],
          skipReason: row.skip_reason,
          pageNumber: pageNumberByAttachmentId.get(row.id) ?? null,
        });
        attachmentsByEvent.set(row.normalized_event_id, list);
      }
    }

    sourceEvents = eventRows
      .map((event) => {
        // Always present in practice (every eventRow came from a
        // task_sources row this same query joined) — the fallback is
        // defensive, not an expected path.
        const roleAndLinker = roleAndLinkerByEventId.get(event.id) ?? { role: "mentioned" as const, linkedBy: null };
        return {
          id: event.id,
          type: event.type,
          actor: event.actor,
          actorDisplay: event.actor_display,
          title: event.title,
          body: event.body,
          occurredAt: event.occurred_at,
          role: roleAndLinker.role,
          linkedBy: roleAndLinker.linkedBy,
          attachments: attachmentsByEvent.get(event.id) ?? [],
        };
      })
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
        <ItemFilters filters={filters} assignees={assignees} />
        {snoozedCount ? (
          <Link href="?view=list&status=snoozed" className="text-xs text-brand-teal-600 underline-offset-2 hover:text-brand-teal-700 hover:underline">
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
        />
      ) : (
        <ListView workspaceId={workspaceId} projectId={projectId} items={rows} assignees={assignees} />
      )}

      <TaskDetailSheet
        item={openItem}
        sourceEvents={sourceEvents}
        workspaceId={workspaceId}
        projectId={projectId}
        assignees={assignees}
      />
    </div>
  );
}
