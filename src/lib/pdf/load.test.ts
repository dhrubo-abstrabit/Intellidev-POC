import { describe, expect, it } from "vitest";
import { loadPdfParse } from "./load";

// Minimal hand-built single-page PDF containing the text "Hello PDF" — small
// enough to inline rather than adding a binary-fixture convention this
// codebase doesn't otherwise have. Verified locally to parse before relying
// on it here.
const MINIMAL_PDF = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Resources<</Font<</F1 4 0 R>>>>/Contents 5 0 R>>endobj
4 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
5 0 obj<</Length 44>>stream
BT /F1 24 Tf 10 40 Td (Hello PDF) Tj ET
endstream
endobj
trailer<</Size 6/Root 1 0 R>>
%%EOF`;

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
