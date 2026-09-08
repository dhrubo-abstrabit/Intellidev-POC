import "server-only";

/** Minimal shape shared by `createPdfLoader`/`createDocxLoader` output —
 * mirrors the `Document[]` contract callers were already written against
 * (from when these wrapped LangChain's loaders), so no caller needed to
 * change when the wrapping was replaced by calling `pdf-parse`/`mammoth`
 * directly. */
export interface LoadedDocument {
  pageContent: string;
  metadata: {
    loc?: { pageNumber: number };
    pdf?: { totalPages: number };
  };
}

export interface DocumentLoader {
  load(): Promise<LoadedDocument[]>;
}

/**
 * Every PDF parse in this app must go through `createPdfLoader` (or
 * `loadPdfParse` for the raw `pdf-parse` module) — never import `pdf-parse`
 * or `pdfjs-dist` directly. Doing so skips the global-prep below and
 * reintroduces the production outage this file exists to prevent.
 *
 * This is the only place `pdf-parse` is imported from anywhere in this repo
 * (an ESLint `no-restricted-imports` rule blocks every other import path our
 * own code could take), so there is exactly one ordering to guarantee:
 * `preparePdfGlobals()` always runs before the first `import("pdf-parse")`.
 *
 * ## Why
 *
 * `pdf-parse` wraps `pdfjs-dist`, whose Node build reaches for
 * `@napi-rs/canvas` at import time to polyfill the browser globals it renders
 * through (`node_modules/pdfjs-dist/legacy/build/pdf.mjs`):
 *
 *     const require = process.getBuiltinModule("module").createRequire(import.meta.url);
 *     canvas = require("@napi-rs/canvas");
 *     if (!globalThis.DOMMatrix) { ... warn("Cannot polyfill `DOMMatrix` ...") }
 *
 * `@vercel/nft` — the tracer that decides which `node_modules` files get copied
 * into a deployed function — statically models `import { createRequire } from
 * "module"`, but not that `process.getBuiltinModule("module").createRequire(…)`
 * indirection. So it never records the edge to `@napi-rs/canvas`, and the
 * package is left out of the Lambda even though it is a hard dependency of
 * `pdf-parse` and sits in `node_modules` on the build machine. (Confirmed from
 * the build's own trace manifest: `.next/server/app/api/jobs/attachments/
 * route.js.nft.json` listed 21 `pdf-parse` files and zero `@napi-rs/canvas`
 * ones. `serverExternalPackages` in next.config.ts is what makes pdfjs resolve
 * from `/var/task/node_modules` at runtime rather than being bundled, so
 * tracing is the *only* thing that could have put it there.)
 *
 * The two warnings pdfjs emits when the package is missing read as cosmetic
 * ("rendering may be broken") but are not: `pdf.mjs` later evaluates a
 * module-scope `const SCALE_MATRIX = new DOMMatrix()`, which throws
 * `ReferenceError: DOMMatrix is not defined` and takes the entire module down.
 * The import then fails as `Failed to load external module pdf-parse-…`, so in
 * production *every* PDF parse failed outright — not just rendering. Node has
 * no native `DOMMatrix`, so nothing else fills the gap.
 *
 * ## The fix
 *
 * Set the global ourselves, before pdfjs can look for it. `@napi-rs/canvas`
 * implements its geometry types as dependency-free pure JS (`geometry.js`
 * imports nothing but `node:util`) — entirely separate from the ~37MB Skia
 * binary that the package's main entry loads. A static-specifier import of that
 * subpath is something the bundler *can* see, so it is compiled into the server
 * chunk and no longer depends on tracing. pdfjs's own `if (!globalThis
 * .DOMMatrix)` guard then finds it already populated and skips the polyfill it
 * cannot perform.
 *
 * `DOMMatrix` is the only one of the three globals `pdf.mjs` touches at
 * module-evaluation time; `ImageData` and `Path2D` are reached only from
 * rendering paths that `getText()` never enters, so they are intentionally left
 * unset — a stub would turn a loud failure into a silently wrong one. Expect
 * pdfjs to still log `Cannot load "@napi-rs/canvas" package` plus "Cannot
 * polyfill" for those two on a cold start: harmless, and much cheaper than
 * forcing the Skia binary into every function that parses a PDF.
 *
 * ## The worker-file gap
 *
 * `outputFileTracingIncludes` in next.config.ts fixes the tracing half of that
 * problem — it force-copies `pdf.worker.mjs` to the exact `node_modules` path
 * pdfjs computes at runtime, so its own `await import(this.workerSrc)` finds a
 * real file there and succeeds. But that call is still reached through the same
 * kind of tracer-invisible indirection as the `@napi-rs/canvas` require above
 * (`workerSrc` is read back through a class getter, not a literal specifier at
 * the call site — see `pdfjs-dist/legacy/build/pdf.mjs`'s `PDFWorker
 * .#mainThreadWorkerMessageHandler` / `_setupFakeWorkerGlobal`), so relying on
 * it alone means every new call site has to remember to extend that map (the
 * paragraph this replaced used to warn exactly that), and the outcome still
 * depends on the tracer's behavior being reproduced correctly on every build.
 *
 * pdfjs provides an escape hatch: if `globalThis.pdfjsWorker.WorkerMessageHandler`
 * is already set, `_setupFakeWorkerGlobal` returns it directly and never reaches
 * the dynamic import at all. `pdf.worker.mjs` sets this on itself at module end
 * whenever it does get loaded — so importing it here, through a literal
 * specifier our own bundler *can* see (same trick as `@napi-rs/canvas/geometry.js`
 * above, just still externalized rather than inlined, since `pdfjs-dist` — unlike
 * `@napi-rs/canvas` — is in `serverExternalPackages`), does the same
 * self-registration ourselves, before pdfjs ever looks. That makes the fragile
 * computed-specifier import unreachable regardless of call site, on top of
 * `outputFileTracingIncludes` still guaranteeing the file is physically present.
 * Belt and suspenders, not a replacement: keep both.
 *
 * Note `@napi-rs/canvas` is deliberately *not* in our own `dependencies`. It
 * arrives hoisted via `pdf-parse`'s exact pin, which keeps us on the same
 * version pdfjs was built against; declaring our own pin means keeping it in
 * lockstep by hand, and any drift reinstates a second, nested copy.
 */
export async function preparePdfGlobals(): Promise<void> {
  if (!globalThis.DOMMatrix) {
    const { DOMMatrix } = await import("@napi-rs/canvas/geometry.js");
    globalThis.DOMMatrix = DOMMatrix;
  }
  if (!globalThis.pdfjsWorker) {
    const { WorkerMessageHandler } = await import("pdfjs-dist/legacy/build/pdf.worker.mjs");
    globalThis.pdfjsWorker = { WorkerMessageHandler };
  }
}

/** Raw `pdf-parse` module access, for callers that need the `PDFParse` class
 * directly rather than the per-page `LoadedDocument[]` shape. Prefer
 * `createPdfLoader` for anything that can consume `LoadedDocument[]`. */
export async function loadPdfParse() {
  await preparePdfGlobals();
  return import("pdf-parse");
}

/**
 * The only way to parse a PDF into `LoadedDocument[]` — going around this
 * (e.g. constructing `PDFParse` directly) skips `preparePdfGlobals()` and
 * reintroduces the outage documented above. `splitPages` defaults to `true`
 * so callers get one `LoadedDocument` per page with `metadata.loc.pageNumber`
 * populated, matching the shape callers were already written against.
 */
export async function createPdfLoader(blob: Blob, opts?: { splitPages?: boolean }): Promise<DocumentLoader> {
  await preparePdfGlobals();
  const { PDFParse } = await import("pdf-parse");
  const splitPages = opts?.splitPages ?? true;
  return {
    async load() {
      const data = new Uint8Array(await blob.arrayBuffer());
      const parser = new PDFParse({ data });
      try {
        const result = await parser.getText();
        if (!splitPages) {
          return [{ pageContent: result.text, metadata: { pdf: { totalPages: result.total } } }];
        }
        return result.pages.map((page) => ({
          pageContent: page.text,
          metadata: { loc: { pageNumber: page.num }, pdf: { totalPages: result.total } },
        }));
      } finally {
        await parser.destroy();
      }
    },
  };
}

/** DOCX has no pagination concept, hence no globals to prepare and always a
 * single-element result — this exists purely for symmetry with
 * `createPdfLoader` as the one PDF/DOCX loader factory module. */
export async function createDocxLoader(blob: Blob): Promise<DocumentLoader> {
  return {
    async load() {
      const mammoth = await import("mammoth");
      const arrayBuffer = await blob.arrayBuffer();
      const { value } = await mammoth.extractRawText({ buffer: Buffer.from(arrayBuffer) });
      return [{ pageContent: value, metadata: {} }];
    },
  };
}
