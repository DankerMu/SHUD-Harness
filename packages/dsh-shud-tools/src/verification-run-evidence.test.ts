import * as fs from "node:fs";
import { join } from "node:path";
import { expect, test } from "vitest";
import {
  BuildRecordSchema,
  ChangeRequestSchema,
  DataProvenanceSchema,
  JobRecordIdSchema,
  RunIdSchema,
  RunJobSchema,
  RunRecordSchema,
  TaskCardSchema,
} from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { seedQueryRun } from "../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { makeRunRecord } from "../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import {
  fixturePaths,
  OTHER_COMMIT,
  OTHER_SHA256,
  OTHER_TASK,
  putFixture,
  rejectedUnchanged,
  SIDES,
  THIRD_COMMIT,
  verificationArgs,
} from "./verification-run/matrix/test-harness.ts";
import {
  COMPARED_PATH,
  OUTPUT_BYTES,
  OUTPUT_SHA256,
  verificationHarness,
} from "./verification-run/test-harness.ts";

for (const side of SIDES) {
  test.each([
    "unindexed",
    "job-task",
    "job-null-task",
    "job-id",
    "job-run",
    "record-run",
    "record-job",
    "record-task",
    "record-null-task",
    "failed",
    "unlinked",
    "project",
    "unsafe-project",
    "null-build",
    "build-task",
    "pin",
    "threads-two",
    "threads-null",
    "invalid-data",
    "internal-input",
    "external-input",
  ] as const)(`${side} %s evidence is rejected without mutation`, async (fault) => {
    const h = await verificationHarness();
    try {
      const source = h[side];
      const paths = fixturePaths(h, side);
      const args = verificationArgs(h);
      switch (fault) {
        case "unindexed": {
          const runId = RunIdSchema.parse("RUN-20261022T031500-ffff");
          const job = await seedQueryRun(
            h,
            "ffff",
            {
              ...source.job,
              run_id: runId,
              job_id: JobRecordIdSchema.parse("JOB-20261022T031500-ffff"),
              run_dir: join(h.cwd, "runs", runId),
            },
            "unindexed",
          );
          putFixture(
            join(job.run_dir, "run-record.json"),
            makeRunRecord(job, {
              ...source.run,
              run_id: job.run_id,
              job_id: job.job_id,
            }),
          );
          fs.mkdirSync(join(job.run_dir, "output", "tiny.out"), { recursive: true });
          fs.writeFileSync(join(job.run_dir, COMPARED_PATH), OUTPUT_BYTES);
          writeWorkspaceRecord(h.cwd, "task", {
            ...h.card,
            linked_jobs: [...h.card.linked_jobs, job.job_id],
          });
          args[side === "base" ? "base_run_id" : "candidate_run_id"] = runId;
          break;
        }
        case "job-task":
        case "job-null-task":
          putFixture(
            paths.job,
            RunJobSchema.parse({
              ...source.job,
              task_id: fault === "job-task" ? OTHER_TASK : null,
            }),
          );
          break;
        case "job-id":
          putFixture(
            paths.job,
            RunJobSchema.parse({ ...source.job, job_id: "JOB-20261022T031500-ffff" }),
          );
          break;
        case "job-run":
          putFixture(
            paths.job,
            RunJobSchema.parse({ ...source.job, run_id: "RUN-20261022T031500-ffff" }),
          );
          break;
        case "record-run":
          putFixture(
            paths.run,
            RunRecordSchema.parse({ ...source.run, run_id: "RUN-20261022T031500-ffff" }),
          );
          break;
        case "record-job":
          putFixture(
            paths.run,
            RunRecordSchema.parse({ ...source.run, job_id: "JOB-20261022T031500-ffff" }),
          );
          break;
        case "record-task":
        case "record-null-task":
          putFixture(
            paths.run,
            RunRecordSchema.parse({
              ...source.run,
              task_id: fault === "record-task" ? OTHER_TASK : null,
            }),
          );
          break;
        case "failed":
          putFixture(
            paths.run,
            RunRecordSchema.parse({
              ...source.run,
              status: "failed",
              exit_code: 19,
              exit_class: "cvode",
            }),
          );
          break;
        case "unlinked":
          writeWorkspaceRecord(h.cwd, "task", {
            ...h.card,
            linked_jobs: h.card.linked_jobs.filter((id) => id !== source.job.job_id),
          });
          break;
        case "project":
        case "unsafe-project":
          putFixture(
            paths.job,
            RunJobSchema.parse({
              ...source.job,
              project: fault === "project" ? "other" : "../tiny",
            }),
          );
          break;
        case "null-build":
          putFixture(
            paths.job,
            RunJobSchema.parse({ ...source.job, build_id: null, binary_sha256: null }),
          );
          break;
        case "build-task":
          putFixture(
            paths.build,
            BuildRecordSchema.parse({ ...source.build, task_id: OTHER_TASK }),
          );
          break;
        case "pin":
          putFixture(
            paths.build,
            BuildRecordSchema.parse({ ...source.build, source_commit: OTHER_COMMIT }),
          );
          break;
        case "threads-two":
        case "threads-null":
          putFixture(
            paths.job,
            RunJobSchema.parse({ ...source.job, threads: fault === "threads-two" ? 2 : null }),
          );
          break;
        case "invalid-data":
          putFixture(
            paths.run,
            RunRecordSchema.parse({
              ...source.run,
              data_id: "DATA-invalid",
            }),
          );
          break;
        case "internal-input":
        case "external-input": {
          const key = fault === "internal-input" ? "files" : "external_files";
          const data = DataProvenanceSchema.parse({
            ...source.data,
            sources: {
              ...source.data.sources,
              [key]: source.data.sources[key].map((file) => ({ ...file, sha256: OTHER_SHA256 })),
            },
          });
          writeWorkspaceRecord(h.cwd, "data", data);
          break;
        }
      }
      await rejectedUnchanged(h, args);
    } finally {
      await h.dispose();
    }
  });

  test(`${side} mirrored binary digest mismatch reaches BuildRecord validation`, async () => {
    const h = await verificationHarness();
    try {
      const source = h[side];
      const paths = fixturePaths(h, side);
      const job = RunJobSchema.parse({ ...source.job, binary_sha256: OTHER_SHA256 });
      const record = RunRecordSchema.parse({ ...source.run, binary_sha256: OTHER_SHA256 });
      putFixture(paths.job, job);
      putFixture(paths.run, record);
      const build = readWorkspaceRecord(h.cwd, "build", source.build.build_id, { readonly: true });
      expect(build.binary_sha256).toBe(OUTPUT_SHA256);
      expect(build.binary_sha256).not.toBe(OTHER_SHA256);
      expect(await h.registry.listRunJobsByTask(h.card.task_id)).toContainEqual(job);
      expect(await h.registry.collectShud(job.job_id, { readonly: true })).toEqual(record);

      const message = await rejectedUnchanged(h, verificationArgs(h), /binary_sha256/u);
      expect(message).toContain(job.run_id);
      expect(message).toContain(build.build_id);
    } finally {
      await h.dispose();
    }
  });

  test(`${side} mirrored null data_id reaches provenance validation`, async () => {
    const h = await verificationHarness();
    try {
      const source = h[side];
      const paths = fixturePaths(h, side);
      const job = RunJobSchema.parse({ ...source.job, data_id: null });
      const record = RunRecordSchema.parse({ ...source.run, data_id: null });
      putFixture(paths.job, job);
      putFixture(paths.run, record);
      expect(await h.registry.listRunJobsByTask(h.card.task_id)).toContainEqual(job);
      expect(await h.registry.collectShud(job.job_id, { readonly: true })).toEqual(record);

      const message = await rejectedUnchanged(h, verificationArgs(h), /data_id.*required/u);
      expect(message).toContain(job.run_id);
    } finally {
      await h.dispose();
    }
  });

  test.each(["created", "submitted", "running", "succeeded", "failed", "cancelled"] as const)(
    `${side} uncollected %s is rejected without generating records or retry ledgers`,
    async (status) => {
      const h = await verificationHarness();
      try {
        const paths = fixturePaths(h, side);
        putFixture(
          paths.job,
          RunJobSchema.parse({
            ...h[side].job,
            status,
            ...(status === "running"
              ? { pid: process.pid, pid_started_at: "2026-10-22T03:15:00Z" }
              : {}),
          }),
        );
        fs.unlinkSync(paths.run);
        await rejectedUnchanged(h, verificationArgs(h), /collect|status/iu);
        expect(fs.existsSync(paths.run)).toBe(false);
        expect(fs.existsSync(join(h[side].job.run_dir, "collect-error.json"))).toBe(false);
        expect(h.followups).toEqual([]);
      } finally {
        await h.dispose();
      }
    },
  );

  test(`${side} indexed run from another workspace cannot supply artifacts`, async () => {
    const h = await verificationHarness();
    try {
      const source = h[side];
      const id = RunIdSchema.parse("RUN-20261022T031500-f003");
      const runDir = join(h.root, "other-workspace", "runs", id);
      const job = await seedQueryRun(
        h,
        "f003",
        {
          ...source.job,
          run_id: id,
          job_id: JobRecordIdSchema.parse("JOB-20261022T031500-f003"),
          run_dir: runDir,
        },
        "completed",
      );
      putFixture(
        join(runDir, "run-record.json"),
        makeRunRecord(job, {
          ...source.run,
          run_id: job.run_id,
          job_id: job.job_id,
        }),
      );
      fs.mkdirSync(join(runDir, "output", "tiny.out"), { recursive: true });
      fs.writeFileSync(join(runDir, COMPARED_PATH), OUTPUT_BYTES);
      fs.mkdirSync(join(h.cwd, "runs", id));
      writeWorkspaceRecord(h.cwd, "task", {
        ...h.card,
        linked_jobs: [...h.card.linked_jobs, job.job_id],
      });
      const args = verificationArgs(h);
      args[side === "base" ? "base_run_id" : "candidate_run_id"] = id;
      await rejectedUnchanged(h, args, /run_dir|workspace/iu);
    } finally {
      await h.dispose();
    }
  });
}

test.each(["engineering", "science_assist", "ops"] as const)(
  "%s task cannot authorize verification",
  async (type) => {
    const h = await verificationHarness();
    try {
      writeWorkspaceRecord(
        h.cwd,
        "task",
        TaskCardSchema.parse({ ...h.card, type, source_base_commit: null }),
      );
      await rejectedUnchanged(h, verificationArgs(h), /running|code_change/iu);
    } finally {
      await h.dispose();
    }
  },
);
test.each([
  "created",
  "planned",
  "parked",
  "reporting",
  "awaiting_pi",
  "done",
  "cancelled",
  "blocked",
] as const)("%s task cannot authorize verification", async (status) => {
  const h = await verificationHarness();
  try {
    writeWorkspaceRecord(h.cwd, "task", { ...h.card, status });
    await rejectedUnchanged(h, verificationArgs(h), /running/iu);
  } finally {
    await h.dispose();
  }
});

test.each([
  "base-change",
  "base-openmp",
  "candidate-null-change",
  "unapproved-change",
  "foreign-change",
] as const)("%s cannot authorize a baseline regression", async (fault) => {
  const h = await verificationHarness();
  try {
    const paths = fixturePaths(h, fault.startsWith("base") ? "base" : "candidate");
    if (fault === "base-change")
      putFixture(
        paths.build,
        BuildRecordSchema.parse({
          ...h.base.build,
          change_id: h.change.change_id,
          patch_sha256: h.change.patch_sha256,
          dirty_paths: h.change.files_changed,
        }),
      );
    if (fault === "base-openmp")
      putFixture(paths.build, BuildRecordSchema.parse({ ...h.base.build, rhs_openmp: true }));
    if (fault === "candidate-null-change")
      putFixture(
        paths.build,
        BuildRecordSchema.parse({
          ...h.candidate.build,
          change_id: null,
          patch_sha256: null,
          dirty_paths: [],
        }),
      );
    if (fault === "unapproved-change")
      putFixture(
        paths.change,
        ChangeRequestSchema.parse({
          ...h.change,
          status: "proposed",
          approval_ref: null,
          approved_at: null,
        }),
      );
    if (fault === "foreign-change")
      putFixture(paths.change, ChangeRequestSchema.parse({ ...h.change, task_id: OTHER_TASK }));
    await rejectedUnchanged(h, verificationArgs(h), /change|approved|rhs_openmp/iu);
  } finally {
    await h.dispose();
  }
});

test("equal build commits that differ from the current task pin are rejected", async () => {
  const h = await verificationHarness();
  try {
    for (const side of SIDES)
      putFixture(
        fixturePaths(h, side).build,
        BuildRecordSchema.parse({ ...h[side].build, source_commit: OTHER_COMMIT }),
      );
    const message = await rejectedUnchanged(h, verificationArgs(h), /source_commit|pin/iu);
    expect(message).toContain(OTHER_COMMIT);
    expect(message).toContain(h.card.source_base_commit);
  } finally {
    await h.dispose();
  }
});

test("different build source commits report both actual commits even when neither matches the pin", async () => {
  const h = await verificationHarness();
  try {
    putFixture(
      fixturePaths(h, "base").build,
      BuildRecordSchema.parse({ ...h.base.build, source_commit: OTHER_COMMIT }),
    );
    putFixture(
      fixturePaths(h, "candidate").build,
      BuildRecordSchema.parse({ ...h.candidate.build, source_commit: THIRD_COMMIT }),
    );
    const message = await rejectedUnchanged(h, verificationArgs(h), /commit/iu);
    expect(message).toContain(OTHER_COMMIT);
    expect(message).toContain(THIRD_COMMIT);
  } finally {
    await h.dispose();
  }
});
