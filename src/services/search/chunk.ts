import "server-only";
import { createHash } from "node:crypto";
import { RecursiveCharacterTextSplitter } from "@langchain/textsplitters";
import { toBytea } from "@/lib/db/bytea";

const DEFAULT_CHUNK_SIZE = 1000; // matches search_chunks' own column comment: "~1000 chars, 15% overlap"
const DEFAULT_OVERLAP = 150;

// Sentence/paragraph-aware, tried in this order until pieces are small
// enough — RecursiveCharacterTextSplitter's own defaults (["\n\n","\n","",""])
// have no punctuation awareness and would cut mid-sentence far more often
// than this codebase's previous hand-rolled chunker did.
const SEPARATORS = ["\n\n", "\n", ". ", "! ", "? ", " ", ""];

function makeSplitter(chunkSize: number, chunkOverlap: number): RecursiveCharacterTextSplitter {
  return new RecursiveCharacterTextSplitter({
    chunkSize,
    chunkOverlap,
    separators: SEPARATORS,
    // This is RecursiveCharacterTextSplitter's own default (unlike the base
    // TextSplitter's false) — set explicitly rather than relied on
    // implicitly. Verified against the installed version: it splits via a
    // lookahead, so a separator becomes the START of the piece that follows
    // it, and pieces are rejoined with "" (the separator characters are
    // already embedded). A chunk boundary can occasionally land right after
    // a separator, so the next chunk opens with ". "/"! " etc. — cosmetic,
    // not a content loss, and still better than cuts with no separator
    // awareness at all.
    keepSeparator: true,
  });
}

/**
 * Splits text into ~chunkSize-char windows via LangChain's
 * RecursiveCharacterTextSplitter, sentence/paragraph-aware via SEPARATORS
 * above. `chunkSize`/`overlap` are soft targets, not hard caps — RCTS packs
 * greedily against them the same way the previous implementation did.
 */
export async function chunkText(text: string, opts?: { chunkSize?: number; overlap?: number }): Promise<string[]> {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts?.overlap ?? DEFAULT_OVERLAP;

  const trimmed = text.trim();
  if (!trimmed) return [];

  return makeSplitter(chunkSize, overlap).splitText(trimmed);
}

export interface PageChunk {
  content: string;
  pageNumber: number;
}

/**
 * Per-page chunking for paginated sources (PDF attachments) — a chunk never
 * straddles a page, so page_number is exact rather than inferred. Chunking
 * is not offset-preserving (RecursiveCharacterTextSplitter returns no
 * offsets into its input), which is why this exists as a separate entry
 * point rather than trying to recover page numbers from a
 * concatenate-then-chunk result after the fact.
 *
 * Returns a flat list, not one array per page: chunk_index across the whole
 * document must stay dense from zero (search_chunks' unique(source_kind,
 * source_id, chunk_index) constraint) — callers must number from this
 * list's order, never restart per page.
 */
export async function chunkPages(
  pages: { pageNumber: number; text: string }[],
  opts?: { chunkSize?: number; overlap?: number },
): Promise<PageChunk[]> {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts?.overlap ?? DEFAULT_OVERLAP;
  const splitter = makeSplitter(chunkSize, overlap);

  const result: PageChunk[] = [];
  for (const page of pages) {
    const trimmed = page.text.trim();
    if (!trimmed) continue;
    for (const content of await splitter.splitText(trimmed)) {
      result.push({ content, pageNumber: page.pageNumber });
    }
  }
  return result;
}

/** sha256 of a chunk's content, bytea-ready (see lib/db/bytea.ts). Not
 * currently read back anywhere (see search_chunks.content_hash's own
 * comment) — retained for a future re-chunk/re-embed gate. */
export function contentHash(content: string): string {
  return toBytea(createHash("sha256").update(content, "utf8").digest());
}
