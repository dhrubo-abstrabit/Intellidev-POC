"use client";

import { useRouter } from "next/navigation";
import Link from "next/link";
import { ChevronsUpDown, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

interface WorkspaceSummary {
  id: string;
  name: string;
}

/** Shared between this component's own dropdown and the mobile hamburger
 * menu (workspace-sidebar.tsx) so a future change to how a workspace row
 * renders can't silently diverge between the two. */
export function WorkspaceMenuItems({ workspaces }: { workspaces: WorkspaceSummary[] }) {
  const router = useRouter();

  return (
    <>
      {workspaces.map((workspace) => (
        <DropdownMenuItem key={workspace.id} onClick={() => router.push(`/w/${workspace.id}`)}>
          {workspace.name}
        </DropdownMenuItem>
      ))}
      <DropdownMenuSeparator />
      <DropdownMenuItem
        render={
          <Link href="/onboarding" className="flex items-center gap-2">
            <Plus className="h-4 w-4" />
            New workspace
          </Link>
        }
      />
    </>
  );
}

export function WorkspaceSwitcher({ current, workspaces }: { current: WorkspaceSummary; workspaces: WorkspaceSummary[] }) {
  return (
    <DropdownMenu>
      {/* This component's underlying primitive (Base UI, not Radix) composes
          via a `render={<element/>}` prop, not a boolean `asChild`. */}
      <DropdownMenuTrigger
        render={
          <Button
            variant="outline"
            className="w-full justify-between gap-2 rounded-md border-transparent px-2.5 text-sidebar-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground"
          >
            <span className="truncate">{current.name}</span>
            <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
          </Button>
        }
      />
      <DropdownMenuContent align="start">
        <WorkspaceMenuItems workspaces={workspaces} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
