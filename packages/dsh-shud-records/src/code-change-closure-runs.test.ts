import { inspect } from "node:util";
import { describe, expect, test } from "vitest";
import {
  MAX_COLLECT_ATTEMPTS,
  RunIdSchema,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import { codeChangeClosure, type ClosureResult, type ClosureRunJob } from "./index.ts";
import {
  closureEvidence,
  evidenceLoaders,
  freezeEvidence,
  OTHER_TASK,
  OTHER_VERIFICATION,
  PRIVATE_PAYLOAD,
  terminalVerification,
} from "./code-change-closure-test-harness.ts";
import { makeRunJob, makeRunRecord } from "./task-lifecycle-test-harness.ts";

function denied(result: ClosureResult, facts: Record<string, unknown>): void {
  expect(result.ok).toBe(false);
  expect(result.failures).toEqual(expect.arrayContaining([expect.objectContaining(facts)]));
  expect(inspect(result, { depth: null })).not.toContain(PRIVATE_PAYLOAD);
}

describe.each(["base_run_id", "candidate_run_id"] as const)("verification %s binding", (field) => {
  test.each(["missing", "unlinked", "foreign", "null_task", "ambiguous", "duplicate"] as const)(
    "rejects %s run evidence with candidate and run identity",
    (kind) => {
      const input = closureEvidence();
      const index = field === "base_run_id" ? 0 : 1;
      const job = input.runJobs[index].job;
      if (kind === "missing") input.runJobs.splice(index, 1);
      if (kind === "unlinked") input.card.linked_jobs.splice(index, 1);
      if (kind === "foreign" || kind === "null_task")
        input.runJobs[index].job = makeRunJob(job.job_id, {
          ...job,
          task_id: kind === "foreign" ? OTHER_TASK : null,
        });
      if (kind === "ambiguous")
        input.runJobs.push({
          job: makeRunJob("JOB-20261102T090000-ffff", {
            task_id: input.card.task_id,
            run_id: job.run_id,
          }),
          collect_error_attempts: 0,
        });
      if (kind === "duplicate") input.runJobs.push({ ...input.runJobs[index] });
      const before = structuredClone(input);
      freezeEvidence(input);
      const result = codeChangeClosure(input.card, evidenceLoaders(input).loaders);
      denied(result, {
        clause: 2,
        vc_id: input.verification.vc_id,
        run_id: job.run_id,
        ...(kind === "missing" ? {} : { job_id: job.job_id }),
      });
      expect(input).toStrictEqual(before);
    },
  );

  test.each(["missing", "unlinked", "foreign", "ambiguous"] as const)(
    "a %s alternative binding does not veto another valid witness",
    (kind) => {
      const input = closureEvidence();
      const { loaders, verifications } = evidenceLoaders(input);
      const other = makeRunJob("JOB-20261102T090000-ffff", {
        task_id: kind === "foreign" ? OTHER_TASK : input.card.task_id,
      });
      const alternative = terminalVerification({
        vc_id: OTHER_VERIFICATION,
        [field]: other.run_id,
      });
      input.card.linked_verifications.unshift(OTHER_VERIFICATION);
      verifications.set(OTHER_VERIFICATION, alternative);
      if (kind !== "missing") input.runJobs.push({ job: other, collect_error_attempts: 0 });
      if (kind === "ambiguous")
        input.runJobs.push({
          job: makeRunJob("JOB-20261102T090000-eeee", {
            task_id: input.card.task_id,
            run_id: other.run_id,
          }),
          collect_error_attempts: 0,
        });
      expect(codeChangeClosure(input.card, loaders)).toMatchObject({ ok: true, failures: [] });
    },
  );
});

describe("clause five applies to every linked job, not only the verification pair", () => {
  function withExtraJob() {
    const input = closureEvidence();
    const job = makeRunJob("JOB-20261102T090000-ffff", { task_id: input.card.task_id });
    input.card.linked_jobs.push(job.job_id);
    input.runJobs.push({ job, collect_error_attempts: 0 });
    input.records.push(makeRunRecord(job));
    return { input, job };
  }

  test.each([
    ["created", "job_not_collected"],
    ["submitted", "job_not_collected"],
    ["running", "job_not_collected"],
    ["succeeded", "job_not_collected"],
    ["failed", "job_failed"],
    ["cancelled", "job_cancelled"],
  ] as const)("%s additional job blocks with %s", (status, reason) => {
    const { input, job } = withExtraJob();
    input.runJobs[2].job = makeRunJob(job.job_id, { ...job, status });
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason,
      job_id: job.job_id,
    });
  });

  test.each([
    { exit_code: 19, exit_class: "cvode" },
    { exit_code: null, exit_class: "cancelled" },
    { exit_code: null, exit_class: "lost" },
  ] as const)("failed $exit_class additional record blocks", (outcome) => {
    const { input, job } = withExtraJob();
    input.records[2] = makeRunRecord(job, { status: "failed", ...outcome });
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason: "record_failed",
      job_id: job.job_id,
    });
  });

  test.each([
    ["stack_id", "missing_stack_reference"],
    ["data_id", "missing_data_reference"],
  ] as const)("null %s in an additional record blocks", (field, reason) => {
    const { input, job } = withExtraJob();
    input.records[2] = makeRunRecord(job, { [field]: null });
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason,
      job_id: job.job_id,
    });
  });

  test.each([
    "missing_job",
    "ambiguous_job",
    "foreign_job",
    "missing_record",
    "ambiguous_record",
    "foreign_record",
  ] as const)("%s remains a blocker outside the witness pair", (reason) => {
    const { input, job } = withExtraJob();
    if (reason === "missing_job") input.runJobs.pop();
    if (reason === "ambiguous_job") input.runJobs.push({ ...input.runJobs[2] });
    if (reason === "foreign_job")
      input.runJobs[2].job = makeRunJob(job.job_id, { ...job, task_id: OTHER_TASK });
    if (reason === "missing_record") input.records.pop();
    if (reason === "ambiguous_record") input.records.push(makeRunRecord(job));
    if (reason === "foreign_record") input.records[2] = makeRunRecord(job, { task_id: OTHER_TASK });
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason,
      job_id: job.job_id,
    });
  });

  test.each(["run_id", "job_id"] as const)(
    "a record with another %s cannot substitute for the additional execution",
    (field) => {
      const { input, job } = withExtraJob();
      input.records[2] =
        field === "run_id"
          ? makeRunRecord(job, { run_id: RunIdSchema.parse("RUN-20261102T090000-eeee") })
          : makeRunRecord(
              makeRunJob("JOB-20261102T090000-eeee", {
                task_id: input.card.task_id,
                run_id: job.run_id,
              }),
            );
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        clause: 5,
        reason: "missing_record",
        job_id: job.job_id,
      });
    },
  );

  test.each([0, MAX_COLLECT_ATTEMPTS - 1])(
    "explicit attempts %s below exhaustion allow closure",
    (attempts) => {
      const { input } = withExtraJob();
      input.runJobs[2].collect_error_attempts = attempts;
      expect(codeChangeClosure(input.card, evidenceLoaders(input).loaders)).toMatchObject({
        ok: true,
        failures: [],
      });
    },
  );

  test.each([MAX_COLLECT_ATTEMPTS, MAX_COLLECT_ATTEMPTS + 1])(
    "retained attempts %s block even after successful direct collection",
    (attempts) => {
      const { input, job } = withExtraJob();
      input.runJobs[2].collect_error_attempts = attempts;
      expect(input.records[2].status).toBe("succeeded");
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        clause: 5,
        reason: "collect_exhausted",
        job_id: job.job_id,
      });
    },
  );

  test.each([
    -1,
    0.5,
    NaN,
    Infinity,
    -Infinity,
    Number.MAX_SAFE_INTEGER + 1,
    null,
    undefined,
    false,
    {},
    PRIVATE_PAYLOAD,
  ])("invalid ledger count %j fails closed without exposing its payload", (attempts) => {
    const { input, job } = withExtraJob();
    input.runJobs[2].collect_error_attempts = attempts as number;
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason: "invalid_collect_attempts",
      job_id: job.job_id,
    });
  });

  test("an absent ledger count is not silently replaced with zero", () => {
    const { input, job } = withExtraJob();
    input.runJobs[2] = { job } as ClosureRunJob;
    denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
      clause: 5,
      reason: "invalid_collect_attempts",
      job_id: job.job_id,
    });
  });

  test("unlinked failed evidence and failed records for another execution are ignored", () => {
    const input = closureEvidence();
    const unrelated = makeRunJob("JOB-20261102T090000-ffff", {
      task_id: OTHER_TASK,
      status: "failed",
    });
    input.runJobs.unshift({ job: unrelated, collect_error_attempts: NaN });
    input.records.push(
      makeRunRecord(unrelated, { status: "failed", exit_code: null, exit_class: "lost" }),
    );
    input.records.unshift(
      makeRunRecord(input.runJobs[1].job, {
        run_id: RunIdSchema.parse("RUN-20261102T090000-eeee"),
        status: "failed",
        exit_code: null,
        exit_class: "lost",
      }),
    );
    expect(codeChangeClosure(input.card, evidenceLoaders(input).loaders)).toMatchObject({
      ok: true,
      failures: [],
    });
  });

  test.each(["job", "record"] as const)(
    "null task ownership on additional %s fails closed",
    (kind) => {
      const { input, job } = withExtraJob();
      if (kind === "job") input.runJobs[2].job = { ...job, task_id: null } satisfies RunJob;
      else input.records[2] = { ...input.records[2], task_id: null } satisfies RunRecord;
      denied(codeChangeClosure(input.card, evidenceLoaders(input).loaders), {
        clause: 5,
        reason: kind === "job" ? "foreign_job" : "foreign_record",
        job_id: job.job_id,
      });
    },
  );
});
