import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnalysisPlanSchema } from "@shud-harness/dsh-shud-core";
import { expect, test } from "vitest";
import {
  buildSensitivitySummary,
  evaluateClosure,
  readRunMetrics,
  serializeSensitivitySummary,
} from "./index.ts";
import { freezeEvidence } from "./code-change-closure-test-harness.ts";
import { digest } from "./run-metrics-test-harness.ts";
import { failCell, retryCell, sensitivityEvidence } from "./sensitivity-closure-test-harness.ts";
import {
  BASELINE_METRICS_BYTES,
  BASELINE_METRICS_SHA256,
  EXPECTED_SUMMARY_BYTES,
  EXPECTED_SUMMARY_SHA256,
  PERTURBED_METRICS_BYTES,
  PERTURBED_METRICS_SHA256,
  SUMMARY_PLAN_BYTES,
  SUMMARY_PLAN_SHA256,
} from "./sensitivity-summary-test-harness.ts";

test("summary bytes preserve baseline deltas, failed cells and the superseded attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "sensitivity-summary-"));
  try {
    const input = sensitivityEvidence();
    input.plan = AnalysisPlanSchema.parse(JSON.parse(SUMMARY_PLAN_BYTES));
    input.runJobs = input.runJobs.slice(0, 3);
    input.records = input.records.slice(0, 3);
    input.card.linked_jobs = input.card.linked_jobs.slice(0, 3);
    retryCell(input, 1, "JOB-20261108T093000-0004");
    failCell(input, 1);
    failCell(input, 2);
    for (const [index, bytes, sha256] of [
      [0, BASELINE_METRICS_BYTES, BASELINE_METRICS_SHA256],
      [3, PERTURBED_METRICS_BYTES, PERTURBED_METRICS_SHA256],
    ] as const) {
      const record = input.records[index];
      record.artifacts.metrics_summary = { path: "metrics.json", sha256 };
      const directory = join(root, record.run_id);
      mkdirSync(directory);
      writeFileSync(join(directory, "metrics.json"), bytes);
      expect(digest(bytes)).toBe(sha256);
    }
    const closure = evaluateClosure(input.card, input.runJobs, input.records, input.draft, {
      readAnalysisPlan: () => input.plan,
      readRunMetrics: (runId, sha256) => readRunMetrics(join(root, runId), sha256),
    });
    expect(closure.ok).toBe(true);
    if (!closure.ok) throw new Error("Expected a successful sensitivity closure");
    const before = structuredClone(closure);
    freezeEvidence(closure);
    const planBytes = Buffer.from(SUMMARY_PLAN_BYTES);
    expect(digest(planBytes)).toBe(SUMMARY_PLAN_SHA256);

    const summary = buildSensitivitySummary(closure, planBytes);
    const bytes = serializeSensitivitySummary(summary);

    expect(bytes).toBe(EXPECTED_SUMMARY_BYTES);
    expect(Buffer.byteLength(bytes)).toBe(2630);
    expect(digest(bytes)).toBe(EXPECTED_SUMMARY_SHA256);
    expect(serializeSensitivitySummary(buildSensitivitySummary(closure, planBytes))).toBe(bytes);
    expect(closure).toStrictEqual(before);
    expect(planBytes.equals(Buffer.from(SUMMARY_PLAN_BYTES))).toBe(true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
