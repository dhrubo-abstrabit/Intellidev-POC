"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { LayoutGridIcon, ListIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { TaskManagementView } from "./filters";

export function ViewToggle({ view }: { view: TaskManagementView }) {
  const searchParams = useSearchParams();

  function hrefFor(next: TaskManagementView) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("view", next);
    return `?${params.toString()}`;
  }

  return (
    <div className="inline-flex gap-0.5 rounded-lg border p-0.5">
      <Button
        render={<Link href={hrefFor("list")} data-testid="view-list" />}
        nativeButton={false}
        variant={view === "list" ? "secondary" : "ghost"}
        size="sm"
      >
        <ListIcon aria-hidden="true" />
        List
      </Button>
      <Button
        render={<Link href={hrefFor("kanban")} data-testid="view-kanban" />}
        nativeButton={false}
        variant={view === "kanban" ? "secondary" : "ghost"}
        size="sm"
      >
        <LayoutGridIcon aria-hidden="true" />
        Kanban
      </Button>
    </div>
  );
}
