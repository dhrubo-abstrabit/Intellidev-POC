import { build } from 'esbuild'
import { chmod, mkdir } from 'node:fs/promises'

/**
 * Bundle the adapter into two single files for the golden image.
 *
 * Bundling rather than shipping `node_modules`: the image gets two files instead of a
 * dependency tree, layer rebuilds are fast, and there is no install step at container
 * start — which would otherwise sit inside the dispatch budget.
 *
 * `intellidev-cred` is a separate entry because git spawns it on **every** authenticated
 * operation. Loading the whole adapter to answer one credential request would add
 * measurable latency to every push.
 */
const shared = {
  bundle: true,
  platform: 'node',
  target: 'node22',
  format: 'esm',
  // Node built-ins stay external; everything else is inlined.
  packages: 'bundle',
  external: ['node:*'],
  banner: {
    // The MCP SDK and its deps reach for `require` in places; ESM output needs a shim.
    js: [
      "import { createRequire as __cr } from 'node:module'",
      'const require = __cr(import.meta.url)',
    ].join('\n'),
  },
  logLevel: 'info',
  minify: false,
  sourcemap: 'linked',
}

await mkdir('dist', { recursive: true })

await build({
  ...shared,
  entryPoints: { 'intellidev-adapter': 'src/cli/adapter.ts' },
  outdir: 'dist',
})

await build({
  ...shared,
  entryPoints: { 'intellidev-cred': 'src/cli/cred.ts' },
  outdir: 'dist',
})

await chmod('dist/intellidev-adapter.js', 0o755)
await chmod('dist/intellidev-cred.js', 0o755)
console.log('bundled → packages/adapter/dist/')
