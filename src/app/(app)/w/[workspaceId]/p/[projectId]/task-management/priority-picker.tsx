"use client";

import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import type { ActionItemPriority } from "@/components/items/types";
import { ALL_PRIORITIES } from "./filters";
import { updateActionItemPriority } from "./actions";

export function PriorityPicker({
  workspaceId,
  projectId,
  itemId,
  priority,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
  priority: ActionItemPriority;
}) {
  const [isPending, startTransition] = useTransition();

  function handleChange(next: ActionItemPriority) {
    if (next === priority) return;
    startTransition(async () => {
      await toast
        .promise(updateActionItemPriority(workspaceId, projectId, itemId, next), {
          loading: "Updating priority…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  return (
    <Select value={priority} onValueChange={(value) => handleChange(value as ActionItemPriority)} disabled={isPending}>
      <SelectTrigger size="sm" className="w-28">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {ALL_PRIORITIES.map((p) => (
          <SelectItem key={p} value={p}>
            {p}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
