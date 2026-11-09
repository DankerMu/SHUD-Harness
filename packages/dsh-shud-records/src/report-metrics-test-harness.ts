import { join } from "node:path";
import { serializeRunMetrics, type RunMetrics } from "./index.ts";
import { completeMetrics, digest } from "./run-metrics-test-harness.ts";
import {
  makeValidationWorkspace,
  realFs,
  type ValidationWorkspace,
} from "./report-validation-test-harness.ts";

export interface MetricReportWorkspace extends ValidationWorkspace {
  publishMetrics(
    index: number,
    metrics?: RunMetrics,
  ): { path: string; relativePath: string; bytes: string; sha256: string };
}

export function makeMetricReportWorkspace(): MetricReportWorkspace {
  const workspace = makeValidationWorkspace();
  const publishMetrics = (index: number, metrics: RunMetrics = completeMetrics()) => {
    const run = workspace.fixture.runs[index];
    const relativePath = `runs/${run.run_id}/metrics.json`;
    const bytes = serializeRunMetrics(metrics);
    const sha256 = digest(bytes);
    realFs.writeFileSync(join(workspace.cwd, relativePath), bytes);
    run.artifacts.metrics_summary = { path: "metrics.json", sha256 };
    workspace.publishFixture();
    return { path: join(workspace.cwd, relativePath), relativePath, bytes, sha256 };
  };
  return { ...workspace, publishMetrics };
}
