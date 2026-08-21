"use client";

import { useState } from "react";
import Link from "next/link";
import { ChevronDownIcon } from "lucide-react";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleTrigger, CollapsiblePanel } from "@/components/ui/collapsible";
import { ProviderBadge } from "@/components/items/provider-badge";
import { PriorityBadge, StatusBadge } from "@/components/items/status-badge";
import { AttachmentRow } from "@/components/items/attachment-row";
import { AsyncButton } from "@/components/dashboard/async-button";
import { cn } from "@/lib/utils";
import { projectTimeLabel } from "@/lib/date/project-day";
import { extractActionItemsForDay } from "./actions";
import type { DayActionPoint, DayEvent } from "./types";

type Focus = { kind: "event" | "item"; id: string } | null;

// Gmail and Drive bodies routinely run to thousands of characters (even after
// normalize.ts's own clamp) and dominate the message list's height — every
// other provider's body is short enough that hiding it by default would just
// cost an extra click for no space savings.
function isLongBodyProvider(provider: DayEvent["provider"], service: DayEvent["service"]): boolean {
  if (provider === "gmail" || provider === "google_drive") return true;
  return provider === "google" && (service === "gmail" || service === "drive");
}

/**
 * The two-column message <-> action-point panel, and the only client
 * component in this route. Day and connector selection live in searchParams
 * (see filters.ts) because they're worth sharing and worth back/forward
 * navigating — that's the repo's usual URL-is-the-only-state rule (see
 * task-management/item-filters.tsx). The click-to-highlight focus here is
 * deliberately local useState instead: it's ephemeral (nobody shares a link
 * to "message #3 highlighted"), and round-tripping it through the server
 * would re-run every query in page.tsx on each click for no benefit.
 */
export function DayLinkage({
  events,
  actionPoints,
  timezone,
  workspaceId,
  projectId,
  selectedDay,
}: {
  events: DayEvent[];
  actionPoints: DayActionPoint[];
  timezone: string;
  workspaceId: string;
  projectId: string;
  selectedDay: string;
}) {
  const [focus, setFocus] = useState<Focus>(null);

  // `focus` is deliberately not reset by a day/connector navigation (see the
  // doc comment above) — but it must not survive past the data it points at.
  // Derived at render time rather than reset via an effect: navigating to a
  // day where the focused id doesn't exist would otherwise leave every
  // remaining item hitting the "not the focused one" branch, i.e. everything
  // renders dimmed with nothing actually highlighted.
  const focusStillExists =
    focus === null
      ? true
      : focus.kind === "event"
        ? events.some((event) => event.id === focus.id)
        : actionPoints.some((item) => item.id === focus.id);
  const activeFocus = focusStillExists ? focus : null;

  function toggle(next: Focus) {
    setFocus((current) => (current && next && current.kind === next.kind && current.id === next.id ? null : next));
  }

  function eventClass(eventId: string): string {
    if (!activeFocus) return "";
    if (activeFocus.kind === "event") return activeFocus.id === eventId ? "ring-2 ring-ring/40" : "opacity-40";
    // activeFocus.kind === "item": highlight this event if it's one of the focused item's sources.
    const focusedItem = actionPoints.find((item) => item.id === activeFocus.id);
    return focusedItem?.sourceEventIds.includes(eventId) ? "ring-1 ring-foreground/30" : "opacity-40";
  }

  function itemClass(item: DayActionPoint): string {
    if (!activeFocus) return "";
    if (activeFocus.kind === "item") return activeFocus.id === item.id ? "ring-2 ring-ring/40" : "opacity-40";
    // activeFocus.kind === "event": highlight action points sourced from the focused event.
    return item.sourceEventIds.includes(activeFocus.id) ? "ring-1 ring-foreground/30" : "opacity-40";
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Messages ({events.length})</CardTitle>
        </CardHeader>
        <CardContent className="space-y-2">
          {events.length === 0 ? (
            <p className="text-sm text-muted-foreground">No messages for this day and connector.</p>
          ) : (
            events.map((event) => {
              const collapsible = isLongBodyProvider(event.provider, event.service);
              const hasBody = Boolean(event.body) || event.attachments.length > 0;

              const header = (
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <ProviderBadge provider={event.provider} service={event.service} />
                    {projectTimeLabel(event.occurredAt, timezone)}
                  </span>
                  <span className="flex items-center gap-1.5">
                    {!event.processed ? (
                      <span className="text-muted-foreground/70">Not yet processed</span>
                    ) : null}
                    {collapsible && hasBody ? (
                      <CollapsibleTrigger
                        aria-label="Toggle message body"
                        data-testid={`toggle-body-${event.id}`}
                        onClick={(e) => e.stopPropagation()}
                        onKeyDown={(e) => e.stopPropagation()}
                        className="flex size-5 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <ChevronDownIcon className="size-3.5 transition-transform group-data-panel-open:rotate-180" />
                      </CollapsibleTrigger>
                    ) : null}
                  </span>
                </div>
              );

              const actorLine = (
                <p className="mt-1 font-medium text-foreground">
                  {event.actorDisplay ?? event.actor ?? "Unknown"}
                  {event.title ? <span className="text-muted-foreground"> · {event.title}</span> : null}
                </p>
              );

              const body = (
                <>
                  {event.body ? (
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-muted-foreground">{event.body}</p>
                  ) : null}
                  {event.attachments.map((attachment) => (
                    <AttachmentRow key={attachment.id} attachment={attachment} workspaceId={workspaceId} projectId={projectId} />
                  ))}
                </>
              );

              return (
                // A <div role="button">, not a real <button> — AttachmentRow's
                // own Preview control is a real <button>, and nesting a
                // <button> inside a <button> is invalid HTML that browsers
                // silently mangle (the inner control loses its click). Keyboard
                // activation (Enter/Space) is wired by hand to keep the same
                // affordance a native button gave for free.
                <div
                  key={event.id}
                  role="button"
                  tabIndex={0}
                  data-testid={`event-${event.id}`}
                  onClick={() => toggle({ kind: "event", id: event.id })}
                  onKeyDown={(e) => {
                    if (e.key !== "Enter" && e.key !== " ") return;
                    e.preventDefault();
                    toggle({ kind: "event", id: event.id });
                  }}
                  className={cn(
                    "w-full cursor-pointer rounded-lg bg-muted/30 p-2.5 text-left text-sm ring-1 ring-foreground/10 transition-all",
                    eventClass(event.id),
                  )}
                >
                  {collapsible ? (
                    <Collapsible defaultOpen={false}>
                      {header}
                      {actorLine}
                      {hasBody ? <CollapsiblePanel>{body}</CollapsiblePanel> : null}
                    </Collapsible>
                  ) : (
                    <>
                      {header}
                      {actorLine}
                      {body}
                    </>
                  )}
                </div>
              );
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Action Points ({actionPoints.length})</CardTitle>
          <CardAction>
            <AsyncButton
              action={extractActionItemsForDay.bind(null, workspaceId, projectId, selectedDay)}
              loadingMessage={`Extracting for ${selectedDay}…`}
              size="sm"
              data-testid="extract-day-action-points"
            >
              Extract for this day
            </AsyncButton>
          </CardAction>
        </CardHeader>
        <CardContent className="space-y-2">
          {actionPoints.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              {events.length === 0 ? "No messages to extract from." : "Nothing extracted from these messages yet."}
            </p>
          ) : (
            actionPoints.map((item) => (
              <div
                key={item.id}
                data-testid={`action-point-${item.id}`}
                className={cn(
                  "rounded-lg bg-muted/30 p-2.5 text-sm ring-1 ring-foreground/10 transition-all",
                  itemClass(item),
                )}
              >
                <button type="button" onClick={() => toggle({ kind: "item", id: item.id })} className="w-full text-left">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <Badge variant="outline">{item.kind.replace("_", " ")}</Badge>
                    <Badge variant="outline">{Math.round(item.confidenceScore * 100)}% confidence</Badge>
                    <PriorityBadge priority={item.priority} />
                    <StatusBadge status={item.status} />
                  </div>
                  <p className="mt-1 font-medium text-foreground">{item.title}</p>
                  {item.description ? (
                    <p className="mt-0.5 line-clamp-2 break-words text-muted-foreground">{item.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    from {item.sourceEventIds.length} message{item.sourceEventIds.length === 1 ? "" : "s"}
                  </p>
                </button>
                <Link
                  href={`/w/${workspaceId}/p/${projectId}/task-management?item=${item.id}`}
                  className="mt-1.5 inline-block text-xs text-brand-teal-600 underline underline-offset-2 hover:text-brand-teal-700"
                  onClick={(e) => e.stopPropagation()}
                  data-testid={`open-task-${item.id}`}
                >
                  Open in Task Tracking
                </Link>
              </div>
            ))
          )}
        </CardContent>
      </Card>
    </div>
  );
}
