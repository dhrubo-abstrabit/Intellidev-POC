"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChevronRight, LayoutDashboard, LogOut, Menu, PanelLeftClose, PanelLeftOpen, Plus, Users } from "lucide-react";
import { signOut } from "@/app/(auth)/actions";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { BrandMark } from "@/components/dashboard/brand-mark";
import { ThemeToggle } from "@/components/dashboard/theme-toggle";
import { WorkspaceMenuItems, WorkspaceSwitcher } from "@/components/dashboard/workspace-switcher";
import { cn } from "@/lib/utils";

interface Summary {
  id: string;
  name: string;
}

const SECTION_LABEL = "px-2.5 text-xs font-medium tracking-wide text-sidebar-foreground/50 uppercase";
const SIDEBAR_COLLAPSED_KEY = "sidebar-collapsed";

function navRowClass(active: boolean) {
  return cn(
    "flex items-center gap-2 truncate rounded-md px-2.5 py-1.5 text-sm",
    active ? "bg-sidebar-accent font-medium text-sidebar-accent-foreground" : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );
}

function railIconClass(active: boolean) {
  return cn(
    "flex size-8 shrink-0 items-center justify-center rounded-md text-sm font-semibold",
    active ? "bg-sidebar-accent text-sidebar-accent-foreground" : "text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );
}

/** A project's 5 sub-pages — rendered as a desktop disclosure and a mobile
 * submenu (both below), the only two places this app lists them now that
 * the old per-project top tab row is gone. */
function projectTabs(workspaceId: string, projectId: string) {
  const base = `/w/${workspaceId}/p/${projectId}`;
  return [
    { href: base, label: "Overview" },
    { href: `${base}/data`, label: "Project Data" },
    { href: `${base}/project-context`, label: "Project Context" },
    { href: `${base}/task-management`, label: "Task Tracking" },
    { href: `${base}/integrations`, label: "Integrations" },
  ];
}

/**
 * Replaces the old header-based workspace-switcher + Overview/Team-Members
 * nav, and the old per-project top tab row, with a persistent left sidebar
 * (see w/[workspaceId]/layout.tsx and p/[projectId]/layout.tsx). Each
 * project row is a disclosure — clicking it expands/collapses its 5
 * sub-pages inline; the mobile menu below gives each project the same 5
 * pages via a submenu instead, since there's no room to expand inline there.
 *
 * Renders two trees, both always in the DOM, gated by Tailwind's `md:`
 * breakpoint rather than JS — same hydration-safe pattern as DayPicker
 * (usePathname() in a "use client" leaf fed by server-fetched props), just
 * with a CSS-only responsive swap on top.
 */
export function WorkspaceSidebar({
  workspaceId,
  current,
  workspaces,
  projects,
}: {
  workspaceId: string;
  current: Summary;
  workspaces: Summary[];
  projects: Summary[];
}) {
  const pathname = usePathname();
  const base = `/w/${workspaceId}`;
  const isOverview = pathname === base;
  const isTeamMembers = pathname === `${base}/team-members`;
  const isProjectActive = (projectId: string) => pathname.startsWith(`${base}/p/${projectId}`);

  const projectPrefix = `${base}/p/`;
  const activeProjectId = pathname.startsWith(projectPrefix) ? pathname.slice(projectPrefix.length).split("/")[0] : null;

  // Auto-expand whichever project the current route is under; a manual
  // toggle (below) can still collapse/expand any project independently
  // until the active one actually changes. Adjusted during render (React's
  // recommended alternative to an effect that calls setState on every prop
  // change) — same pattern task-management/item-filters.tsx already uses.
  const [expandedProjectId, setExpandedProjectId] = useState<string | null>(activeProjectId);
  const [syncedActiveProjectId, setSyncedActiveProjectId] = useState(activeProjectId);
  if (activeProjectId !== syncedActiveProjectId) {
    setSyncedActiveProjectId(activeProjectId);
    if (activeProjectId) setExpandedProjectId(activeProjectId);
  }

  // Defaults to expanded on the very first render (server and client agree,
  // so no hydration mismatch) — a saved "collapsed" preference is applied a
  // moment after mount instead, the same brief-flash tradeoff already
  // accepted for expandedProjectId above.
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => {
    // localStorage only exists client-side — this can't be read during
    // render (would mismatch SSR) or derived from a prop, so a one-time
    // effect syncing from that external system on mount is the correct
    // shape here, not the "derived state" pattern the lint rule targets.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCollapsed(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  }, []);
  function toggleCollapsed() {
    setCollapsed((current) => {
      const next = !current;
      localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(next));
      return next;
    });
  }

  // Collapsed rail only: which project's sub-page dropdown is open, driven
  // by hover rather than the primitive's default click-to-open. The popup
  // content portals to document.body (see dropdown-menu.tsx), so it's not a
  // DOM descendant of the trigger — mouseenter/mouseleave have to be wired
  // to both the trigger button and the popup itself, not just a wrapping
  // element, or moving the pointer from one to the other would prematurely
  // close it.
  const [railOpenProjectId, setRailOpenProjectId] = useState<string | null>(null);

  // Unaffected by `collapsed` — mobile always collapses to this hamburger
  // header regardless of the desktop sidebar's state — so it's built once
  // and reused from both return branches below.
  const mobileHeader = (
    <header className="flex items-center justify-between border-b border-sidebar-border bg-sidebar px-4 py-3 text-sidebar-foreground md:hidden">
      <BrandMark />
      <div className="flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="ghost" size="icon-sm" aria-label="Open navigation" />}>
            <Menu className="size-4" />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <WorkspaceMenuItems workspaces={workspaces} />
            <DropdownMenuSeparator />
            <DropdownMenuItem render={<Link href={base} />} className={isOverview ? "bg-accent" : undefined}>
              Overview
            </DropdownMenuItem>
            <DropdownMenuItem
              render={<Link href={`${base}/team-members`} />}
              className={isTeamMembers ? "bg-accent" : undefined}
            >
              Team Members
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            {projects.map((project) => (
              <DropdownMenuSub key={project.id}>
                <DropdownMenuSubTrigger className={isProjectActive(project.id) ? "bg-accent" : undefined}>
                  {project.name}
                </DropdownMenuSubTrigger>
                <DropdownMenuSubContent>
                  {projectTabs(workspaceId, project.id).map((tab) => (
                    <DropdownMenuItem
                      key={tab.href}
                      render={<Link href={tab.href} />}
                      className={pathname === tab.href ? "bg-accent" : undefined}
                    >
                      {tab.label}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ))}
            <DropdownMenuItem render={<Link href={base} className="flex items-center gap-2" />}>
              <Plus className="size-4" />
              New project
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>

        <ThemeToggle />

        {/* signOut() calls redirect() internally — that only reliably
         * navigates behind a real <form> submit (see CLAUDE.md), so it
         * can't be a DropdownMenuItem's onClick. A separate button next
         * to the hamburger keeps the real <form> intact. */}
        <form action={signOut}>
          <Button type="submit" variant="ghost" size="icon-sm" aria-label="Sign out">
            <LogOut className="size-4" />
          </Button>
        </form>
      </div>
    </header>
  );

  const expandedContent = (
    <>
      <div className="flex items-center justify-between px-4 py-4">
        <BrandMark />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={toggleCollapsed}
          aria-label="Collapse sidebar"
          className="text-sidebar-foreground/60 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
        >
          <PanelLeftClose className="size-4" />
        </Button>
      </div>
      <div className="px-3">
        <WorkspaceSwitcher current={current} workspaces={workspaces} />
      </div>

      <nav className="flex-1 space-y-6 overflow-y-auto px-3 py-4">
        <div className="space-y-1">
          <div className={SECTION_LABEL}>Workspace</div>
          <Link href={base} className={navRowClass(isOverview)}>
            Overview
          </Link>
          <Link href={`${base}/team-members`} className={navRowClass(isTeamMembers)}>
            Team Members
          </Link>
        </div>

        <div className="space-y-1">
          <div className="flex items-center justify-between">
            <span className={SECTION_LABEL}>Projects</span>
            <Link
              href={base}
              title="New project"
              className="flex size-5 items-center justify-center rounded-md text-sidebar-foreground/50 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
            >
              <Plus className="size-3.5" />
            </Link>
          </div>
          {projects.length === 0 ? (
            <p className="px-2.5 text-xs text-sidebar-foreground/50">No projects yet</p>
          ) : (
            projects.map((project) => {
              const isExpanded = expandedProjectId === project.id;
              return (
                <div key={project.id}>
                  <button
                    type="button"
                    title={project.name}
                    onClick={() => setExpandedProjectId((current) => (current === project.id ? null : project.id))}
                    className={cn("w-full", navRowClass(isProjectActive(project.id)))}
                  >
                    <ChevronRight className={cn("size-3.5 shrink-0 transition-transform", isExpanded && "rotate-90")} />
                    <span className="truncate">{project.name}</span>
                  </button>
                  {isExpanded ? (
                    <div className="mt-1 ml-4 space-y-1 border-l border-sidebar-border pl-2.5">
                      {projectTabs(workspaceId, project.id).map((tab) => (
                        <Link key={tab.href} href={tab.href} className={navRowClass(pathname === tab.href)}>
                          {tab.label}
                        </Link>
                      ))}
                    </div>
                  ) : null}
                </div>
              );
            })
          )}
        </div>
      </nav>

      <div className="flex items-center gap-1.5 border-t border-sidebar-border p-3">
        <form action={signOut} className="flex-1">
          <Button type="submit" variant="ghost" size="sm" className="w-full justify-start text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground">
            <LogOut className="size-4" />
            Sign out
          </Button>
        </form>
        <ThemeToggle />
      </div>
    </>
  );

  if (collapsed) {
    return (
      <>
        <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-14 md:flex-none md:flex-col md:items-center md:gap-1 md:border-r md:border-sidebar-border md:bg-sidebar md:py-3 md:text-sidebar-foreground">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={toggleCollapsed}
            aria-label="Expand sidebar"
            className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <PanelLeftOpen className="size-4" />
          </Button>

          <div className="my-1 w-8 border-t border-sidebar-border" />

          <WorkspaceSwitcher current={current} workspaces={workspaces} collapsed />

          <div className="my-1 w-8 border-t border-sidebar-border" />

          <Link href={base} title="Overview" aria-label="Overview" className={railIconClass(isOverview)}>
            <LayoutDashboard className="size-4" />
          </Link>
          <Link
            href={`${base}/team-members`}
            title="Team Members"
            aria-label="Team Members"
            className={railIconClass(isTeamMembers)}
          >
            <Users className="size-4" />
          </Link>

          <div className="my-1 w-8 border-t border-sidebar-border" />

          {/* Each project is a dropdown (not the expanded sidebar's inline
           * disclosure — there's no room to indent sub-items in a 56px
           * rail) listing the same 5 sub-pages the mobile menu already
           * exposes via a submenu, opening to the right of the rail. */}
          <div className="flex w-full flex-1 flex-col items-center gap-1 overflow-y-auto">
            {projects.map((project) => {
              const closeIfOwn = () =>
                setRailOpenProjectId((prev) => (prev === project.id ? null : prev));
              return (
                <DropdownMenu
                  key={project.id}
                  open={railOpenProjectId === project.id}
                  onOpenChange={(open) => setRailOpenProjectId(open ? project.id : null)}
                >
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        title={project.name}
                        aria-label={project.name}
                        className={railIconClass(isProjectActive(project.id))}
                        onMouseEnter={() => setRailOpenProjectId(project.id)}
                        onMouseLeave={closeIfOwn}
                      />
                    }
                  >
                    {project.name.charAt(0).toUpperCase()}
                  </DropdownMenuTrigger>
                  <DropdownMenuContent
                    side="right"
                    align="start"
                    onMouseEnter={() => setRailOpenProjectId(project.id)}
                    onMouseLeave={closeIfOwn}
                  >
                    {projectTabs(workspaceId, project.id).map((tab) => (
                      <DropdownMenuItem
                        key={tab.href}
                        render={<Link href={tab.href} />}
                        className={pathname === tab.href ? "bg-accent" : undefined}
                      >
                        {tab.label}
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              );
            })}
            <Link href={base} title="New project" aria-label="New project" className={railIconClass(false)}>
              <Plus className="size-4" />
            </Link>
          </div>

          <div className="mt-auto flex flex-col items-center gap-1 pt-1">
            <ThemeToggle />
            <form action={signOut}>
              <Button
                type="submit"
                variant="ghost"
                size="icon-sm"
                aria-label="Sign out"
                className="text-sidebar-foreground/70 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
              >
                <LogOut className="size-4" />
              </Button>
            </form>
          </div>
        </aside>
        {mobileHeader}
      </>
    );
  }

  return (
    <>
      <aside className="hidden md:sticky md:top-0 md:flex md:h-screen md:w-60 md:flex-none md:flex-col md:border-r md:border-sidebar-border md:bg-sidebar md:text-sidebar-foreground">
        {expandedContent}
      </aside>

      {mobileHeader}
    </>
  );
}
