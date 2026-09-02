import { describe, expect, it } from "vitest";
import { chunkText, contentHash } from "./chunk";

describe("chunkText", () => {
  it("returns nothing for empty/whitespace-only input", () => {
    expect(chunkText("")).toEqual([]);
    expect(chunkText("   \n\n  ")).toEqual([]);
  });

  it("returns the whole text as one chunk when it already fits", () => {
    const text = "Short message that fits in one chunk.";
    expect(chunkText(text, { chunkSize: 1000 })).toEqual([text]);
  });

  it("splits long text into multiple chunks", () => {
    const sentence = "This is one sentence about the project status. ";
    const text = sentence.repeat(40); // well over the small test chunkSize below
    const chunks = chunkText(text, { chunkSize: 200, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeGreaterThan(0);
    }
  });

  it("carries overlap context from the end of one chunk into the start of the next", () => {
    const sentences = Array.from({ length: 10 }, (_, i) => `Sentence number ${i} describes update ${i}.`);
    const text = sentences.join(" ");
    const overlap = 20;
    const chunks = chunkText(text, { chunkSize: 80, overlap });
    expect(chunks.length).toBeGreaterThan(1);
    // Each chunk after the first should start with (a trim of) the exact
    // tail slice carried forward from the previous one — the same
    // computation chunkText itself does internally.
    for (let i = 1; i < chunks.length; i++) {
      const tail = chunks[i - 1].slice(-overlap).trim();
      expect(chunks[i].startsWith(tail)).toBe(true);
    }
  });

  it("hard-splits a single sentence longer than chunkSize", () => {
    const wallOfText = "a".repeat(250);
    const chunks = chunkText(wallOfText, { chunkSize: 100, overlap: 10 });
    expect(chunks.length).toBe(3);
    expect(chunks.join("")).toBe(wallOfText);
  });

  it("respects a custom chunkSize/overlap", () => {
    const text = "word ".repeat(100).trim();
    const chunks = chunkText(text, { chunkSize: 50, overlap: 5 });
    expect(chunks.length).toBeGreaterThan(1);
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
