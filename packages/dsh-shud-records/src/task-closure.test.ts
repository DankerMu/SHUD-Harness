import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import {
  MAX_COLLECT_ATTEMPTS,
  RunIdSchema,
  type RunRecord,
  type TaskCard,
} from "@shud-harness/dsh-shud-core";
import {
  evaluateClosure,
  type ClosureDraft,
  type ClosureFailure,
  type ClosureResult,
  type ClosureRunJob,
} from "./index.ts";
import {
  freezeRunJob,
  freezeRunRecord,
  freezeTaskCard,
  makeRunJob,
  makeRunRecord,
  makeTaskCard,
} from "./task-lifecycle-test-harness.ts";

interface ClosureCase {
  card: TaskCard;
  runJobs: ClosureRunJob[];
  records: RunRecord[];
  draft: { observations: string[]; limitations: string[]; pi_questions: string[] };
}

function readyCase(): ClosureCase {
  const job = makeRunJob();
  return {
    card: makeTaskCard({ status: "running", linked_jobs: [job.job_id] }),
    runJobs: [{ job, collect_error_attempts: 0 }],
    records: [makeRunRecord(job)],
    draft: {
      observations: ["private-observation-439"],
      limitations: ["private-limitation-439"],
      pi_questions: ["private-question-439"],
    } satisfies ClosureDraft,
  };
}

function evaluateFrozen(input: ClosureCase): ClosureResult {
  const before = structuredClone(input);
  freezeTaskCard(input.card);
  for (const entry of input.runJobs) {
    freezeRunJob(entry.job);
    Object.freeze(entry);
  }
  Object.freeze(input.runJobs);
  input.records.forEach(freezeRunRecord);
  Object.freeze(input.records);
  Object.freeze(input.draft.observations);
  Object.freeze(input.draft.limitations);
  Object.freeze(input.draft.pi_questions);
  Object.freeze(input.draft);

  const result = evaluateClosure(input.card, input.runJobs, input.records, input.draft);

  expect(input).toStrictEqual(before);
  expect(result).not.toBeInstanceOf(Promise);
  expect(result.metric_fact).toBe(true);
  expect(result.automatic_limitation).toContain("无指标 artifact");
  for (const sentinel of [
    "private-task-text-439",
    "private-observation-439",
    "private-limitation-439",
    "private-question-439",
    "private-reference-439",
    "private-attempt-count-439",
  ]) {
    expect(inspect(result, { depth: null })).not.toContain(sentinel);
  }
  return result;
}

function expectPass(input: ClosureCase): void {
  expect(evaluateFrozen(input)).toMatchObject({ ok: true, failures: [] });
}

function expectDenied(input: ClosureCase, failures: ClosureFailure[]): void {
  const result = evaluateFrozen(input);
  expect(result.ok).toBe(false);
  expect(result.failures).toHaveLength(failures.length);
  expect(result.failures).toEqual(expect.arrayContaining(failures));
}

describe("evaluateClosure successful evidence", () => {
  test("accepts collected task-owned evidence and leaves authored limitations untouched", () => {
    const input = readyCase();
    expectPass(input);
    expect(input.draft.limitations).toStrictEqual(["private-limitation-439"]);
  });

  test("requires every linked job but accepts multiple successful runs in any input order", () => {
    const input = readyCase();
    const second = makeRunJob("JOB-20261027T080005-0002", {
      stack_id: "STACK-20261027T080005-0002",
      data_id: "DATA-20261027T080005-0002",
    });
    input.card.linked_jobs.push(second.job_id);
    input.card.stack_id = null;
    input.card.data_id = null;
    input.runJobs.unshift({ job: second, collect_error_attempts: MAX_COLLECT_ATTEMPTS - 1 });
    input.records.push(makeRunRecord(second));
    expectPass(input);
  });

  test("unlinked failed jobs, invalid counts and failed records neither satisfy nor veto closure", () => {
    const input = readyCase();
    const other = makeRunJob("JOB-20261027T080005-0002", {
      task_id: "TASK-20261027T080005-eeee",
      status: "failed",
    });
    input.runJobs.unshift({ job: other, collect_error_attempts: NaN });
    input.records.unshift(
      makeRunRecord(other, { status: "failed", exit_code: null, exit_class: "lost" }),
    );
    expectPass(input);
  });

  test("counts model text without classifying its meaning or consuming raw references", () => {
    const input = readyCase();
    input.draft.observations = ["The model declares this finished."];
    input.draft.limitations = ["无指标 artifact"];
    input.records[0] = makeRunRecord(input.runJobs[0].job, {
      stack_id: "private-reference-439",
      data_id: "private-reference-439",
    });
    expectPass(input);
  });
});

describe("card and model-authored closure clauses", () => {
  test.each(["engineering", "ops"] as const)("rejects unsupported task type %s", (type) => {
    const input = readyCase();
    input.card.type = type;
    expectDenied(input, [{ reason: "unsupported_task_type" }]);
  });

  test("unlinked evidence cannot satisfy the nonempty linked_jobs clause", () => {
    const input = readyCase();
    input.card.linked_jobs = [];
    expectDenied(input, [{ reason: "no_linked_jobs" }]);
  });

  test.each([
    { field: "observations", reason: "missing_observations" },
    { field: "limitations", reason: "missing_limitations" },
    { field: "pi_questions", reason: "missing_pi_questions" },
  ] as const)("rejects empty model-supplied $field", ({ field, reason }) => {
    const input = readyCase();
    input.draft[field] = [];
    expectDenied(input, [{ reason }]);
    expect(input.draft[field]).toStrictEqual([]);
  });

  test("reports all missing authored clauses without adding the automatic limitation first", () => {
    const input = readyCase();
    input.draft = { observations: [], limitations: [], pi_questions: [] };
    expectDenied(input, [
      { reason: "missing_observations" },
      { reason: "missing_limitations" },
      { reason: "missing_pi_questions" },
    ]);
    expect(input.draft.limitations).toStrictEqual([]);
  });
});

describe("referenced job identity and state", () => {
  test("a missing linked job is not replaced by an unrelated successful job", () => {
    const input = readyCase();
    const jobId = input.card.linked_jobs[0];
    const unrelated = makeRunJob("JOB-20261027T080005-0002");
    input.runJobs = [{ job: unrelated, collect_error_attempts: 0 }];
    input.records.push(makeRunRecord(unrelated));
    expectDenied(input, [{ reason: "missing_job", job_id: jobId }]);
  });

  test.each([null, "TASK-20261027T080005-eeee"])(
    "rejects a referenced job owned by task %s",
    (task_id) => {
      const input = readyCase();
      const job = makeRunJob(undefined, { task_id });
      input.runJobs = [{ job, collect_error_attempts: 0 }];
      input.records = [makeRunRecord(job)];
      expectDenied(input, [{ reason: "foreign_job", job_id: job.job_id }]);
    },
  );

  test.each([false, true])(
    "ambiguous job evidence fails closed with reversed order %s",
    (reverse) => {
      const input = readyCase();
      const job = input.runJobs[0].job;
      input.runJobs.push({
        job: makeRunJob(job.job_id, { status: "failed" }),
        collect_error_attempts: MAX_COLLECT_ATTEMPTS,
      });
      if (reverse) input.runJobs.reverse();
      expectDenied(input, [{ reason: "ambiguous_job", job_id: job.job_id }]);
    },
  );

  test("duplicate matching job entries remain ambiguous even when both look successful", () => {
    const input = readyCase();
    const entry = input.runJobs[0];
    input.runJobs.push({ ...entry });
    expectDenied(input, [{ reason: "ambiguous_job", job_id: entry.job.job_id }]);
  });

  test.each([
    { status: "created", reason: "job_not_collected" },
    { status: "submitted", reason: "job_not_collected" },
    { status: "running", reason: "job_not_collected" },
    { status: "succeeded", reason: "job_not_collected" },
    { status: "failed", reason: "job_failed" },
    { status: "cancelled", reason: "job_cancelled" },
  ] as const)("$status job blocks closure despite an otherwise successful record", (row) => {
    const input = readyCase();
    const job = makeRunJob(undefined, { status: row.status });
    input.runJobs = [{ job, collect_error_attempts: 0 }];
    expectDenied(input, [{ reason: row.reason, job_id: job.job_id }]);
  });
});

describe("corresponding RunRecord identity and references", () => {
  test("missing record blocks an otherwise collected job", () => {
    const input = readyCase();
    input.records = [];
    expectDenied(input, [{ reason: "missing_record", job_id: input.card.linked_jobs[0] }]);
  });

  test("matching job_id with a different run_id cannot satisfy the record clause", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.records = [makeRunRecord(job, { run_id: RunIdSchema.parse("RUN-20261027T080005-ffff") })];
    expectDenied(input, [{ reason: "missing_record", job_id: job.job_id }]);
  });

  test("matching run_id with a different job_id cannot satisfy the record clause", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    const other = makeRunJob("JOB-20261027T080005-0002", { run_id: job.run_id });
    input.records = [makeRunRecord(other)];
    expectDenied(input, [{ reason: "missing_record", job_id: job.job_id }]);
  });

  test.each([null, "TASK-20261027T080005-eeee"])(
    "a matching record with foreign task_id %s fails closed",
    (task_id) => {
      const input = readyCase();
      const job = input.runJobs[0].job;
      input.records = [makeRunRecord(job, { task_id })];
      expectDenied(input, [{ reason: "foreign_record", job_id: job.job_id }]);
    },
  );

  test.each([false, true])(
    "ambiguous matching records fail closed with reversed order %s",
    (reverse) => {
      const input = readyCase();
      const job = input.runJobs[0].job;
      input.records.push(
        makeRunRecord(job, { status: "failed", exit_code: 19, exit_class: "cvode" }),
      );
      if (reverse) input.records.reverse();
      expectDenied(input, [{ reason: "ambiguous_record", job_id: job.job_id }]);
    },
  );

  test("duplicate successful records do not mask ambiguous execution evidence", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.records.push(makeRunRecord(job));
    expectDenied(input, [{ reason: "ambiguous_record", job_id: job.job_id }]);
  });

  test("failed records for a different execution of the same job are unrelated", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.records.unshift(
      makeRunRecord(job, {
        run_id: RunIdSchema.parse("RUN-20261027T080005-ffff"),
        status: "failed",
        exit_code: null,
        exit_class: "lost",
      }),
    );
    expectPass(input);
  });

  test.each([
    { field: "stack_id", reason: "missing_stack_reference" },
    { field: "data_id", reason: "missing_data_reference" },
  ] as const)(
    "null record $field blocks despite the card's non-null reference",
    ({ field, reason }) => {
      const input = readyCase();
      const job = input.runJobs[0].job;
      input.records = [makeRunRecord(job, { [field]: null })];
      expectDenied(input, [{ reason, job_id: job.job_id }]);
    },
  );

  test("reports both missing record references", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.records = [makeRunRecord(job, { stack_id: null, data_id: null })];
    expectDenied(input, [
      { reason: "missing_stack_reference", job_id: job.job_id },
      { reason: "missing_data_reference", job_id: job.job_id },
    ]);
  });

  test.each([
    { exit_code: 10, exit_class: "nan" },
    { exit_code: 12, exit_class: "file_io" },
    { exit_code: 13, exit_class: "input" },
    { exit_code: 19, exit_class: "cvode" },
    { exit_code: 20, exit_class: "consistency" },
    { exit_code: 3, exit_class: "other" },
    { exit_code: null, exit_class: "cancelled" },
    { exit_code: null, exit_class: "lost" },
  ] as const)("failed record with $exit_class exit blocks closure", (outcome) => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.records = [makeRunRecord(job, { status: "failed", ...outcome })];
    expectDenied(input, [{ reason: "record_failed", job_id: job.job_id }]);
  });
});

describe("collect-error attempt policy", () => {
  test.each([0, MAX_COLLECT_ATTEMPTS - 1])(
    "allows explicit attempts %s below the limit",
    (attempts) => {
      const input = readyCase();
      input.runJobs[0].collect_error_attempts = attempts;
      expectPass(input);
    },
  );

  test("retained exhausted ledger blocks a collected job with a successful matching record", () => {
    const input = readyCase();
    const entry = input.runJobs[0];
    entry.collect_error_attempts = MAX_COLLECT_ATTEMPTS;
    expect(entry.job.status).toBe("collected");
    expect(input.records[0]).toMatchObject({
      job_id: entry.job.job_id,
      run_id: entry.job.run_id,
      status: "succeeded",
      stack_id: "STACK-20261027T080005-0001",
      data_id: "DATA-20261027T080005-0001",
    });
    expectDenied(input, [{ reason: "collect_exhausted", job_id: entry.job.job_id }]);
  });

  test("attempts above the limit also block otherwise successful evidence", () => {
    const input = readyCase();
    input.runJobs[0].collect_error_attempts = MAX_COLLECT_ATTEMPTS + 1;
    expectDenied(input, [{ reason: "collect_exhausted", job_id: input.card.linked_jobs[0] }]);
  });

  test.each([
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    "private-attempt-count-439",
    false,
    {},
  ])("invalid attempt count %j fails closed instead of becoming zero", (attempts) => {
    const input = readyCase();
    input.runJobs[0].collect_error_attempts = attempts as number;
    expectDenied(input, [
      { reason: "invalid_collect_attempts", job_id: input.card.linked_jobs[0] },
    ]);
  });

  test("an absent attempts field is invalid; only the caller can map a missing ledger to zero", () => {
    const input = readyCase();
    const job = input.runJobs[0].job;
    input.runJobs = [{ job } as ClosureRunJob];
    expectDenied(input, [{ reason: "invalid_collect_attempts", job_id: job.job_id }]);
  });

  test("multiple jobs each contribute their own blocking evidence", () => {
    const input = readyCase();
    const first = input.runJobs[0].job;
    const second = makeRunJob("JOB-20261027T080005-0002");
    input.card.linked_jobs.push(second.job_id);
    input.runJobs.push({ job: second, collect_error_attempts: MAX_COLLECT_ATTEMPTS });
    input.records = [
      makeRunRecord(first, { status: "failed", exit_code: 19, exit_class: "cvode" }),
      makeRunRecord(second),
    ];
    expectDenied(input, [
      { reason: "record_failed", job_id: first.job_id },
      { reason: "collect_exhausted", job_id: second.job_id },
    ]);
  });
});
