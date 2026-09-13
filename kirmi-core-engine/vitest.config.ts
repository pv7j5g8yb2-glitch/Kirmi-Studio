import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // Integration tests hold real Postgres advisory and row locks. Running files
    // in parallel against one database turns a lock assertion into a coin flip,
    // so the suite is serialised on purpose.
    fileParallelism: false,
    hookTimeout: 30_000,
    testTimeout: 30_000,
    reporters: ["default"],
  },
});
