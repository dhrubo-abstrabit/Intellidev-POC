"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon, MaximizeIcon } from "lucide-react";
import { PriorityBadge } from "@/components/items/status-badge";
import type { ActionItemRow, WorkspaceMember } from "@/components/items/types";
import { cn } from "@/lib/utils";
import { OpenTaskLink } from "./open-task-link";

function assigneeNameFor(item: ActionItemRow, members: WorkspaceMember[]): string | null {
  return item.assignee?.full_name ?? members.find((member) => member.id === item.assignee_id)?.full_name ?? null;
}

/** Static, hook-free copy rendered inside DragOverlay — the real BoardCard
 * below can't be reused there since useDraggable would register a second
 * node under the same id as the card being dragged. */
export function BoardCardPreview({ item, members }: { item: ActionItemRow; members: WorkspaceMember[] }) {
  const assigneeName = assigneeNameFor(item, members);
  return (
    <div className="space-y-2 rounded-xl bg-card p-3 text-sm text-card-foreground shadow-lg ring-1 ring-foreground/10">
      <p className="font-medium">{item.title}</p>
      <div className="flex items-center justify-between gap-2">
        <PriorityBadge priority={item.priority} />
        {assigneeName ? <span className="text-xs text-muted-foreground">{assigneeName}</span> : null}
      </div>
    </div>
  );
}

export function BoardCard({ item, members }: { item: ActionItemRow; members: WorkspaceMember[] }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const assigneeName = assigneeNameFor(item, members);

  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      className={cn(
        "space-y-2 rounded-xl bg-card p-3 text-sm text-card-foreground ring-1 ring-foreground/10",
        isDragging && "z-10 opacity-40",
      )}
      data-testid={`board-card-${item.id}`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{item.title}</p>
        <div className="flex shrink-0 items-center gap-1">
          {/* Whole card is the drag handle (attributes/listeners spread on
           * the outer div above) — stop the pointerdown here so opening
           * details doesn't get swallowed by dnd-kit's drag detection. */}
          <OpenTaskLink
            itemId={item.id}
            onPointerDown={(event) => event.stopPropagation()}
            className="rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
            aria-label="View details"
            data-testid={`open-task-${item.id}`}
          >
            <MaximizeIcon className="size-3.5" aria-hidden="true" />
          </OpenTaskLink>
          <GripVerticalIcon className="mt-0.5 size-4 cursor-grab text-muted-foreground" aria-hidden="true" />
        </div>
      </div>
      <div className="flex items-center justify-between gap-2">
        <PriorityBadge priority={item.priority} />
        {assigneeName ? <span className="text-xs text-muted-foreground">{assigneeName}</span> : null}
      </div>
    </div>
  );
}
