"use client";

import { useState, useTransition } from "react";
import { SearchIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { toast } from "@/components/ui/toast";
import { formatItemDate } from "@/components/items/format";
import { findRelatedForTask, linkTaskSource } from "./actions";
import type { RelatedCandidate } from "@/services/tasks/find-related";

/**
 * The human-in-the-loop replacement for the model's old auto-citation
 * channel — see PROMPT_VERSION's "v5" note in lib/llm/prompt.ts. Retrieval
 * is live and on-demand (no editable query box: the query is always the
 * task's own title + description, built server-side in actions.ts), and
 * linking is explicit per candidate, never automatic.
 *
 * `candidates` is local, ephemeral client state — NOT re-derived from
 * page.tsx's server props on every render, unlike sourceEvents above it in
 * TaskDetailSheet. Once a candidate is linked, it's removed from this list
 * rather than left to show "Linked": the real row now lives in the Source
 * list above, which revalidatePath (inside linkTaskSource) already
 * refreshes — showing it in both places would just be a duplicate.
 */
export function FindRelatedPanel({ workspaceId, projectId, itemId }: { workspaceId: string; projectId: string; itemId: string }) {
  const [candidates, setCandidates] = useState<RelatedCandidate[] | null>(null);
  const [isSearching, startSearch] = useTransition();
  const [linkingChunkId, setLinkingChunkId] = useState<string | null>(null);

  function handleFind() {
    startSearch(async () => {
      try {
        const { candidates: found } = await findRelatedForTask(workspaceId, projectId, itemId);
        setCandidates(found);
      } catch (err) {
        toast.add({ title: err instanceof Error ? err.message : "Could not search for related items.", type: "error" });
      }
    });
  }

  function handleLink(candidate: RelatedCandidate) {
    setLinkingChunkId(candidate.chunkId);
    toast
      .promise(linkTaskSource(workspaceId, projectId, itemId, { chunkId: candidate.chunkId, normalizedEventId: candidate.normalizedEventId }), {
        loading: "Linking…",
        success: (result) => result.message,
        error: (err) => (err instanceof Error ? err.message : "Could not link that item."),
      })
      .then(() => {
        // Every outcome (linked, linked with no description change, linked
        // but the rewrite failed, or already linked by an earlier click)
        // means this event is now a real Source row — never re-offer it.
        setCandidates((prev) => (prev ? prev.filter((c) => c.chunkId !== candidate.chunkId) : prev));
      })
      .catch(() => {})
      .finally(() => setLinkingChunkId(null));
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-2">
        <span className="text-xs text-muted-foreground">Search this task&apos;s activity for related events or files to link</span>
        <Button type="button" variant="outline" size="sm" onClick={handleFind} disabled={isSearching}>
          <SearchIcon data-icon="inline-start" />
          {isSearching ? "Searching…" : "Find related"}
        </Button>
      </div>

      {candidates !== null && candidates.length === 0 ? (
        <p className="text-xs text-muted-foreground">No related items found.</p>
      ) : null}

      {candidates !== null && candidates.length > 0 ? (
        <div className="max-h-48 space-y-2 overflow-y-auto rounded-lg border p-2">
          {candidates.map((candidate) => (
            <div key={candidate.chunkId} className="rounded-md bg-muted/50 p-2 text-sm">
              <div className="flex items-center justify-between gap-2 text-xs text-muted-foreground">
                <span className="truncate">
                  {candidate.title ?? candidate.sourceKind.replace("_", " ")}
                  {candidate.pageNumber != null ? ` · page ${candidate.pageNumber}` : ""}
                </span>
                <span className="shrink-0">{formatItemDate(candidate.occurredAt)}</span>
              </div>
              <p className="mt-1 line-clamp-3 whitespace-pre-wrap break-words text-foreground">{candidate.snippet}</p>
              <div className="mt-1.5 flex justify-end">
                <Button type="button" size="xs" variant="outline" disabled={linkingChunkId === candidate.chunkId} onClick={() => handleLink(candidate)}>
                  {linkingChunkId === candidate.chunkId ? "Linking…" : "Link"}
                </Button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
