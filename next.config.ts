import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  // Disabled: its Babel-transform worker pool ("Jest worker encountered N
  // child process exceptions") was crashing repeatedly on this Windows +
  // Turbopack setup. Purely a render-optimization layer, not correctness —
  // safe to re-enable later if this environment gets more stable.
  reactCompiler: false,
};

export default nextConfig;
