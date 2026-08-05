import { Card, CardContent } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { formatItemDate } from "@/components/items/format";
import type { ActionItemRow, WorkspaceMember } from "@/components/items/types";
import { StatusPicker } from "./status-picker";
import { PriorityPicker } from "./priority-picker";
import { AssigneePicker } from "./assignee-picker";
import { SnoozeButton } from "./snooze-button";
import { OpenTaskLink } from "./open-task-link";

export function ListView({
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
  if (items.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted-foreground">
          No action items match these filters.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Title</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Priority</TableHead>
            <TableHead>Assignee</TableHead>
            <TableHead>Date</TableHead>
            <TableHead />
          </TableRow>
        </TableHeader>
        <TableBody>
          {items.map((item) => (
            <TableRow key={item.id} data-testid={`task-row-${item.id}`}>
              <TableCell className="max-w-xs whitespace-normal">
                <OpenTaskLink itemId={item.id} className="font-medium hover:underline" data-testid={`open-task-${item.id}`}>
                  {item.title}
                </OpenTaskLink>
                {item.description ? (
                  <div className="line-clamp-1 text-xs text-muted-foreground">{item.description}</div>
                ) : null}
              </TableCell>
              <TableCell>
                <StatusPicker workspaceId={workspaceId} projectId={projectId} itemId={item.id} status={item.status} />
              </TableCell>
              <TableCell>
                <PriorityPicker
                  workspaceId={workspaceId}
                  projectId={projectId}
                  itemId={item.id}
                  priority={item.priority}
                />
              </TableCell>
              <TableCell>
                <AssigneePicker
                  workspaceId={workspaceId}
                  projectId={projectId}
                  itemId={item.id}
                  assigneeId={item.assignee_id}
                  members={members}
                />
              </TableCell>
              <TableCell className="text-xs text-muted-foreground">{formatItemDate(item.for_date)}</TableCell>
              <TableCell>
                <SnoozeButton workspaceId={workspaceId} projectId={projectId} itemId={item.id} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </Card>
  );
}
