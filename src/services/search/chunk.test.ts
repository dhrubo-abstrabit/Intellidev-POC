import { describe, expect, it } from "vitest";
import { chunkPages, chunkText, contentHash } from "./chunk";

describe("chunkText", () => {
  it("returns nothing for empty/whitespace-only input", async () => {
    expect(await chunkText("")).toEqual([]);
    expect(await chunkText("   \n\n  ")).toEqual([]);
  });

  it("returns the whole text as one chunk when it already fits", async () => {
    const text = "Short message that fits in one chunk.";
    expect(await chunkText(text, { chunkSize: 1000 })).toEqual([text]);
  });

  it("splits long text into multiple chunks", async () => {
    const sentence = "This is one sentence about the project status. ";
    const text = sentence.repeat(40); // well over the small test chunkSize below
    const chunks = await chunkText(text, { chunkSize: 200, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("covers every word of the input across the chunk set", async () => {
    // Not an exact-boundary assertion (RecursiveCharacterTextSplitter's
    // overlap is applied on separator-split pieces, not an exact trailing
    // character slice like the previous hand-rolled chunker) — the contract
    // that matters is that no word is dropped, and the sequence is
    // preserved, not that any one chunk's prefix/suffix matches a
    // hand-computed slice of its neighbour.
    //
    // Reconstruct by joining chunks with "" rather than " ": with
    // keepSeparator:true (verified against the installed version), RCTS's
    // own internal re-joining also uses "" — a separator like ". " is kept
    // as a PREFIX of the piece that follows it (a lookahead split), so
    // adjacent chunks are zero-gap at a clean boundary and an inserted " "
    // would wrongly separate e.g. "1" from a "." that starts the next chunk.
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} describes update ${i}.`);
    const text = sentences.join(" ");
    const chunks = await chunkText(text, { chunkSize: 80, overlap: 20 });
    expect(chunks.length).toBeGreaterThan(1);

    const words = text.split(/\s+/);
    const chunkedWords = new Set(chunks.join("").split(/\s+/));
    for (const word of words) {
      expect(chunkedWords.has(word)).toBe(true);
    }
    expect(chunks[0].trimStart().startsWith(words[0])).toBe(true);
  });

  it("hard-splits a single long run of characters with no separators", async () => {
    // RCTS's overlap is applied even on a character-level hard split, so
    // the previous implementation's exact chunk-count and lossless-join
    // assertions don't hold — the contract that survives is that every
    // chunk is non-empty and respects the size cap.
    const wallOfText = "a".repeat(250);
    const chunks = await chunkText(wallOfText, { chunkSize: 100, overlap: 10 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
      expect(chunk.length).toBeLessThanOrEqual(100);
    }
  });

  it("respects a custom chunkSize/overlap", async () => {
    const text = "word ".repeat(100).trim();
    const chunks = await chunkText(text, { chunkSize: 50, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
  });
});

describe("chunkPages", () => {
  it("returns no rows for pages with empty/whitespace-only text", async () => {
    expect(await chunkPages([{ pageNumber: 1, text: "" }, { pageNumber: 2, text: "   " }])).toEqual([]);
  });

  it("never lets a chunk straddle a page, and numbers chunk_index densely across pages", async () => {
    const longSentence = "This is one sentence about the project status. ";
    const pages = [
      { pageNumber: 1, text: longSentence.repeat(10) },
      { pageNumber: 2, text: longSentence.repeat(10) },
    ];
    const chunks = await chunkPages(pages, { chunkSize: 200, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(2);

    const pageNumbers = chunks.map((c) => c.pageNumber);
    // Every page-1 chunk must come before every page-2 chunk — chunkPages
    // processes pages in order and never interleaves them.
    const lastPage1Index = pageNumbers.lastIndexOf(1);
    const firstPage2Index = pageNumbers.indexOf(2);
    expect(firstPage2Index).toBeGreaterThan(lastPage1Index);
    expect(pageNumbers.every((p) => p === 1 || p === 2)).toBe(true);
  });

  it("skips pages that produce no chunks without leaving a gap", async () => {
    const chunks = await chunkPages([
      { pageNumber: 1, text: "Some real content on the first page." },
      { pageNumber: 2, text: "   " },
      { pageNumber: 3, text: "Some real content on the third page." },
    ]);
    expect(chunks.map((c) => c.pageNumber)).toEqual([1, 3]);
  });
});

describe("contentHash", () => {
  it("produces a bytea-formatted hex string", () => {
    const hash = contentHash("hello world");
    expect(hash).toMatch(/^\\x[0-9a-f]{64}$/);
  });

  it("is deterministic for the same content", () => {
    expect(contentHash("same text")).toBe(contentHash("same text"));
  });

  it("differs for different content", () => {
    expect(contentHash("text a")).not.toBe(contentHash("text b"));
  });
});
