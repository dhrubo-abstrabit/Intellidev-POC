/**
 * `@napi-rs/canvas` publishes no `exports` map (so any subpath is importable)
 * but ships types only for its main entry — and that entry loads the native
 * Skia binding. We deliberately import the `geometry.js` subpath instead, which
 * is dependency-free pure JS; see `./load.ts` for the full reasoning.
 *
 * Declares exactly what that file exports (`module.exports = { DOMPoint,
 * DOMMatrix, DOMRect }`), typed against the standard DOM constructors so an
 * assignment onto `globalThis` is type-identical rather than a cast.
 */
declare module "@napi-rs/canvas/geometry.js" {
  export const DOMPoint: typeof globalThis.DOMPoint;
  export const DOMMatrix: typeof globalThis.DOMMatrix;
  export const DOMRect: typeof globalThis.DOMRect;
}
