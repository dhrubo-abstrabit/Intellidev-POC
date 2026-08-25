import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Disabled: its Babel-transform worker pool ("Jest worker encountered N
  // child process exceptions") was crashing repeatedly on this Windows +
  // Turbopack setup. Purely a render-optimization layer, not correctness —
  // safe to re-enable later if this environment gets more stable.
  reactCompiler: false,
  // pdf-parse wraps pdfjs-dist, which resolves its worker script
  // (pdf.worker.mjs) relative to its OWN bundled module location at runtime.
  // Turbopack/webpack bundling that into a server chunk breaks that relative
  // lookup ("Setting up fake worker failed: Cannot find module
  // '.next/.../pdf.worker.mjs'"), even though the exact same bytes parse
  // fine outside a Next.js bundle (e.g. a plain `tsx` script). Opting the
  // package out of Server Components bundling makes Next.js `require()` it
  // natively from node_modules instead, where pdfjs-dist's own relative
  // lookup works exactly like it does everywhere else. Affects every PDF
  // parse call in the app, all of which go through src/lib/pdf/load.ts.
  //
  // Consequence worth knowing before touching this list: externalizing means
  // the package is require()d from /var/task/node_modules on Vercel, so
  // whether it exists at runtime is decided entirely by @vercel/nft's file
  // tracing. pdfjs-dist reaches for @napi-rs/canvas through an indirection nft
  // cannot follow, so that package is silently never deployed — which used to
  // kill every PDF parse in production. src/lib/pdf/load.ts documents the
  // mechanism and works around it; read it before changing anything here.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
  // The second half of that tracing problem, and the reason the comment above
  // is load-bearing rather than historical. Having been opted out of bundling,
  // pdfjs-dist resolves its worker at runtime by building an absolute path
  // beside its own module and importing that:
  //
  //     Cannot find module '/var/task/node_modules/pdfjs-dist/legacy/build/
  //     pdf.worker.mjs' imported from .../pdf.mjs
  //
  // nft cannot follow a computed specifier any more than it could follow the
  // @napi-rs/canvas require, so pdf.worker.mjs was traced into zero functions
  // and every parse died at "Setting up fake worker failed" — the exact error
  // the DOMMatrix fix in src/lib/pdf/load.ts uncovered underneath itself.
  //
  // Unlike DOMMatrix this cannot be solved by bundling: pdfjs needs a real file
  // at that exact node_modules path, so the file has to be copied in. Includes
  // are keyed by route glob and the values resolve from the project root, which
  // preserves the path (see next/dist/docs/.../next-config-js/output.md).
  // Bracket segments must be escaped or picomatch reads them as char classes.
  //
  // Scoped to the two routes that parse PDFs rather than "/*" — it is ~2MB, and
  // every other function has no use for it. pdfjs's cmaps/standard_fonts/wasm
  // directories are deliberately not included: pdf-parse never sets their URLs
  // and getText() does not need them (they cover CJK cmaps and image decoding,
  // not text extraction).
  outputFileTracingIncludes: {
    "/api/jobs/attachments": ["node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs"],
    "/w/\\[workspaceId\\]/p/\\[projectId\\]/project-context": [
      "node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs",
    ],
  },
};

export default nextConfig;
