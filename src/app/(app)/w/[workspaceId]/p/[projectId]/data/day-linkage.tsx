"use client";

import { useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ProviderBadge } from "@/components/items/provider-badge";
import { PriorityBadge, StatusBadge } from "@/components/items/status-badge";
import { cn } from "@/lib/utils";
import { projectTimeLabel } from "@/lib/date/project-day";
import type { DayActionPoint, DayEvent } from "./types";

type Focus = { kind: "event" | "item"; id: string } | null;

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
}: {
  events: DayEvent[];
  actionPoints: DayActionPoint[];
  timezone: string;
  workspaceId: string;
  projectId: string;
}) {
  const [focus, setFocus] = useState<Focus>(null);

  function toggle(next: Focus) {
    setFocus((current) => (current && next && current.kind === next.kind && current.id === next.id ? null : next));
  }

  function eventClass(eventId: string): string {
    if (!focus) return "";
    if (focus.kind === "event") return focus.id === eventId ? "ring-2 ring-ring/40" : "opacity-40";
    // focus.kind === "item": highlight this event if it's one of the focused item's sources.
    const focusedItem = actionPoints.find((item) => item.id === focus.id);
    return focusedItem?.sourceEventIds.includes(eventId) ? "ring-1 ring-foreground/30" : "opacity-40";
  }

  function itemClass(item: DayActionPoint): string {
    if (!focus) return "";
    if (focus.kind === "item") return focus.id === item.id ? "ring-2 ring-ring/40" : "opacity-40";
    // focus.kind === "event": highlight action points sourced from the focused event.
    return item.sourceEventIds.includes(focus.id) ? "ring-1 ring-foreground/30" : "opacity-40";
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
            events.map((event) => (
              <button
                key={event.id}
                type="button"
                data-testid={`event-${event.id}`}
                onClick={() => toggle({ kind: "event", id: event.id })}
                className={cn(
                  "w-full rounded-lg bg-muted/30 p-2.5 text-left text-sm ring-1 ring-foreground/10 transition-all",
                  eventClass(event.id),
                )}
              >
                <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                  <span className="flex items-center gap-1.5">
                    <ProviderBadge provider={event.provider} />
                    {projectTimeLabel(event.occurredAt, timezone)}
                  </span>
                  {!event.processed ? (
                    <span className="text-muted-foreground/70">Not yet processed</span>
                  ) : null}
                </div>
                <p className="mt-1 font-medium text-foreground">
                  {event.actorDisplay ?? event.actor ?? "Unknown"}
                  {event.title ? <span className="text-muted-foreground"> · {event.title}</span> : null}
                </p>
                {event.body ? <p className="mt-0.5 whitespace-pre-wrap text-muted-foreground">{event.body}</p> : null}
              </button>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Action Points ({actionPoints.length})</CardTitle>
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
                    <p className="mt-0.5 line-clamp-2 text-muted-foreground">{item.description}</p>
                  ) : null}
                  <p className="mt-1 text-xs text-muted-foreground">
                    from {item.sourceEventIds.length} message{item.sourceEventIds.length === 1 ? "" : "s"}
                  </p>
                </button>
                <Link
                  href={`/w/${workspaceId}/p/${projectId}/task-management?item=${item.id}`}
                  className="mt-1.5 inline-block text-xs underline underline-offset-2 hover:text-foreground"
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
