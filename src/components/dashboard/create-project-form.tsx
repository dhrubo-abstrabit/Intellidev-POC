"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { createProject, type CreateProjectResult } from "@/app/(app)/w/[workspaceId]/actions";

export function CreateProjectForm({ workspaceId }: { workspaceId: string }) {
  const boundAction = createProject.bind(null, workspaceId);
  const [state, formAction, isPending] = useActionState<CreateProjectResult, FormData>(boundAction, {});

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="project-name">Project name</Label>
        <Input id="project-name" name="name" placeholder="Internal Dashboard" required maxLength={160} />
      </div>
      <div className="space-y-2">
        <Label htmlFor="project-description">Description (optional)</Label>
        <Textarea id="project-description" name="description" maxLength={2000} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" disabled={isPending}>
        {isPending ? "Creating..." : "Create project"}
      </Button>
    </form>
  );
}
