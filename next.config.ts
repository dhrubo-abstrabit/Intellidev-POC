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
};

export default nextConfig;
