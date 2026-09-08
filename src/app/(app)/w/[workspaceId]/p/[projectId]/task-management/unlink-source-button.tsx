"use client";

import { useTransition } from "react";
import { XIcon } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { unlinkTaskSource } from "./actions";

/** Only ever rendered for a PM-added link (task_sources.linked_by is not
 * null) — see task-detail-sheet.tsx, which decides that. A model-written
 * created_from/mentioned row has no unlink control at all, not a disabled
 * one: this codebase's convention (see StatusPicker/PriorityPicker) is to
 * omit a control entirely when an action genuinely isn't available, rather
 * than render it disabled with no way to discover why. */
export function UnlinkSourceButton({
  workspaceId,
  projectId,
  itemId,
  normalizedEventId,
}: {
  workspaceId: string;
  projectId: string;
  itemId: string;
  normalizedEventId: string;
}) {
  const [isPending, startTransition] = useTransition();

  function handleUnlink() {
    startTransition(async () => {
      await toast
        .promise(unlinkTaskSource(workspaceId, projectId, itemId, normalizedEventId), {
          loading: "Unlinking…",
          success: (result) => result.message,
          error: (err) => (err instanceof Error ? err.message : "Could not unlink."),
        })
        .catch(() => {});
    });
  }

  return (
    <button
      type="button"
      onClick={handleUnlink}
      disabled={isPending}
      aria-label="Unlink this source"
      className="shrink-0 text-muted-foreground hover:text-destructive disabled:opacity-50"
    >
      <XIcon className="size-3" aria-hidden="true" />
    </button>
  );
}
