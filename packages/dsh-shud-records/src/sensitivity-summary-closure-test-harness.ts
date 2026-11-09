import type { RunId } from "@shud-harness/dsh-shud-core";
import { evaluateClosure, type RunMetrics } from "./index.ts";
import { serializeRunMetrics } from "./run-metrics-wire.ts";
import { digest } from "./run-metrics-test-harness.ts";
import {
  sensitivityEvidence,
  type SensitivityEvidence,
} from "./sensitivity-closure-test-harness.ts";

interface SummaryEvidence {
  input: SensitivityEvidence;
  metrics: Map<RunId, RunMetrics>;
}

export function summaryEvidence(): SummaryEvidence {
  const input = sensitivityEvidence();
  const metrics = new Map<RunId, RunMetrics>(
    input.records.map((record) => [record.run_id, structuredClone(input.metrics)]),
  );
  return { input, metrics };
}

export function closeSummaryEvidence({ input, metrics }: SummaryEvidence) {
  for (const record of input.records) {
    if (record.status !== "succeeded") continue;
    const value = metrics.get(record.run_id);
    if (value === undefined) throw new Error("Missing test metrics");
    record.artifacts.metrics_summary = {
      path: "metrics.json",
      sha256: digest(serializeRunMetrics(value)),
    };
  }
  const closure = evaluateClosure(input.card, input.runJobs, input.records, input.draft, {
    readAnalysisPlan: () => input.plan,
    readRunMetrics: (id, expected) => {
      const value = metrics.get(id);
      if (value === undefined || digest(serializeRunMetrics(value)) !== expected) {
        throw new Error("Missing or unbound test metrics");
      }
      return value;
    },
  });
  if (!closure.ok) throw new Error("Expected successful test closure");
  return { closure, planBytes: Buffer.from(JSON.stringify(input.plan) + "\n") };
}
