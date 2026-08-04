import path from "node:path";
import { defineConfig } from "vitest/config";

// Loads .env.local so tests get the same Supabase URL/keys the dev server
// uses — these tests hit the real local Supabase instance, not a mock.
process.loadEnvFile(path.resolve(__dirname, ".env.local"));

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "server-only": path.resolve(__dirname, "node_modules/server-only/empty.js"),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    // These run sequentially against one shared local DB, not in isolated
    // workers — parallel workers would race on the same tables.
    fileParallelism: false,
  },
});
