"use client";

import { useRef, useState, useTransition } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { Loader2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { updateProjectContext } from "./actions";

const ACCEPTED_EXTENSIONS = [".txt", ".md", ".markdown"];

function isAcceptedFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => name.endsWith(ext)) || file.type.startsWith("text/");
}

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
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDirty = value !== savedValue;

  // Client-side only — reads the file's text and drops it straight into the
  // textarea. No upload, no storage bucket: Save still just writes the
  // resulting text to projects.description like typing it in would.
  function loadFile(file: File) {
    if (!isAcceptedFile(file)) {
      toast.add({ title: `${file.name} isn't a text file`, description: "Only .txt and .md are supported.", type: "error" });
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setValue(String(reader.result ?? ""));
      toast.add({ title: `Loaded ${file.name}`, description: "Review it below, then Save to apply.", type: "success" });
    };
    reader.onerror = () => {
      toast.add({ title: `Could not read ${file.name}`, type: "error" });
    };
    reader.readAsText(file);
  }

  function handleBrowseChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (file) loadFile(file);
    event.target.value = ""; // allow picking the same file again later
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files[0];
    if (file) loadFile(file);
  }

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
      <div
        onDragOver={(event) => {
          event.preventDefault();
          setIsDragging(true);
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={handleDrop}
        className={cn("rounded-lg transition-shadow", isDragging && "ring-2 ring-ring")}
      >
        <Textarea
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="What should the AI know about this project? Goals, terminology, who's who, anything that helps it write better action items. Type here, or drag/browse a .txt or .md file in."
          className="min-h-56"
          data-testid="project-context-textarea"
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,text/plain,text/markdown"
        onChange={handleBrowseChange}
        className="hidden"
      />

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          data-testid="project-context-browse"
        >
          <UploadIcon aria-hidden="true" />
          Browse…
        </Button>
        <div className="flex items-center gap-2">
          {isDirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button onClick={handleSave} disabled={isPending || !isDirty} data-testid="project-context-save">
            {isPending ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
