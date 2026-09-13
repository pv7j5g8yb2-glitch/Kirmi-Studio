import { defineConfig } from "vitest/config";
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    globals: false,
    sequence: { concurrent: false },
    fileParallelism: false,
    testTimeout: 20000,
    hookTimeout: 30000,
  },
});
