import { defineConfig } from 'vitest/config'

// A boundary, not a preference.
//
// Vitest and Vite both resolve their config by searching upward from the package they run in.
// That was harmless while this monorepo was a repository root. As a subdirectory it is not: the
// search escapes the subtree and finds the Next app's config at the repository root, which
// points its test include at that app's own source directory and loads a Tailwind PostCSS
// plugin absent from this workspace. The symptoms were "No test files found" and
// "Cannot find module '@tailwindcss/postcss'" — both caused by where this directory now sits.
//
// Line comments, not a block: the globs involved contain a star followed by a slash, which ends
// a block comment early. The first version of this file did exactly that and failed to parse.
//
// Everything here is vitest's own default. The file exists so that the search stops.
export default defineConfig({
  css: { postcss: { plugins: [] } },
})
