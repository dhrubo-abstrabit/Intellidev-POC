import Link from "next/link";
import { Button } from "@/components/ui/button";
import { formatItemDate } from "@/components/items/format";
import { projectDataHref, type ProjectDataFilters } from "./filters";
import type { DayIndexEntry } from "./types";

/** Server Component — plain Links built from the two known searchParams, so
 * nothing here needs to ship to the browser (contrast with the client-side
 * URL-state helpers in task-management/item-filters.tsx, which have to react
 * to a debounced text input; a day rail has no such input). */
export function DayRail({
  days,
  selectedDay,
  connector,
}: {
  days: DayIndexEntry[];
  selectedDay: string;
  connector: ProjectDataFilters["connector"];
}) {
  if (days.length === 0) {
    return <p className="text-sm text-muted-foreground">No activity in the last 60 days.</p>;
  }

  return (
    <nav aria-label="Days" className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto pr-1">
      {days.map((day) => (
        <Button
          key={day.dayKey}
          render={
            <Link href={projectDataHref({ date: day.dayKey, connector })} data-testid={`day-${day.dayKey}`} />
          }
          nativeButton={false}
          variant={day.dayKey === selectedDay ? "secondary" : "ghost"}
          size="sm"
          className="w-full justify-between font-normal"
        >
          <span>{formatItemDate(day.dayKey)}</span>
          <span className="text-xs text-muted-foreground">{day.total}</span>
        </Button>
      ))}
    </nav>
  );
}
