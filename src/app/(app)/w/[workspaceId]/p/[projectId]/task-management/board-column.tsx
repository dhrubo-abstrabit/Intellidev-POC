"use client";

import { useDroppable } from "@dnd-kit/core";
import { cn } from "@/lib/utils";
import { STATUS_LABEL, type ActionItemRow, type BoardStatus, type WorkspaceMember } from "@/components/items/types";
import { BoardCard } from "./board-card";

export function BoardColumn({
  status,
  items,
  members,
}: {
  status: BoardStatus;
  items: ActionItemRow[];
  members: WorkspaceMember[];
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });

  return (
    <div
      ref={setNodeRef}
      className={cn(
        "flex min-h-40 flex-col gap-2 rounded-xl border bg-muted/30 p-2 transition-colors",
        isOver && "bg-muted/60 ring-2 ring-ring/40",
      )}
      data-testid={`board-column-${status}`}
    >
      <div className="flex items-center justify-between px-1">
        <span className="text-sm font-medium">{STATUS_LABEL[status]}</span>
        <span className="text-xs text-muted-foreground">{items.length}</span>
      </div>
      <div className="flex flex-col gap-2">
        {items.map((item) => (
          <BoardCard key={item.id} item={item} members={members} />
        ))}
      </div>
    </div>
  );
}
