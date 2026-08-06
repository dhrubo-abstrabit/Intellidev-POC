"use client";

import { useRef, useState, useTransition } from "react";
import type { ChangeEvent, DragEvent } from "react";
import { Loader2Icon, UploadIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { toast } from "@/components/ui/toast";
import { cn } from "@/lib/utils";
import { extractFileText, updateProjectContext } from "./actions";

const PLAIN_TEXT_EXTENSIONS = [".txt", ".md", ".markdown"];
const EXTRACTABLE_EXTENSIONS = [".pdf", ".docx"];
const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function isPlainTextFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return PLAIN_TEXT_EXTENSIONS.some((ext) => name.endsWith(ext)) || file.type.startsWith("text/");
}

function isExtractableFile(file: File): boolean {
  const name = file.name.toLowerCase();
  return EXTRACTABLE_EXTENSIONS.some((ext) => name.endsWith(ext)) || file.type === "application/pdf" || file.type === DOCX_MIME;
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
  const [isSaving, startSaveTransition] = useTransition();
  const [isExtracting, startExtractTransition] = useTransition();
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const isDirty = value !== savedValue;
  const isBusy = isSaving || isExtracting;

  // Plain text is read instantly in the browser. PDF/.docx are binary
  // formats FileReader can't meaningfully parse, so those go through a
  // Server Action that extracts the text server-side and hands it back —
  // nothing is uploaded/stored beyond that one round trip.
  function loadFile(file: File) {
    if (isPlainTextFile(file)) {
      const reader = new FileReader();
      reader.onload = () => {
        setValue(String(reader.result ?? ""));
        toast.add({ title: `Loaded ${file.name}`, description: "Review it below, then Save to apply.", type: "success" });
      };
      reader.onerror = () => {
        toast.add({ title: `Could not read ${file.name}`, type: "error" });
      };
      reader.readAsText(file);
      return;
    }

    if (isExtractableFile(file)) {
      startExtractTransition(async () => {
        try {
          const formData = new FormData();
          formData.append("file", file);
          const { text } = await extractFileText(formData);
          setValue(text);
          toast.add({ title: `Loaded ${file.name}`, description: "Review it below, then Save to apply.", type: "success" });
        } catch (err) {
          toast.add({ title: err instanceof Error ? err.message : `Could not read ${file.name}`, type: "error" });
        }
      });
      return;
    }

    toast.add({
      title: `${file.name} isn't supported`,
      description: "Only .txt, .md, .pdf, and .docx are supported.",
      type: "error",
    });
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
    startSaveTransition(async () => {
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
          placeholder="What should the AI know about this project? Goals, terminology, who's who, anything that helps it write better action items. Type here, or drag/browse a .txt, .md, .pdf, or .docx file in."
          className="min-h-56"
          disabled={isExtracting}
          data-testid="project-context-textarea"
        />
      </div>

      <input
        ref={fileInputRef}
        type="file"
        accept=".txt,.md,.markdown,.pdf,.docx,text/plain,text/markdown,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document"
        onChange={handleBrowseChange}
        className="hidden"
      />

      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => fileInputRef.current?.click()}
          disabled={isBusy}
          data-testid="project-context-browse"
        >
          {isExtracting ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : <UploadIcon aria-hidden="true" />}
          {isExtracting ? "Reading…" : "Browse…"}
        </Button>
        <div className="flex items-center gap-2">
          {isDirty ? <span className="text-xs text-muted-foreground">Unsaved changes</span> : null}
          <Button onClick={handleSave} disabled={isBusy || !isDirty} data-testid="project-context-save">
            {isSaving ? <Loader2Icon className="animate-spin" aria-hidden="true" /> : null}
            Save
          </Button>
        </div>
      </div>
    </div>
  );
}
