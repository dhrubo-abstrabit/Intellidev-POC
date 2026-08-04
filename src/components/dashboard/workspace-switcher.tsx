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

interface WorkspaceSwitcherProps {
  current: WorkspaceSummary;
  workspaces: WorkspaceSummary[];
}

export function WorkspaceSwitcher({ current, workspaces }: WorkspaceSwitcherProps) {
  const router = useRouter();

  return (
    <DropdownMenu>
      {/* This component's underlying primitive (Base UI, not Radix) composes
          via a `render={<element/>}` prop, not a boolean `asChild`. */}
      <DropdownMenuTrigger
        render={
          <Button variant="outline" className="justify-between gap-2">
            {current.name}
            <ChevronsUpDown className="h-4 w-4 opacity-50" />
          </Button>
        }
      />
      <DropdownMenuContent align="start" className="w-56">
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
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
