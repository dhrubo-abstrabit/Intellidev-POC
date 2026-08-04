"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { createWorkspace, type CreateWorkspaceResult } from "@/app/(app)/onboarding/actions";

export function CreateWorkspaceForm() {
  const [state, formAction, isPending] = useActionState<CreateWorkspaceResult, FormData>(createWorkspace, {});

  return (
    <form action={formAction} className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="workspace-name">Workspace name</Label>
        <Input id="workspace-name" name="name" placeholder="Acme Technologies" required maxLength={120} />
      </div>
      {state.error ? <p className="text-sm text-destructive">{state.error}</p> : null}
      <Button type="submit" className="w-full" disabled={isPending}>
        {isPending ? "Creating..." : "Create workspace"}
      </Button>
    </form>
  );
}
