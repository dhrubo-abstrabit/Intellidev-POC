"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

/** Extracted from the layout (a Server Component) because knowing which tab
 * is active needs the current pathname, which only `usePathname()` can give
 * us. Every tab here is a leaf route (search params vary, e.g. Project
 * Data's ?date=, Task Tracking's ?view=, but the pathname itself doesn't) so
 * an exact match is enough — no prefix-matching needed to also catch nested
 * sub-routes. */
export function ProjectNav({ workspaceId, projectId }: { workspaceId: string; projectId: string }) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}/p/${projectId}`;

  const tabs = [
    { href: base, label: "Overview" },
    { href: `${base}/data`, label: "Project Data" },
    { href: `${base}/project-context`, label: "Project Context" },
    { href: `${base}/task-management`, label: "Task Tracking" },
    { href: `${base}/integrations`, label: "Integrations" },
  ];

  return (
    <nav className="flex gap-4 text-sm text-muted-foreground">
      {tabs.map((tab) => (
        <Link
          key={tab.href}
          href={tab.href}
          className={cn(
            pathname === tab.href
              ? "text-brand-teal-600 underline underline-offset-4"
              : "hover:text-brand-teal-600",
          )}
        >
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}
