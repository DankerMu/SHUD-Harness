import { availableParallelism } from "node:os";
import { defineConfig } from "vitest/config";

// Coverage floor mirrors constraints.yaml thresholds.coverage_percent_min; change it there first.
export default defineConfig({
  test: {
    include: ["packages/*/src/**/*.test.ts", "scripts/runtime/**/*.test.ts"],
    environment: "node",
    // Worker ceiling mirrors constraints.yaml thresholds.test_file_workers_max; change it there first.
    maxWorkers: Math.min(4, Math.max(1, availableParallelism() - 1)),
    coverage: {
      provider: "v8",
      include: ["packages/*/src/**/*.ts"],
      exclude: ["packages/*/src/**/*.test.ts", "packages/*/src/**/index.ts"],
      reporter: ["text-summary", "text"],
      thresholds: { lines: 80, statements: 80, functions: 80, branches: 80 },
    },
  },
});
