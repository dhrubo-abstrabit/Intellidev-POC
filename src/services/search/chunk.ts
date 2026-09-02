import "server-only";
import { createHash } from "node:crypto";
import { toBytea } from "@/lib/db/bytea";

const DEFAULT_CHUNK_SIZE = 1000; // matches search_chunks' own column comment: "~1000 chars, 15% overlap"
const DEFAULT_OVERLAP = 150;

/** Splits on paragraph breaks first, then sentence-ending punctuation within
 * each paragraph — a plain char-count slice would cut mid-word/mid-sentence,
 * which both looks wrong in a preview and drops half a thought across a
 * chunk boundary the embedding then can't see whole. */
function splitIntoSentences(text: string): string[] {
  const paragraphs = text.replace(/\r\n/g, "\n").split(/\n{2,}/);
  const sentences: string[] = [];
  for (const paragraph of paragraphs) {
    for (const sentence of paragraph.split(/(?<=[.!?])\s+/)) {
      const trimmed = sentence.trim();
      if (trimmed) sentences.push(trimmed);
    }
  }
  return sentences;
}

/**
 * Splits text into ~chunkSize-char windows, carrying the previous chunk's
 * last `overlap` chars forward into the next one — so a sentence split
 * across a chunk boundary still has its immediate context on both sides.
 * Packs whole sentences greedily rather than slicing at a fixed offset;
 * `chunkSize`/`overlap` are soft targets, not hard caps (a chunk can run a
 * little over once its carried-forward overlap is added back).
 *
 * A single sentence longer than `chunkSize` (a wall-of-text paragraph with
 * no punctuation) is hard-split at the character level — it has no smaller
 * unit to pack by, and it must not be allowed to produce one unbounded chunk.
 */
export function chunkText(text: string, opts?: { chunkSize?: number; overlap?: number }): string[] {
  const chunkSize = opts?.chunkSize ?? DEFAULT_CHUNK_SIZE;
  const overlap = opts?.overlap ?? DEFAULT_OVERLAP;

  const trimmed = text.trim();
  if (!trimmed) return [];
  if (trimmed.length <= chunkSize) return [trimmed];

  const chunks: string[] = [];
  let current = "";

  for (const sentence of splitIntoSentences(trimmed)) {
    if (sentence.length > chunkSize) {
      if (current) {
        chunks.push(current);
        current = "";
      }
      for (let i = 0; i < sentence.length; i += chunkSize) {
        chunks.push(sentence.slice(i, i + chunkSize));
      }
      continue;
    }

    const candidate = current ? `${current} ${sentence}` : sentence;
    if (candidate.length > chunkSize && current) {
      chunks.push(current);
      const tail = current.slice(Math.max(0, current.length - overlap));
      current = `${tail} ${sentence}`.trim();
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks;
}

/** sha256 of a chunk's content, bytea-ready (see lib/db/bytea.ts) — gates
 * re-chunking/re-embedding on genuinely changed text, matching
 * search_chunks.content_hash's purpose. */
export function contentHash(content: string): string {
  return toBytea(createHash("sha256").update(content, "utf8").digest());
}
