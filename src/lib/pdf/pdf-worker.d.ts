/**
 * `pdfjs-dist` ships no `.d.ts` for its worker build (only `pd.d.mts` sits
 * next to it under `legacy/build/`) and declares no ambient `globalThis
 * .pdfjsWorker` — that global is an internal contract between `pdf.mjs`'s
 * fake-worker fallback and `pdf.worker.mjs`'s own self-registration at module
 * end; see `./load.ts` for why we populate it ourselves instead of letting
 * pdfjs discover it.
 *
 * `WorkerMessageHandler`'s real shape is a class pdfjs uses purely
 * internally — our own code never touches it beyond this pass-through
 * assignment, so `unknown` is the honest type here (unlike `DOMMatrix` in
 * `napi-geometry.d.ts`, which we type against the real DOM constructor
 * because we control that assignment's shape).
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.mjs" {
  export const WorkerMessageHandler: unknown;
}

// A plain top-level `declare var` in a script file (no import/export in this
// file, same as the sibling napi-geometry.d.ts) is itself a global
// declaration — no `declare global` wrapper needed, and mixing one in here
// stopped the ambient module declaration above from resolving.
// eslint-disable-next-line no-var -- ambient global declarations require `var`, not `let`/`const`
declare var pdfjsWorker: { WorkerMessageHandler: unknown } | undefined;
