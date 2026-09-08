"use client";

import { useTransition, type MouseEvent } from "react";
import { PaperclipIcon } from "lucide-react";
import { toast } from "@/components/ui/toast";
import { getAttachmentPreviewUrl } from "./attachment-actions";
import type { AttachmentSummary } from "./types";

/** One attachment's row under its message: a preview link once its bytes
 * are known-downloaded (status extracted), otherwise just its current
 * status — 'skipped'/'failed'/'pending' all mean there's nothing in Storage
 * to open yet. The signed URL is minted fresh per click (see
 * getAttachmentPreviewUrl's own doc comment for why), not fetched ahead of
 * time, so opening a link a user left on screen for a while never 403s.
 * Shared by DayLinkage (Project Data) and TaskDetailSheet (Task Tracking) —
 * both list the same normalized_events rows' attachments. */
export function AttachmentRow({
  attachment,
  workspaceId,
  projectId,
}: {
  attachment: AttachmentSummary;
  workspaceId: string;
  projectId: string;
}) {
  const [isPending, startTransition] = useTransition();
  const label = attachment.filename ?? "attachment";

  function openPreview(e: MouseEvent) {
    e.stopPropagation();
    startTransition(async () => {
      try {
        const { url } = await getAttachmentPreviewUrl(workspaceId, projectId, attachment.id);
        window.open(url, "_blank", "noopener,noreferrer");
      } catch (err) {
        toast.add({ title: err instanceof Error ? err.message : "Could not open preview.", type: "error" });
      }
    });
  }

  return (
    <div className="mt-1 flex items-center gap-1.5 text-xs text-muted-foreground">
      <PaperclipIcon className="size-3 shrink-0" aria-hidden="true" />
      <span className="truncate">
        {label}
        {attachment.pageNumber != null ? ` · page ${attachment.pageNumber}` : ""}
      </span>
      {attachment.status === "extracted" ? (
        <button
          type="button"
          onClick={openPreview}
          disabled={isPending}
          className="shrink-0 underline underline-offset-2 hover:text-foreground disabled:opacity-50"
        >
          {isPending ? "Opening…" : "Preview"}
        </button>
      ) : attachment.status === "pending" ? (
        <span className="shrink-0 text-muted-foreground/70">processing…</span>
      ) : (
        <span className="shrink-0 text-muted-foreground/70">
          {attachment.status}
          {attachment.skipReason ? ` (${attachment.skipReason})` : ""}
        </span>
      )}
    </div>
  );
}
