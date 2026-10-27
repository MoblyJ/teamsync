import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests shell out to real git and fake gh shims; run files
    // in parallel but tests within a file sequentially (they share fixtures).
    pool: "threads",
    poolOptions: { threads: { singleThread: false } },
  },
});
