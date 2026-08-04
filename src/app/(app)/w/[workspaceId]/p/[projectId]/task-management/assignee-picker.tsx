"use client";

import { useTransition } from "react";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import type { WorkspaceMember } from "@/components/items/types";
import { updateActionItemAssignee } from "./actions";

const UNASSIGNED = "__unassigned__";

export function AssigneePicker({
  workspaceId,
  projectId,
  itemId,
  assigneeId,
  members,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
  assigneeId: string | null;
  members: WorkspaceMember[];
}) {
  const [isPending, startTransition] = useTransition();

  function handleChange(value: string) {
    const nextId = value === UNASSIGNED ? null : value;
    if (nextId === assigneeId) return;
    startTransition(async () => {
      await toast
        .promise(updateActionItemAssignee(workspaceId, projectId, itemId, nextId), {
          loading: "Updating assignee…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  return (
    <Select value={assigneeId ?? UNASSIGNED} onValueChange={(value) => handleChange(String(value))} disabled={isPending}>
      <SelectTrigger size="sm" className="w-36">
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED}>Unassigned</SelectItem>
        {members.map((member) => (
          <SelectItem key={member.id} value={member.id}>
            {member.full_name ?? member.email}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
