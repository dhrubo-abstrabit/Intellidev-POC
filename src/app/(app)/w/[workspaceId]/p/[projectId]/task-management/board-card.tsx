"use client";

import { useDraggable } from "@dnd-kit/core";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { PriorityBadge } from "@/components/items/status-badge";
import type { ActionItemRow } from "@/components/items/types";
import { cn } from "@/lib/utils";

/** Static, hook-free copy rendered inside DragOverlay — the real BoardCard
 * below can't be reused there since useDraggable would register a second
 * node under the same id as the card being dragged. */
export function BoardCardPreview({ item }: { item: ActionItemRow }) {
  const assigneeName = item.assignee?.name ?? null;
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

export function BoardCard({ item }: { item: ActionItemRow }) {
  const { attributes, listeners, setNodeRef, transform, isDragging } = useDraggable({ id: item.id });
  const assigneeName = item.assignee?.name ?? null;
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  // The whole card opens the detail sheet on click — dnd-kit's PointerSensor
  // only starts a drag once the pointer has moved past its activation
  // distance (see board-view.tsx), so a plain click (no movement between
  // pointerdown/up) still fires this normally rather than being swallowed by
  // drag detection.
  function openDetails() {
    const params = new URLSearchParams(searchParams.toString());
    params.set("item", item.id);
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  return (
    <div
      ref={setNodeRef}
      style={transform ? { transform: CSS.Translate.toString(transform) } : undefined}
      onClick={openDetails}
      className={cn(
        "cursor-pointer space-y-2 rounded-xl bg-card p-3 text-sm text-card-foreground ring-1 ring-foreground/10 transition-all",
        isDragging ? "z-10 opacity-40" : "hover:scale-[1.02] hover:shadow-md hover:ring-brand-teal-400",
      )}
      data-testid={`board-card-${item.id}`}
      {...attributes}
      {...listeners}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="font-medium">{item.title}</p>
        <GripVerticalIcon className="mt-0.5 size-4 shrink-0 cursor-grab text-muted-foreground" aria-hidden="true" />
      </div>
      <div className="flex items-center justify-between gap-2">
        <PriorityBadge priority={item.priority} />
        {assigneeName ? <span className="text-xs text-muted-foreground">{assigneeName}</span> : null}
      </div>
    </div>
  );
}
