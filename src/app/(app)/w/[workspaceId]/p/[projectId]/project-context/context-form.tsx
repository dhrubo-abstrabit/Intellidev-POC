"use client";

import { useState, useTransition } from "react";
import { Loader2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { updateProjectContext } from "./actions";

export function ContextForm({
  workspaceId,
  projectId,
  initialValue,
}: {
  workspaceId: string;
  projectId: string;
  initialValue: string;
}) {
  const [value, setValue] = useState(initialValue);
  const [savedValue, setSavedValue] = useState(initialValue);
  const [isPending, startTransition] = useTransition();
  const isDirty = value !== savedValue;

  function handleSave() {
    startTransition(async () => {
      await toast
        .promise(updateProjectContext(workspaceId, projectId, value), {
          loading: "Saving…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Something went wrong"),
        })
        .then(() => setSavedValue(value))
        .catch(() => {});
    });
  }

  return (
    <div className="max-w-2xl space-y-3">
      <Textarea
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder="What should the AI know about this project? Goals, terminology, who's who, anything that helps it write better action items."
        className="min-h-56"
        data-testid="project-context-textarea"
      />
      <div className="flex items-center justify-end gap-2">
        {isDirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
        <Button onClick={handleSave} disabled={isPending || !isDirty} data-testid="project-context-save">
          {isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
          Save
        </Button>
      </div>
    </div>
  );
}
