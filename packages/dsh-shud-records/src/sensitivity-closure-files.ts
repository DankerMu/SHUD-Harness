import { lstatSync } from "node:fs";
import { AnalysisPlanIdSchema, RunIdSchema } from "@shud-harness/dsh-shud-core";
import { readRunMetrics } from "./run-metrics-wire.ts";
import type { SensitivityObjectLoaders } from "./sensitivity-closure-types.ts";
import { resolveManagedRoot } from "./workspace-paths.ts";
import { readWorkspaceRecord } from "./workspace-records.ts";

/**
 * Linked-id-only, non-creating readers. Session cwd may be a physical alias; managed roots
 * and run directories may not be links. Metrics use the canonical no-follow/digest/parser
 * reader, with observed root/run identities rechecked, not an atomic snapshot guarantee.
 */
export function createSensitivityClosureLoaders(cwd: string): SensitivityObjectLoaders {
  return {
    readAnalysisPlan(id) {
      return readWorkspaceRecord(cwd, "analysis", AnalysisPlanIdSchema.parse(id), {
        readonly: true,
      });
    },
    readRunMetrics(runId, expectedSha256) {
      const id = RunIdSchema.parse(runId);
      const root = resolveManagedRoot(cwd, "runs", "Sensitivity runs", true);
      if (root === undefined) throw new Error("Missing sensitivity runs directory");
      const rootBefore = lstatSync(root);
      if (!rootBefore.isDirectory()) throw new Error("Unsafe sensitivity runs directory");
      const run = `${root}/${id}`;
      const before = lstatSync(run);
      if (!before.isDirectory()) throw new Error("Unsafe sensitivity run directory");
      const metrics = readRunMetrics(run, expectedSha256);
      const rootAfter = lstatSync(`${cwd || "."}/runs`);
      const after = lstatSync(run);
      if (
        !rootAfter.isDirectory() ||
        rootBefore.dev !== rootAfter.dev ||
        rootBefore.ino !== rootAfter.ino ||
        !after.isDirectory() ||
        before.dev !== after.dev ||
        before.ino !== after.ino
      ) {
        throw new Error("Sensitivity run directory changed during read");
      }
      return metrics;
    },
  };
}
