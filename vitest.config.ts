import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      // "server-only" always throws unless the bundler sets the
      // `react-server` resolve condition (which Next.js does, Vitest
      // doesn't). Alias to the package's own no-op export so unit tests can
      // import server modules under plain Node. This does not weaken the
      // production guarantee — Next.js's own build still throws if a
      // server-only module is pulled into a client bundle.
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    // Integration tests hit the real local Supabase instance (see
    // run-sync.integration.test.ts) — excluded from the default unit-test
    // run so `npm test` never depends on Docker being up; run explicitly
    // with `npm run test:integration`.
    exclude: ["**/*.integration.test.ts", "**/node_modules/**"],
  },
});
