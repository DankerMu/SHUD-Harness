import { expect, test } from "vitest";
import { AnalysisPlanSchema, type AnalysisPlanId, type RunId } from "@shud-harness/dsh-shud-core";
import { evaluateClosure, type ClosureDraft, type RunMetrics } from "./index.ts";
import { completeMetrics, digest } from "./run-metrics-test-harness.ts";
import { makeRunJob, makeRunRecord, makeTaskCard } from "./task-lifecycle-test-harness.ts";
import { analysisCase } from "./workspace-files-test-harness.ts";

function freezeEvidence(value: unknown): void {
  if (value === null || typeof value !== "object") return;
  for (const child of Object.values(value)) freezeEvidence(child);
  Object.freeze(value);
}

test("sensitivity closure selects four collected successes in plan order", () => {
  const plan = AnalysisPlanSchema.parse({
    ...analysisCase.value,
    parameter_sets: [
      ...analysisCase.value.parameter_sets,
      { parameter_set_id: "PSET-4", label: null, baseline: false, changes: { GEOL_KSATH: 0.5 } },
    ],
  });
  const metrics: RunMetrics = completeMetrics();
  const metricsSha256 = digest(JSON.stringify(metrics) + "\n");
  const jobs = [
    ["JOB-20261108T093000-0001", "PSET-1"],
    ["JOB-20261108T093000-0002", "PSET-2"],
    ["JOB-20261108T093000-0003", "PSET-3"],
    ["JOB-20261108T093000-0004", "PSET-4"],
  ].map(([jobId, parameter_set_id]) =>
    makeRunJob(jobId, {
      task_id: plan.task_id,
      analysis_plan_id: plan.analysis_plan_id,
      parameter_set_id,
      end_days: plan.end_days,
    }),
  );
  const records = jobs.map((job) =>
    makeRunRecord(job, {
      analysis_plan_id: plan.analysis_plan_id,
      parameter_set_id: job.parameter_set_id,
      artifacts: {
        stdout: "stdout.log",
        stderr: "stderr.log",
        shud_output: "output",
        files: [],
        metrics_summary: { path: "metrics.json", sha256: metricsSha256 },
      },
    }),
  );
  const card = makeTaskCard({
    task_id: plan.task_id,
    type: "sensitivity",
    status: "running",
    source_base_commit: null,
    linked_analyses: [plan.analysis_plan_id],
    linked_jobs: [jobs[2].job_id, jobs[0].job_id, jobs[3].job_id, jobs[1].job_id],
  });
  const runJobs = [jobs[3], jobs[1], jobs[0], jobs[2]].map((job) => ({
    job,
    collect_error_attempts: 0,
  }));
  const draft: ClosureDraft = {
    observations: ["Four parameter sets produced collected runs."],
    limitations: ["One basin and one simulation period were examined."],
    pi_questions: ["Should another basin be compared?"],
  };
  const input = { card, runJobs, records: [...records].reverse(), draft, plan, metrics };
  const before = structuredClone(input);
  freezeEvidence(input);

  const loaders = {
    readAnalysisPlan(id: AnalysisPlanId): unknown {
      expect(id).toBe(plan.analysis_plan_id);
      return plan;
    },
    readRunMetrics(runId: RunId, expectedSha256: string): RunMetrics {
      expect(jobs.some((job) => job.run_id === runId)).toBe(true);
      expect(expectedSha256).toBe(metricsSha256);
      return metrics;
    },
  };
  const result = evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders);

  expect(input).toStrictEqual(before);
  expect(result).not.toBeInstanceOf(Promise);
  expect(result).toMatchObject({ ok: true, failures: [] });
  expect(result).toMatchObject({
    analysis_plan_id: "PLAN-20261108T093000-5c1e",
    selected: [
      { parameter_set_id: "PSET-1", run_id: "RUN-20261108T093000-0001" },
      { parameter_set_id: "PSET-2", run_id: "RUN-20261108T093000-0002" },
      { parameter_set_id: "PSET-3", run_id: "RUN-20261108T093000-0003" },
      { parameter_set_id: "PSET-4", run_id: "RUN-20261108T093000-0004" },
    ],
    superseded: [],
  });
});
