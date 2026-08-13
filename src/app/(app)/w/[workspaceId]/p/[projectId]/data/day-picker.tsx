"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { formatItemDate } from "@/components/items/format";
import { cn } from "@/lib/utils";
import { projectDataHref, type ProjectDataFilters } from "./filters";
import type { DayIndexEntry } from "./types";

/**
 * Replaces the old always-visible day rail: a compact Prev/day-select/Next
 * control that reclaims the sidebar's width for Messages/Action Points,
 * trading "see all 60 days at a glance" for "browse one day at a time" plus
 * a jump-to-any-day dropdown. `days` is sorted most-recent-first (see
 * page.tsx), so a lower index is a more recent day — Prev moves to a higher
 * index (older), Next to a lower one (newer).
 */
export function DayPicker({
  days,
  selectedDay,
  connector,
  service,
}: {
  days: DayIndexEntry[];
  selectedDay: string;
  connector: ProjectDataFilters["connector"];
  service: ProjectDataFilters["service"];
}) {
  const router = useRouter();

  if (days.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity in the last 60 days.</p>;
  }

  const index = days.findIndex((day) => day.dayKey === selectedDay);
  const olderDay = index >= 0 && index < days.length - 1 ? days[index + 1] : null;
  const newerDay = index > 0 ? days[index - 1] : null;

  return (
    <div className="flex items-center gap-1.5">
      <Button
        render={
          <Link
            href={projectDataHref({ date: olderDay?.dayKey ?? selectedDay, connector, service })}
            aria-disabled={!olderDay}
            data-testid="day-picker-prev"
          />
        }
        nativeButton={false}
        variant="outline"
        size="icon-sm"
        disabled={!olderDay}
        className={cn(!olderDay && "pointer-events-none opacity-40")}
        aria-label="Previous day with activity"
      >
        <ChevronLeftIcon aria-hidden="true" />
      </Button>

      <Select
        items={days.map((day) => ({ label: `${formatItemDate(day.dayKey)} (${day.total})`, value: day.dayKey }))}
        value={selectedDay}
        onValueChange={(value) => router.push(projectDataHref({ date: String(value), connector, service }))}
      >
        <SelectTrigger size="sm" className="w-48" data-testid="day-picker-select">
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {days.map((day) => (
            <SelectItem key={day.dayKey} value={day.dayKey}>
              {formatItemDate(day.dayKey)} ({day.total})
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      <Button
        render={
          <Link
            href={projectDataHref({ date: newerDay?.dayKey ?? selectedDay, connector, service })}
            aria-disabled={!newerDay}
            data-testid="day-picker-next"
          />
        }
        nativeButton={false}
        variant="outline"
        size="icon-sm"
        disabled={!newerDay}
        className={cn(!newerDay && "pointer-events-none opacity-40")}
        aria-label="Next day with activity"
      >
        <ChevronRightIcon aria-hidden="true" />
      </Button>
    </div>
  );
}
