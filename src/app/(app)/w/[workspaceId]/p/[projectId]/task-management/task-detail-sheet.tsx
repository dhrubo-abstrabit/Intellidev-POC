"use client";

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowRightIcon, CalendarIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AttachmentRow } from "@/components/items/attachment-row";
import { cn } from "@/lib/utils";
import { formatItemDate } from "@/components/items/format";
import type { ActionItemRow, AssigneeOption, SourceEvent } from "@/components/items/types";
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

/**
 * Controlled entirely by the ?item= URL param (set via OpenTaskLink/
 * BoardCard) — no local open/closed state, so a shared link opens straight
 * to a task and back/forward navigates in and out of it like any other page
 * state.
 *
 * Wraps `children` (the filters+view content) in the positioning anchor:
 * the panel itself is `position: fixed`, but its top/left are measured off
 * that anchor's own on-screen position via getBoundingClientRect() rather
 * than a hardcoded offset — so it always starts exactly below the "Task
 * Tracking" heading and to the right of the sidebar, whatever their actual
 * rendered height/width happen to be, and — being `fixed`, not `absolute`
 * within a content-height wrapper — its height is the viewport itself, so
 * it never forces the outer page to scroll to see the rest of it.
 */
export function TaskDetailSheet({
  item,
  sourceEvents,
  workspaceId,
  projectId,
  assignees,
  children,
}: {
  item: ActionItemRow | null;
  sourceEvents: SourceEvent[];
  workspaceId: string;
  projectId: string;
  assignees: AssigneeOption[];
  children: React.ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const anchorRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; left: number } | null>(null);

  useLayoutEffect(() => {
    if (!item) return;
    // getBoundingClientRect() is viewport-relative — if the page was
    // scrolled down before this task was clicked, the anchor's measured
    // top would already be above the visible viewport (negative), and
    // with background scroll locked (below) there'd be no way to scroll up
    // to reach it. Reset to the top first so it always opens on-screen.
    window.scrollTo(0, 0);
    function measure() {
      const box = anchorRef.current?.getBoundingClientRect();
      if (box) setAnchor({ top: box.top, left: box.left });
    }
    measure();
    window.addEventListener("resize", measure);
    return () => window.removeEventListener("resize", measure);
  }, [item]);

  // Mounts already in place (translate-x-full/opacity-0), then flips to its
  // resting position a frame later so the transition classes actually have
  // something to animate from — a class present at mount never transitions.
  // Resetting back to false when `item` goes null is done during render
  // (React's documented pattern for adjusting state on a prop change, same
  // as item-filters.tsx/workspace-sidebar.tsx) rather than in the effect
  // below, which only ever schedules the deferred re-entry animation.
  const [entered, setEntered] = useState(false);
  const [wasOpen, setWasOpen] = useState(Boolean(item));
  if (Boolean(item) !== wasOpen) {
    setWasOpen(Boolean(item));
    if (!item) setEntered(false);
  }
  useEffect(() => {
    if (!item) return;
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, [item]);

  // The panel is `fixed` at a top/left measured once when it opens (see
  // above) — if the page behind it were still scrollable, scrolling it
  // would move the header/sidebar out from under that stale measurement
  // without the panel following. Locking body scroll while open avoids
  // that entirely, on top of being the expected behavior for a modal panel.
  useEffect(() => {
    if (!item) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [item]);

  function close() {
    const params = new URLSearchParams(searchParams.toString());
    params.delete("item");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div ref={anchorRef} className="relative">
      {children}
      {item && anchor ? (
        <div className="fixed right-0 bottom-0 z-40" style={{ top: anchor.top, left: anchor.left }}>
          <div
            className={cn("absolute inset-0 bg-black/10 transition-opacity", entered ? "opacity-100" : "opacity-0")}
            onClick={close}
            aria-hidden="true"
          />
          <div
            role="dialog"
            aria-modal="true"
            aria-label={item.title}
            className={cn(
              "absolute inset-0 z-10 flex flex-col overflow-y-auto border-l border-border bg-popover text-sm text-popover-foreground shadow-lg ring-1 ring-foreground/10 transition-transform duration-200 ease-out",
              entered ? "translate-x-0" : "translate-x-full",
            )}
          >
            <div className="border-b border-border p-4">
              <div className="mx-auto flex w-full max-w-4xl items-start justify-between gap-2">
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <Badge variant="outline">{item.kind.replace("_", " ")}</Badge>
                    <Badge variant="outline">{Math.round(item.confidence_score * 100)}% confidence</Badge>
                  </div>
                  <h2 className="font-heading text-lg leading-snug font-medium">{item.title}</h2>
                </div>
                <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={close}>
                  <XIcon aria-hidden="true" />
                </Button>
              </div>
            </div>

            <div className="mx-auto w-full max-w-4xl flex-1 space-y-4 p-4">
              <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
                <Field label="Status">
                  <StatusPicker workspaceId={workspaceId} projectId={projectId} itemId={item.id} status={item.status} />
                </Field>
                <Field label="Assignee">
                  <AssigneePicker
                    workspaceId={workspaceId}
                    projectId={projectId}
                    itemId={item.id}
                    assigneeValue={item.assignee?.value ?? null}
                    assignees={assignees}
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
                  <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2 transition-colors hover:border-brand-teal-400">
                    {sourceEvents.map((event) => (
                      <div key={event.id} className="rounded-md bg-muted/50 p-2 text-sm">
                        <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                          <span>{event.actorDisplay ?? event.actor ?? "Unknown"}</span>
                          <span>{formatItemDate(event.occurredAt)}</span>
                        </div>
                        <p className="mt-1 whitespace-pre-wrap break-words text-foreground">
                          {event.body ?? event.title ?? "(no content)"}
                        </p>
                        {event.attachments.map((attachment) => (
                          <AttachmentRow key={attachment.id} attachment={attachment} workspaceId={workspaceId} projectId={projectId} />
                        ))}
                      </div>
                    ))}
                  </div>
                </Field>
              ) : null}
            </div>

            <div className="border-t border-border bg-muted/50 p-4">
              <div className="mx-auto flex w-full max-w-4xl flex-col-reverse gap-2 sm:flex-row sm:justify-between">
                <SnoozeButton workspaceId={workspaceId} projectId={projectId} itemId={item.id} />
                <Button onClick={close}>Close</Button>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}
