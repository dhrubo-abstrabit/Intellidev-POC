import { describe, expect, it } from "vitest";
import { createPdfLoader, loadPdfParse, preparePdfGlobals } from "./load";
import { MINIMAL_PDF } from "./__fixtures__/minimal-pdf";

describe("loadPdfParse", () => {
  it("resolves pdf-parse and extracts real text through pdfjs's fake-worker fallback", async () => {
    // This is the exact path that broke in production: pdf-parse wraps
    // pdfjs-dist, which (with no real Worker thread available) runs its
    // parsing logic through a "fake worker" fallback that needs
    // globalThis.DOMMatrix and globalThis.pdfjsWorker populated before it can
    // do anything — both set up by loadPdfParse() itself. A test that mocks
    // either of those away would prove nothing about this regression.
    const { PDFParse } = await loadPdfParse();
    const parser = new PDFParse({ data: Buffer.from(MINIMAL_PDF, "latin1") });
    try {
      const result = await parser.getText();
      expect(result.text).toContain("Hello PDF");
    } finally {
      await parser.destroy();
    }
  }, 30_000);
  // Explicit 30s timeout, well above vitest's 5s default. Not a slow
  // assertion — the work itself takes ~400ms warm. It is the one-off dynamic
  // import of pdfjs-dist inside loadPdfParse(): on a cold filesystem cache
  // (a fresh CI runner, or locally right after a build has evicted it) that
  // import alone was measured at over 7s, so the default timeout made this
  // test fail intermittently for reasons unrelated to what it verifies.
});

describe("createPdfLoader", () => {
  it("extracts real text and per-page metadata through the public loader API", async () => {
    // Exercises the same pdf-parse/pdfjs path as loadPdfParse above, but
    // through createPdfLoader's per-page splitting — the shape every real
    // caller (extractFileText, parseAttachmentText) actually consumes.
    await preparePdfGlobals();
    const loader = await createPdfLoader(new Blob([Buffer.from(MINIMAL_PDF, "latin1")]));
    const docs = await loader.load();
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toContain("Hello PDF");
    expect(docs[0].metadata.loc?.pageNumber).toBe(1);
    expect(docs[0].metadata.pdf?.totalPages).toBe(1);
  });
});
