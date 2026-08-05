"use client";

import { useEffect, useState } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { WorkspaceMember } from "@/components/items/types";
import { ALL_KINDS, ALL_PRIORITIES, type TaskManagementFilters } from "./filters";

const ALL = "all";

export function ItemFilters({ filters, members }: { filters: TaskManagementFilters; members: WorkspaceMember[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [q, setQ] = useState(filters.q);
  // Adjust local state during render when the URL's q changes underneath us
  // (e.g. browser back/forward) — the React-recommended alternative to an
  // effect that calls setState on every prop change.
  const [syncedQ, setSyncedQ] = useState(filters.q);
  if (filters.q !== syncedQ) {
    setSyncedQ(filters.q);
    setQ(filters.q);
  }

  function updateParam(key: string, value: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (value && value !== ALL) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
    router.push(`${pathname}?${params.toString()}`, { scroll: false });
  }

  useEffect(() => {
    if (q === filters.q) return;
    const handle = setTimeout(() => updateParam("q", q || null), 300);
    return () => clearTimeout(handle);
    // Only re-run when the debounced value changes — re-running on every
    // filters/router identity change would reset the timer needlessly.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q]);

  return (
    <div className="flex flex-wrap items-end gap-2">
      <Input
        placeholder="Search title…"
        value={q}
        onChange={(event) => setQ(event.target.value)}
        className="h-8 w-48"
        data-testid="item-filter-search"
      />
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Priority</span>
        <Select
          value={filters.priority[0] ?? ALL}
          onValueChange={(value) => updateParam("priority", String(value) === ALL ? null : String(value))}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Priority" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All priorities</SelectItem>
            {ALL_PRIORITIES.map((priority) => (
              <SelectItem key={priority} value={priority}>
                {priority}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Kind</span>
        <Select
          value={filters.kind[0] ?? ALL}
          onValueChange={(value) => updateParam("kind", String(value) === ALL ? null : String(value))}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Kind" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>All kinds</SelectItem>
            {ALL_KINDS.map((kind) => (
              <SelectItem key={kind} value={kind}>
                {kind.replace("_", " ")}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-muted-foreground">Assignee</span>
        <Select
          value={filters.assignee ?? ALL}
          onValueChange={(value) => updateParam("assignee", String(value) === ALL ? null : String(value))}
        >
          <SelectTrigger size="sm">
            <SelectValue placeholder="Assignee" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL}>Everyone</SelectItem>
            <SelectItem value="unassigned">Unassigned</SelectItem>
            {members.map((member) => (
              <SelectItem key={member.id} value={member.id}>
                {member.full_name ?? member.email}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
    </div>
  );
}
