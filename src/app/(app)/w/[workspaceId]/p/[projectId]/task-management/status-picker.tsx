"use client";

import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import { BOARD_STATUSES, STATUS_LABEL, type ActionItemStatus, type BoardStatus } from "@/components/items/types";
import { updateActionItemStatus } from "./actions";

export function StatusPicker({
  workspaceId,
  projectId,
  itemId,
  status,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
  status: ActionItemStatus;
}) {
  const [isPending, startTransition] = useTransition();
  const isBoardStatus = (BOARD_STATUSES as readonly string[]).includes(status);

  function handleChange(next: BoardStatus) {
    if (next === status) return;
    startTransition(async () => {
      await toast
        .promise(updateActionItemStatus(workspaceId, projectId, itemId, next), {
          loading: "Updating status…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  return (
    <Select
      value={isBoardStatus ? status : undefined}
      onValueChange={(value) => handleChange(value as BoardStatus)}
      disabled={isPending}
    >
      <SelectTrigger size="sm" className="w-32">
        <SelectValue placeholder={STATUS_LABEL[status]} />
      </SelectTrigger>
      <SelectContent>
        {BOARD_STATUSES.map((boardStatus) => (
          <SelectItem key={boardStatus} value={boardStatus}>
            {STATUS_LABEL[boardStatus]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
