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
  // parse call in the app: project-context/actions.ts's extractFileText and
  // services/attachments/parse.ts.
  serverExternalPackages: ["pdf-parse", "pdfjs-dist"],
};

export default nextConfig;
