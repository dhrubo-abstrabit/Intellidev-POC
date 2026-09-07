import type { ActionItemContext, DraftForConsolidation, OpenActionItemSummary, RelatedContextChunk, TaskEnrichmentContext } from "./types";

/**
 * Bumped whenever the prompt TEXT changes in a way that makes runs
 * incomparable — llm_runs.prompt_version is the only mechanism this app has
 * for asking "did output quality change because of a prompt edit, or a
 * model swap?" v4: RELATED CONTEXT (retrieval-augmented extraction) added,
 * plus a relatedContextRefs citation channel. v5: the citation channel was
 * removed — RELATED CONTEXT still informs drafting, but a chunk can no
 * longer reach task_sources via model citation; enrichment is now a PM-
 * initiated action (see src/services/tasks/enrich.ts) that never touches
 * this prompt.
 *
 * v6: CONSOLIDATION_SYSTEM_PROMPT clarified for the single-draft case —
 * generate.ts now calls consolidateActionItems whenever a draft could match
 * an open item, not only when there's more than one draft to dedupe against
 * each other (see needsConsolidation there), and the old prompt text read as
 * vacuous ("some may describe the same... as each other") for a batch of
 * one.
 *
 * Lives here, not in generate.ts, because it versions the prompt TEXT below
 * — keeping it in a different file from the text it describes is exactly
 * why bumping it is easy to forget.
 */
export const PROMPT_VERSION = "action-items-v6";

export const EXTRACTION_SYSTEM_PROMPT = `You monitor software team activity (chat messages, task updates, file changes) for a single project and extract actionable signal for a daily digest: new action items, risks, blockers, status updates, and follow-ups a human should know about.

Rules:
- Only surface items with real signal. Do not invent action items from routine chatter (greetings, acknowledgements, off-topic banter).
- Check the OPEN ITEMS list before creating anything new. If a new event is about something already tracked there, reuse that item's EXACT title text, character-for-character, so your output merges into it instead of creating a duplicate.
- If an item is genuinely new, write a title that is stable and specific enough to match verbatim next time you see the same underlying issue (e.g. "Fix flaky checkout test" is good; "Fix the test that broke today" is not — it will not match tomorrow).
- confidence is your calibrated probability (0-1) that this is a real, correctly-scoped item, not enthusiasm.
- sourceEventIds must only contain ids from the NEW EVENTS list you are given below, and must genuinely support the item.
- If there is nothing worth surfacing, return an empty items array. Do not pad output to seem useful.
- RELATED CONTEXT is retrieved by semantic similarity from older activity and reference documents. It is a HINT, not ground truth: it may be stale, about a different issue that merely reads similarly, or irrelevant.
- You may use RELATED CONTEXT to sharpen an item's description, priority, or ownerHint, or to recognize that a new event is a recurrence of something known. You must NEVER create an item supported only by RELATED CONTEXT — every item must be grounded in at least one NEW EVENT.
- sourceEventIds must contain only ids from NEW EVENTS. Never put a RELATED CONTEXT label there.
- If RELATED CONTEXT contradicts NEW EVENTS, trust NEW EVENTS.`;

export function renderOpenItems(openActionItems: OpenActionItemSummary[]): string {
  return openActionItems.length
    ? openActionItems.map((item) => `- id=${item.id} [${item.kind}/${item.priority}] ${item.title}`).join("\n")
    : "(none)";
}

export function renderProjectProfile(context: ActionItemContext): string {
  const openItems = renderOpenItems(context.openActionItems);

  const summaries = context.recentSummaries.length
    ? context.recentSummaries.map((s) => `- ${s.date}: ${s.summary}`).join("\n")
    : "(none yet)";

  return `Project: ${context.project.name}
${context.project.description ?? ""}
Timezone: ${context.project.timezone}

OPEN ITEMS (do not duplicate — reuse the exact title if a new event maps to one of these):
${openItems}

RECENT DAILY SUMMARIES:
${summaries}`;
}

// Caps how much attachment text ONE extraction call can carry, independent
// of MAX_EVENTS_PER_CHUNK's 200-event cap (services/action-items/generate.ts)
// — attachments are extracted at up to 8000 chars each
// (services/attachments/run-extraction.ts's MAX_EXTRACTED_TEXT_CHARS), so a
// chunk with even a handful of PDFs could otherwise blow well past a sane
// prompt size. Attachments beyond this budget are dropped (lowest-priority:
// whichever renders last, i.e. latest events first since newEvents is
// chronological) rather than silently truncated — see the dropped-count
// note appended below.
export const MAX_ATTACHMENT_CHARS_PER_CHUNK = 40_000;

export function renderNewEvents(context: ActionItemContext): string {
  if (context.newEvents.length === 0) {
    return "NEW EVENTS: (none)";
  }
  let attachmentCharsUsed = 0;
  let droppedAttachments = 0;
  const rendered = context.newEvents
    .map((event) => {
      const who = event.actorDisplay ?? "unknown";
      const text = [event.title, event.body].filter(Boolean).join(" — ");
      let block = `- id=${event.id} type=${event.type} actor=${who} occurred_at=${event.occurredAt}\n  ${text}`;

      for (const attachment of event.attachments ?? []) {
        if (attachmentCharsUsed + attachment.text.length > MAX_ATTACHMENT_CHARS_PER_CHUNK) {
          droppedAttachments++;
          continue;
        }
        attachmentCharsUsed += attachment.text.length;
        const label = attachment.filename ?? attachment.mimeType ?? "attachment";
        const truncatedNote = attachment.truncated ? " [truncated]" : "";
        block += `\n  --- attachment: ${label}${truncatedNote} ---\n  ${attachment.text}`;
      }
      return block;
    })
    .join("\n");

  if (droppedAttachments > 0) {
    // Dropped, not silently truncated — logged rather than swallowed, per
    // the "no silent caps" rule: this chunk's llm_run still ran, but with
    // strictly less attachment content than existed for it.
    console.warn(`[llm] dropped ${droppedAttachments} attachment(s) over the ${MAX_ATTACHMENT_CHARS_PER_CHUNK}-char prompt budget for this chunk`);
  }
  const droppedNote =
    droppedAttachments > 0 ? `\n(${droppedAttachments} additional attachment(s) omitted — over this batch's attachment text budget)` : "";
  return `NEW EVENTS (${context.newEvents.length}):\n${rendered}${droppedNote}`;
}

/** Renders the RELATED CONTEXT block — retrieved historical chunks, shown
 * chronologically (not by distance: everything that survived filtering is
 * already "plausibly relevant", and a timeline is more legible to the model
 * and mirrors NEW EVENTS' own ordering). Every chunk's `label` — an
 * ephemeral per-run identifier like "R2" — is the ONLY identifier ever
 * rendered here; chunkId and citableEventId never appear, so there is
 * nothing resembling a real database id for the model to echo. Returns ""
 * (section omitted entirely) when there's nothing to show — an empty
 * labeled section is pure token cost. */
export function renderRelatedContext(chunks: RelatedContextChunk[] | undefined): string {
  if (!chunks || chunks.length === 0) return "";
  const sorted = [...chunks].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const lines = sorted
    .map((c) => {
      const date = c.occurredAt.slice(0, 10);
      const label = c.title ? `${c.title} — ` : "";
      return `- [${c.label} | ${c.sourceKind} | ${date}] ${label}${c.content}`;
    })
    .join("\n");
  return `RELATED CONTEXT (${chunks.length} excerpt(s), possibly relevant — retrieved by similarity, NOT part of today's activity and NOT authoritative. Ignore any that don't clearly relate.):\n${lines}`;
}

/** RELATED CONTEXT, then NEW EVENTS — RELATED CONTEXT first so it reads as
 * background the model brings TO the day's activity, not something
 * appended after it; NEW EVENTS last because it's the block every output
 * item must be grounded in. Both live in the user message, not system:
 * RELATED CONTEXT changes every run (uncacheable regardless of placement),
 * and keeping the two adjacent makes the advisory-vs-authoritative
 * contrast explicit in place. */
export function renderExtractionUserContent(context: ActionItemContext): string {
  const related = renderRelatedContext(context.relatedContext);
  const events = renderNewEvents(context);
  return related ? `${related}\n\n${events}` : events;
}

export const CONSOLIDATION_SYSTEM_PROMPT = `You are reconciling a batch of one or more draft action items against each other AND against already-tracked open work — some drafts may describe the same underlying issue as each other, or as an item already being tracked, even when worded differently (different phrasing, different level of detail, or written from a different connector's perspective).

Rules:
- Group draft items together if they describe the same underlying issue. A group can contain one draft (nothing to merge with another draft) or several.
- This still matters with only ONE draft in the batch: check it against OPEN ITEMS below just as carefully as you would a larger batch — a single new message about an issue already being tracked is exactly the case this exists to catch, not a special case to skip.
- If a group's issue matches an OPEN ITEM below, set matchesOpenItemId to that item's exact id from the list. Do not invent an id, and do not paraphrase its title — canonicalTitle is ignored for a matched group.
- If a group is genuinely new (no existing open item covers it), matchesOpenItemId is null and canonicalTitle must be stable and specific enough to match verbatim next time this issue comes up (e.g. "Fix flaky checkout test", not "Fix the test that broke today").
- mergedDescription should combine anything worth keeping from every draft in the group.
- kind, priority, confidence, and ownerHint should reflect the group as a whole (e.g. the highest priority/confidence among its drafts, adjusted if merging several corroborating drafts increases your confidence; keep an ownerHint if any draft in the group has one).
- Every draft key given to you must appear in exactly one group's draftKeys.`;

export function renderDraftsForConsolidation(drafts: DraftForConsolidation[]): string {
  return drafts
    .map(({ key, draft }) => {
      const text = [draft.title, draft.description].filter(Boolean).join(" — ");
      return `- key=${key} [${draft.kind}/${draft.priority}] confidence=${draft.confidence}\n  ${text}`;
    })
    .join("\n");
}

export function renderConsolidationUserContent(openActionItems: OpenActionItemSummary[], drafts: DraftForConsolidation[]): string {
  return `OPEN ITEMS:\n${renderOpenItems(openActionItems)}\n\nDRAFT ITEMS (${drafts.length}):\n${renderDraftsForConsolidation(drafts)}`;
}

/** Own version constant, separate from PROMPT_VERSION above — this versions
 * a different prompt's TEXT (see that constant's own doc comment on why
 * this file keeps versions next to the text they describe). Bump whenever
 * ENRICH_TASK_SYSTEM_PROMPT changes in a way that makes runs incomparable. */
export const ENRICH_PROMPT_VERSION = "enrich-task-v1";

export const ENRICH_TASK_SYSTEM_PROMPT = `A project manager has linked a new piece of context to an existing tracked task, because they judged it relevant. Decide whether the task's description should change as a result.

Rules:
- Never change the title — you are not given it to change, only asked to refine the description.
- Only use facts actually present in the task's current description or the new context below. Never invent or infer beyond what's written.
- Refine and fold in, don't replace wholesale — preserve everything in the current description that the new context doesn't contradict or extend.
- If the new context is tangential, already reflected, or doesn't add anything worth keeping, set changed to false and return the current description unchanged, verbatim.
- Never mention labels, ids, or where the context came from in the prose — write as if you always knew this.
- reason is a short (one sentence) note on what changed, or why nothing did.`;

export function renderTaskEnrichmentUserContent(context: TaskEnrichmentContext): string {
  const { project, task, newContext } = context;
  const date = newContext.occurredAt.slice(0, 10);
  const label = newContext.title ? `${newContext.title} — ` : "";
  return `Project: ${project.name}

TASK: ${task.title} [${task.kind}]
CURRENT DESCRIPTION:
${task.description ?? "(none)"}

NEW CONTEXT (${newContext.sourceKind}, ${date}):
${label}${newContext.content}`;
}
