import { expect } from "vitest";
import {
  AnalysisPlanSchema,
  type AnalysisPlan,
  type RunRecord,
  type RunRecordInput,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import {
  evaluateClosure,
  serializeRunMetrics,
  type ClosureRunJob,
  type RunMetrics,
  type SensitivityObjectLoaders,
} from "./index.ts";
import { freezeEvidence } from "./code-change-closure-test-harness.ts";
import { completeMetrics, digest } from "./run-metrics-test-harness.ts";
import { makeRunJob, makeRunRecord, makeTaskCard } from "./task-lifecycle-test-harness.ts";
import { analysisCase } from "./workspace-files-test-harness.ts";

export interface SensitivityEvidence {
  plan: AnalysisPlan;
  card: TaskCard & { type: "sensitivity" };
  runJobs: ClosureRunJob[];
  records: RunRecord[];
  metrics: RunMetrics;
  draft: { observations: string[]; limitations: string[]; pi_questions: string[] };
}

export function sensitivityEvidence(): SensitivityEvidence {
  const plan = AnalysisPlanSchema.parse({
    ...analysisCase.value,
    parameter_sets: [
      ...analysisCase.value.parameter_sets,
      { parameter_set_id: "PSET-4", label: null, baseline: false, changes: { LC_ROUGH: 0.5 } },
    ],
  });
  const metrics = completeMetrics();
  const sha256 = digest(serializeRunMetrics(metrics));
  const runJobs = plan.parameter_sets.map((set, index) => ({
    job: makeRunJob(`JOB-20261108T093000-000${index + 1}`, {
      task_id: plan.task_id,
      analysis_plan_id: plan.analysis_plan_id,
      parameter_set_id: set.parameter_set_id,
    }),
    collect_error_attempts: 0,
  }));
  const records = runJobs.map(({ job }) => {
    const record = makeRunRecord(job);
    return makeRunRecord(job, {
      analysis_plan_id: job.analysis_plan_id,
      parameter_set_id: job.parameter_set_id,
      artifacts: { ...record.artifacts, metrics_summary: { path: "metrics.json", sha256 } },
    });
  });
  return {
    plan,
    card: {
      ...makeTaskCard({
        task_id: plan.task_id,
        type: "sensitivity",
        status: "running",
        source_base_commit: null,
        linked_analyses: [plan.analysis_plan_id],
        linked_jobs: runJobs.map(({ job }) => job.job_id),
      }),
      type: "sensitivity",
    },
    runJobs,
    records,
    metrics,
    draft: {
      observations: ["private-sensitivity-observation"],
      limitations: ["private-sensitivity-limitation"],
      pi_questions: ["private-sensitivity-question"],
    },
  };
}

export function sensitivityLoaders(input: SensitivityEvidence) {
  const reads = { plans: [] as string[], metrics: [] as string[] };
  const loaders: SensitivityObjectLoaders = {
    readAnalysisPlan(id) {
      reads.plans.push(id);
      return input.plan;
    },
    readRunMetrics(id, sha256) {
      reads.metrics.push(id);
      if (sha256 !== digest(serializeRunMetrics(input.metrics))) {
        throw new Error("private-sensitivity-digest-error");
      }
      return input.metrics;
    },
  };
  return { loaders, reads };
}

export function failCell(input: SensitivityEvidence, index: number): void {
  input.records[index] = makeRunRecord(input.runJobs[index].job, {
    analysis_plan_id: input.plan.analysis_plan_id,
    parameter_set_id: input.runJobs[index].job.parameter_set_id,
    status: "failed",
    exit_class: "cvode",
    exit_code: 19,
    stack_id: null,
    data_id: null,
  });
}

export function retryCell(
  input: SensitivityEvidence,
  index: number,
  jobId: string,
  recordOverrides: Partial<RunRecordInput> = {},
): void {
  const job = input.runJobs[index].job;
  const retry = makeRunJob(jobId, {
    task_id: job.task_id,
    analysis_plan_id: job.analysis_plan_id,
    parameter_set_id: job.parameter_set_id,
  });
  input.card.linked_jobs.push(retry.job_id);
  input.runJobs.push({ job: retry, collect_error_attempts: 0 });
  input.records.push(
    makeRunRecord(retry, {
      ...input.records[index],
      ...recordOverrides,
      job_id: retry.job_id,
      run_id: retry.run_id,
    }),
  );
}

export function evaluateSensitivity(
  input: SensitivityEvidence,
  loaders = sensitivityLoaders(input).loaders,
) {
  const before = structuredClone(input);
  freezeEvidence(input);
  const result = evaluateClosure(input.card, input.runJobs, input.records, input.draft, loaders);
  expect(input).toStrictEqual(before);
  expect(result).not.toBeInstanceOf(Promise);
  return result;
}
