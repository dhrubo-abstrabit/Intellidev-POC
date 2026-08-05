"use client";

import { useState, useTransition } from "react";
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragStartEvent,
} from "@dnd-kit/core";
import { toast } from "@/components/ui/toast";
import {
  BOARD_STATUSES,
  STATUS_LABEL,
  type ActionItemRow,
  type BoardStatus,
  type WorkspaceMember,
} from "@/components/items/types";
import { BoardColumn } from "./board-column";
import { BoardCardPreview } from "./board-card";
import { updateActionItemStatus } from "./actions";

type Columns = Record<BoardStatus, ActionItemRow[]>;

function bucketByStatus(items: ActionItemRow[]): Columns {
  const columns = Object.fromEntries(BOARD_STATUSES.map((status) => [status, [] as ActionItemRow[]])) as Columns;
  for (const item of items) {
    if ((BOARD_STATUSES as readonly string[]).includes(item.status)) {
      columns[item.status as BoardStatus].push(item);
    }
  }
  return columns;
}

export function BoardView({
  workspaceId,
  projectId,
  items,
  members,
}: {
  workspaceId: string;
  projectId: string;
  items: ActionItemRow[];
  members: WorkspaceMember[];
}) {
  // Seeded once from server props. After a successful drag, this state (not
  // the next revalidated props) stays the source of truth — see the plan's
  // reconciliation note: a filter change remounts this component with a new
  // key, a same-filter drag does not re-seed from props.
  const [columns, setColumns] = useState<Columns>(() => bucketByStatus(items));
  const [activeItem, setActiveItem] = useState<ActionItemRow | null>(null);
  const [, startTransition] = useTransition();

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor),
  );

  function findColumnOf(itemId: string): BoardStatus | undefined {
    return BOARD_STATUSES.find((status) => columns[status].some((item) => item.id === itemId));
  }

  function handleDragStart(event: DragStartEvent) {
    const sourceStatus = findColumnOf(String(event.active.id));
    setActiveItem(sourceStatus ? columns[sourceStatus].find((item) => item.id === event.active.id) ?? null : null);
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveItem(null);
    const { active, over } = event;
    if (!over) return;

    const itemId = String(active.id);
    // Only columns are droppable (cards are draggable-only), so over.id is
    // always a BoardStatus here — no ambiguity between "over a card" vs.
    // "over a column" to resolve.
    const destStatus = over.id as BoardStatus;
    const sourceStatus = findColumnOf(itemId);
    if (!sourceStatus || sourceStatus === destStatus) return;

    const sourceSnapshot = columns[sourceStatus];
    const destSnapshot = columns[destStatus];
    const movedItem = sourceSnapshot.find((item) => item.id === itemId);
    if (!movedItem) return;

    setColumns({
      ...columns,
      [sourceStatus]: sourceSnapshot.filter((item) => item.id !== itemId),
      [destStatus]: [...destSnapshot, { ...movedItem, status: destStatus }],
    });

    startTransition(async () => {
      await toast
        .promise(updateActionItemStatus(workspaceId, projectId, itemId, destStatus), {
          loading: `Moving to ${STATUS_LABEL[destStatus]}…`,
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Could not move item"),
        })
        .catch(() => {
          setColumns((current) => ({
            ...current,
            [sourceStatus]: sourceSnapshot,
            [destStatus]: destSnapshot,
          }));
        });
    });
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {BOARD_STATUSES.map((status) => (
          <BoardColumn key={status} status={status} items={columns[status]} members={members} />
        ))}
      </div>
      <DragOverlay>{activeItem ? <BoardCardPreview item={activeItem} members={members} /> : null}</DragOverlay>
    </DndContext>
  );
}
