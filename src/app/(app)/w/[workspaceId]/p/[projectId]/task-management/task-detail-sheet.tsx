"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon, CalendarIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatItemDate } from "@/components/items/format";
import type { ActionItemRow, SourceEvent, WorkspaceMember } from "@/components/items/types";
import { StatusPicker } from "./status-picker";
import { PriorityPicker } from "./priority-picker";
import { AssigneePicker } from "./assignee-picker";
import { SnoozeButton } from "./snooze-button";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0 space-y-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div>{children}</div>
    </div>
  );
}

/** Controlled entirely by the ?item= URL param (set via OpenTaskLink) — no
 * local open/closed state, so a shared link opens straight to a task and
 * back/forward navigates in and out of it like any other page state. */
export function TaskDetailSheet({
  item,
  sourceEvents,
  workspaceId,
  projectId,
  members,
}: {
  item: ActionItemRow | null;
  sourceEvents: SourceEvent[];
  workspaceId: string;
  projectId: string;
  members: WorkspaceMember[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("item");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <Dialog open={item !== null} onOpenChange={(open) => !open && close()}>
      <DialogContent className="sm:max-w-xl">
        {item ? (
          <>
            <DialogHeader>
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="outline">{item.kind.replace("_", " ")}</Badge>
                <Badge variant="outline">{Math.round(item.confidence_score * 100)}% confidence</Badge>
              </div>
              <DialogTitle className="text-lg leading-snug">{item.title}</DialogTitle>
            </DialogHeader>

            <div className="grid grid-cols-2 gap-4">
              <Field label="Status">
                <StatusPicker workspaceId={workspaceId} projectId={projectId} itemId={item.id} status={item.status} />
              </Field>
              <Field label="Assignee">
                <AssigneePicker
                  workspaceId={workspaceId}
                  projectId={projectId}
                  itemId={item.id}
                  assigneeId={item.assignee_id}
                  members={members}
                />
              </Field>
              <Field label="Priority">
                <PriorityPicker
                  workspaceId={workspaceId}
                  projectId={projectId}
                  itemId={item.id}
                  priority={item.priority}
                />
              </Field>
              <Field label="Dates">
                <div className="flex items-center gap-2 text-sm">
                  <span className="inline-flex items-center gap-1.5">
                    <CalendarIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {formatItemDate(item.for_date)}
                  </span>
                  <ArrowRightIcon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
                  <span
                    className={cn("inline-flex items-center gap-1.5", !item.due_at && "text-muted-foreground")}
                  >
                    <CalendarIcon className="size-3.5 text-muted-foreground" aria-hidden="true" />
                    {item.due_at ? formatItemDate(item.due_at) : "Due"}
                  </span>
                </div>
              </Field>
              {item.owner_hint ? (
                <Field label="Suggested owner">
                  <p className="text-sm">{item.owner_hint}</p>
                </Field>
              ) : null}
              {item.snoozed_until ? (
                <Field label="Snoozed until">
                  <p className="text-sm">{formatItemDate(item.snoozed_until)}</p>
                </Field>
              ) : null}
            </div>

            <Field label="Description">
              <p className="text-sm whitespace-pre-wrap break-words text-foreground">
                {item.description ?? "No description."}
              </p>
            </Field>

            {sourceEvents.length > 0 ? (
              <Field label={`Source (${sourceEvents.length})`}>
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
                  {sourceEvents.map((event) => (
                    <div key={event.id} className="rounded-md bg-muted/50 p-2 text-sm">
                      <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                        <span>{event.actorDisplay ?? event.actor ?? "Unknown"}</span>
                        <span>{formatItemDate(event.occurredAt)}</span>
                      </div>
                      <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
                        {event.body ?? event.title ?? "(no content)"}
                      </p>
                    </div>
                  ))}
                </div>
              </Field>
            ) : null}

            <DialogFooter className="sm:justify-between">
              <SnoozeButton workspaceId={workspaceId} projectId={projectId} itemId={item.id} />
              <DialogClose render={<Button variant="outline" />}>Close</DialogClose>
            </DialogFooter>
          </>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}
