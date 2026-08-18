"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { format } from "date-fns";
import { CalendarIcon, ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import { projectDataHref, type ProjectDataFilters } from "./filters";
import type { DayIndexEntry } from "./types";

/** "YYYY-MM-DD" (this app's day-key format, always project-local, never a
 * UTC-shifted ISO string) <-> a plain Date for the Calendar to render/select
 * against. Built from y/m/d parts rather than `new Date(dayKey)` — the
 * latter parses as UTC midnight, which can land on the wrong local day. */
function dayKeyToDate(dayKey: string): Date {
  const [year, month, day] = dayKey.split("-").map(Number);
  return new Date(year, month - 1, day);
}

function dateToDayKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/**
 * Replaces the old always-visible day rail: a compact Prev/calendar/Next
 * control that reclaims the sidebar's width for Messages/Action Points.
 * `days` is sorted most-recent-first (see page.tsx), so a lower index is a
 * more recent day — Prev moves to a higher index (older), Next to a lower
 * one (newer). The calendar (shadcn's Popover+Calendar, on react-day-picker)
 * is the only way to jump to an arbitrary date now — it's not limited to
 * `days` (the last-60-days activity index), since an empty day already
 * renders a clean empty state in DayLinkage.
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
  const [open, setOpen] = useState(false);

  const index = days.findIndex((day) => day.dayKey === selectedDay);
  const olderDay = index >= 0 && index < days.length - 1 ? days[index + 1] : null;
  const newerDay = index > 0 ? days[index - 1] : null;

  function goToDate(date: Date | undefined) {
    if (!date) return;
    setOpen(false);
    router.push(projectDataHref({ date: dateToDayKey(date), connector, service }));
  }

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

      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger
          render={
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn(
                "w-[200px] justify-start text-left font-normal hover:border-brand-teal-400 hover:bg-background hover:text-foreground",
                !selectedDay && "text-muted-foreground",
              )}
              data-testid="day-picker-calendar"
            />
          }
        >
          <CalendarIcon aria-hidden="true" />
          {selectedDay ? format(dayKeyToDate(selectedDay), "PPP") : "Pick a date"}
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0">
          <Calendar mode="single" selected={dayKeyToDate(selectedDay)} onSelect={goToDate} />
        </PopoverContent>
      </Popover>

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
