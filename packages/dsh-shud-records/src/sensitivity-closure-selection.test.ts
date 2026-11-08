import { expect, test } from "vitest";
import { MAX_COLLECT_ATTEMPTS } from "@shud-harness/dsh-shud-core";
import { deriveSensitivityClosure, serializeRunMetrics } from "./index.ts";
import { digest } from "./run-metrics-test-harness.ts";
import {
  evaluateSensitivity,
  failCell,
  retryCell,
  sensitivityEvidence,
  sensitivityLoaders,
} from "./sensitivity-closure-test-harness.ts";

const successes = [
  "RUN-20261108T093000-0001",
  "RUN-20261108T093000-0002",
  "RUN-20261108T093000-0003",
  "RUN-20261108T093000-0004",
];

test("an admissible failed perturbation needs no stack, data or metrics", () => {
  const input = sensitivityEvidence();
  failCell(input, 2);
  const { loaders, reads } = sensitivityLoaders(input);
  const result = evaluateSensitivity(input, loaders);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected sensitivity success");
  expect(result.selected.map((entry) => entry.run_id)).toEqual(successes);
  expect(result.selected[2]).toMatchObject({
    record: { status: "failed", exit_class: "cvode", stack_id: null, data_id: null },
    metrics: null,
  });
  expect(reads.metrics).toEqual([
    "RUN-20261108T093000-0001",
    "RUN-20261108T093000-0002",
    "RUN-20261108T093000-0004",
  ]);
  expect(result).toEqual(
    deriveSensitivityClosure(input.card, input.runJobs, input.records, input.draft, loaders),
  );
});

test("a failed baseline is rejected with its plan, pset and job identities", () => {
  const input = sensitivityEvidence();
  failCell(input, 0);
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [
      {
        clause: 3,
        analysis_plan_id: input.plan.analysis_plan_id,
        parameter_set_id: "PSET-1",
        job_id: "JOB-20261108T093000-0001",
      },
    ],
  });
});

test("missing cell coverage cannot be supplied by an unlinked record", () => {
  const input = sensitivityEvidence();
  input.card.linked_jobs.pop();
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [{ clause: 2, parameter_set_id: "PSET-4" }],
  });
});

test("two successful records for one pset name both jobs instead of selecting arbitrarily", () => {
  const input = sensitivityEvidence();
  retryCell(input, 1, "JOB-20261108T093000-ff02");
  input.runJobs.reverse();
  input.records.reverse();
  const result = evaluateSensitivity(input);
  expect(result).toMatchObject({
    ok: false,
    failures: [
      {
        clause: 2,
        parameter_set_id: "PSET-2",
        job_ids: ["JOB-20261108T093000-0002", "JOB-20261108T093000-ff02"],
      },
    ],
  });
  expect(result).not.toHaveProperty("selected");
});

test("successful retries win while superseded terminal failures retain card order", () => {
  const input = sensitivityEvidence();
  const success = { ...input.records[1] };
  failCell(input, 1);
  retryCell(input, 1, "JOB-20261108T093000-ff02", success);
  retryCell(input, 1, "JOB-20261108T093000-aa02");
  input.runJobs[5].job.status = "failed";
  input.runJobs[5].collect_error_attempts = MAX_COLLECT_ATTEMPTS;
  input.records.pop();
  input.card.linked_jobs = [
    input.runJobs[5].job.job_id,
    input.runJobs[3].job.job_id,
    input.runJobs[1].job.job_id,
    input.runJobs[4].job.job_id,
    input.runJobs[0].job.job_id,
    input.runJobs[2].job.job_id,
  ];
  input.runJobs.reverse();
  input.records.reverse();
  const { loaders, reads } = sensitivityLoaders(input);
  const result = evaluateSensitivity(input, loaders);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error("Expected retry closure");
  expect(result.selected.map((entry) => entry.run_id)).toEqual([
    "RUN-20261108T093000-0001",
    "RUN-20261108T093000-ff02",
    "RUN-20261108T093000-0003",
    "RUN-20261108T093000-0004",
  ]);
  expect(result.superseded.map((entry) => entry.job_id)).toEqual([
    "JOB-20261108T093000-aa02",
    "JOB-20261108T093000-0002",
  ]);
  expect(reads.metrics).toEqual(result.selected.map((entry) => entry.run_id));
});

test.each([false, true])(
  "absent success selects greatest job id, reversed snapshots %s",
  (reverse) => {
    const input = sensitivityEvidence();
    failCell(input, 2);
    retryCell(input, 2, "JOB-20261108T093000-ff03");
    retryCell(input, 2, "JOB-20261108T093000-aa03");
    if (reverse) {
      input.runJobs.reverse();
      input.records.reverse();
    }
    const result = evaluateSensitivity(input);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("Expected failed perturbation closure");
    expect(result.selected[2]).toMatchObject({
      parameter_set_id: "PSET-3",
      run_id: "RUN-20261108T093000-ff03",
      metrics: null,
    });
    expect(result.superseded.map((entry) => entry.job_id)).toEqual([
      "JOB-20261108T093000-0003",
      "JOB-20261108T093000-aa03",
    ]);
  },
);

test.each([
  "cancelled_job",
  "failed_job",
  "lost",
  "cancelled_record",
  "exhausted",
  "collected_exhausted",
] as const)("effective %s passes terminal classification but fails clause three", (kind) => {
  const input = sensitivityEvidence();
  failCell(input, 2);
  if (kind === "cancelled_job" || kind === "failed_job") {
    input.runJobs[2].job.status = kind === "cancelled_job" ? "cancelled" : "failed";
    input.records.splice(2, 1);
  }
  if (kind === "lost" || kind === "cancelled_record") {
    input.records[2].exit_code = null;
    input.records[2].exit_class = kind === "lost" ? "lost" : "cancelled";
  }
  if (kind === "exhausted" || kind === "collected_exhausted") {
    input.runJobs[2].collect_error_attempts = MAX_COLLECT_ATTEMPTS;
    if (kind === "exhausted") {
      input.runJobs[2].job.status = "succeeded";
      input.records.splice(2, 1);
    }
  }
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [{ clause: 3, parameter_set_id: "PSET-3", job_id: "JOB-20261108T093000-0003" }],
  });
});

test.each([
  ["null stack", "stack_id", null],
  ["different stack", "stack_id", "STACK-20261108T093000-ffff"],
  ["null data", "data_id", null],
] as const)("clause four rejects an effective success with %s", (_name, field, value) => {
  const input = sensitivityEvidence();
  input.records[1][field] = value;
  const { loaders, reads } = sensitivityLoaders(input);
  expect(evaluateSensitivity(input, loaders)).toMatchObject({
    ok: false,
    failures: [{ clause: 4, parameter_set_id: "PSET-2", job_id: "JOB-20261108T093000-0002" }],
  });
  expect(reads.metrics).toEqual([]);
});

test.each(["missing", "unavailable", "exception"] as const)(
  "clause five rejects %s metrics",
  (kind) => {
    const input = sensitivityEvidence();
    const { loaders } = sensitivityLoaders(input);
    if (kind === "missing") input.records[1].artifacts.metrics_summary = null;
    if (kind === "unavailable")
      loaders.readRunMetrics = () => ({ ...input.metrics, status: "unavailable" });
    if (kind === "exception")
      loaders.readRunMetrics = () => {
        throw new Error("private-sensitivity-error");
      };
    const result = evaluateSensitivity(input, loaders);
    expect(result).toMatchObject({ ok: false, failures: [{ clause: 5 }] });
    expect(JSON.stringify(result)).not.toContain("private-sensitivity");
  },
);

test("ok metrics with fail, warn and unavailable individual verdicts still close", () => {
  const input = sensitivityEvidence();
  input.metrics.water_balance.residual = 0.5;
  input.metrics.numerical_health.water_balance_residual = 0.5;
  input.metrics.numerical_health.cvode_failures = null;
  input.metrics.numerical_health.reasons.cvode_failures = "not_observed";
  input.metrics.verdicts = {
    water_balance_residual: "fail",
    cvode_failures: "not_available",
    negative_state_count: "warn",
  };
  const sha256 = digest(serializeRunMetrics(input.metrics));
  for (const record of input.records) record.artifacts.metrics_summary!.sha256 = sha256;
  expect(evaluateSensitivity(input).ok).toBe(true);
});

test("baseline identity follows the plan flag rather than the first array position", () => {
  const input = sensitivityEvidence();
  Object.assign(input.plan.parameter_sets[0], {
    baseline: false,
    changes: { GEOL_KSATH: 0.5 },
  });
  Object.assign(input.plan.parameter_sets[1], { baseline: true, changes: {} });
  failCell(input, 0);
  expect(evaluateSensitivity(input).ok).toBe(true);
});

test("the latest inadmissible failure is not replaced by an earlier admissible failure", () => {
  const input = sensitivityEvidence();
  failCell(input, 2);
  retryCell(input, 2, "JOB-20261108T093000-ff03");
  input.runJobs[4].job.status = "cancelled";
  input.records.pop();
  expect(evaluateSensitivity(input)).toMatchObject({
    ok: false,
    failures: [
      {
        clause: 3,
        parameter_set_id: "PSET-3",
        job_id: "JOB-20261108T093000-ff03",
      },
    ],
  });
});

test.each(["failed", "cancelled", "exhausted"] as const)(
  "a superseded terminal %s job without a record does not veto the successful retry",
  (kind) => {
    const input = sensitivityEvidence();
    retryCell(input, 1, "JOB-20261108T093000-ff02");
    input.runJobs[1].job.status = kind === "exhausted" ? "succeeded" : kind;
    if (kind === "exhausted") {
      input.runJobs[1].collect_error_attempts = MAX_COLLECT_ATTEMPTS;
    }
    input.records.splice(1, 1);
    const result = evaluateSensitivity(input);
    expect(result).toMatchObject({
      ok: true,
      superseded: [{ job_id: "JOB-20261108T093000-0002", parameter_set_id: "PSET-2" }],
    });
  },
);
