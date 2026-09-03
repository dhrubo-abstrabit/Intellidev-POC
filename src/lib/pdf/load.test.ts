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
  });
});

describe("createPdfLoader", () => {
  it("extracts real text through LangChain's PDFLoader after preparePdfGlobals", async () => {
    // Same regression this file exists to prevent, exercised through the
    // second importer: @langchain/community's PDFLoader does its own bare
    // `import("pdf-parse")` internally and sets neither global itself, so
    // this only passes if preparePdfGlobals() ran first and the module
    // registry's cache is doing the work described in load.ts's doc comment.
    await preparePdfGlobals();
    const loader = await createPdfLoader(new Blob([Buffer.from(MINIMAL_PDF, "latin1")]));
    const docs = await loader.load();
    expect(docs).toHaveLength(1);
    expect(docs[0].pageContent).toContain("Hello PDF");
    expect(docs[0].metadata.loc.pageNumber).toBe(1);
    expect(docs[0].metadata.pdf.totalPages).toBe(1);
  });
});
