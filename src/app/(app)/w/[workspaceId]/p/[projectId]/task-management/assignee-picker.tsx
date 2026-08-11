"use client";

import { useTransition } from "react";
import { Select, SelectContent, SelectGroup, SelectItem, SelectLabel, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "@/components/ui/toast";
import type { AssigneeOption } from "@/components/items/types";
import { UNASSIGNED_VALUE } from "@/components/items/assignee";
import { updateActionItemAssignee } from "./actions";

export function AssigneePicker({
  workspaceId,
  projectId,
  itemId,
  assigneeValue,
  assignees,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
  assigneeValue: string | null;
  assignees: AssigneeOption[];
}) {
  const [isPending, startTransition] = useTransition();

  function handleChange(value: string) {
    const nextValue = value === UNASSIGNED_VALUE ? null : value;
    if (nextValue === assigneeValue) return;
    startTransition(async () => {
      await toast
        .promise(updateActionItemAssignee(workspaceId, projectId, itemId, nextValue), {
          loading: "Updating assignee…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .catch(() => {});
    });
  }

  const workspaceMembers = assignees.filter((a) => a.kind === "user");
  const rosterContacts = assignees.filter((a) => a.kind === "team_member");

  // Select.Value can only render the name instead of the raw value when it
  // knows the full value->label mapping up front — without `items`, a value
  // set from a prop (rather than clicked live in this session) falls back
  // to printing the raw value. Flat regardless of the grouping below, since
  // SelectValue's lookup needs every selectable value either way.
  const items = [
    { label: "Unassigned", value: UNASSIGNED_VALUE },
    ...assignees.map((a) => ({ label: a.name, value: a.value })),
  ];

  return (
    <Select
      items={items}
      value={assigneeValue ?? UNASSIGNED_VALUE}
      onValueChange={(value) => handleChange(String(value))}
      disabled={isPending}
    >
      <SelectTrigger size="sm" className="w-36">
        <SelectValue placeholder="Unassigned" />
      </SelectTrigger>
      <SelectContent>
        <SelectItem value={UNASSIGNED_VALUE}>Unassigned</SelectItem>
        {workspaceMembers.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Workspace members</SelectLabel>
            {workspaceMembers.map((member) => (
              <SelectItem key={member.value} value={member.value}>
                {member.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
        {rosterContacts.length > 0 ? (
          <SelectGroup>
            <SelectLabel>Team roster</SelectLabel>
            {rosterContacts.map((contact) => (
              <SelectItem key={contact.value} value={contact.value}>
                {contact.name}
              </SelectItem>
            ))}
          </SelectGroup>
        ) : null}
      </SelectContent>
    </Select>
  );
}
