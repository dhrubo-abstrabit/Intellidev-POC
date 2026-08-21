import "server-only";

/**
 * The only place `pdf-parse` may be imported from. Import it directly and PDF
 * parsing works locally and dies in production — this function is what closes
 * that gap, so route every call site through it.
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
 * Adding a THIRD call site needs one more step: `pdf.worker.mjs` is delivered
 * per-route by `outputFileTracingIncludes` in next.config.ts (it is invisible to
 * the tracer for the same reason, and unlike DOMMatrix it cannot be bundled —
 * pdfjs needs a real file at that exact node_modules path). Add the new route to
 * that map, or PDF parsing will work locally and fail once deployed with
 * "Setting up fake worker failed".
 *
 * Note `@napi-rs/canvas` is deliberately *not* in our own `dependencies`. It
 * arrives hoisted via `pdf-parse`'s exact pin, which keeps us on the same
 * version pdfjs was built against; declaring our own pin means keeping it in
 * lockstep by hand, and any drift reinstates a second, nested copy.
 */
export async function loadPdfParse() {
  if (!globalThis.DOMMatrix) {
    const { DOMMatrix } = await import("@napi-rs/canvas/geometry.js");
    globalThis.DOMMatrix = DOMMatrix;
  }
  return import("pdf-parse");
}
