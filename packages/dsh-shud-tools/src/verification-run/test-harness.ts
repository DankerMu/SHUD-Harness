import * as io from "node:fs/promises";
import { join } from "node:path";
import type { Context } from "@deepseek-ai/cordis";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import {
  BuildRecordSchema,
  ChangeRequestSchema,
  DataProvenanceSchema,
  VerificationIdSchema,
  type BuildRecord,
} from "@shud-harness/dsh-shud-core";
import { createChangeRequest, writeWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import * as rawGuard from "@shud-harness/dsh-shud-raw-guard";
import * as policyGate from "../../../dsh-shud-policy-gate/src/index.ts";
import {
  seedQueryRun,
  snapshotQueryTree,
  type QueryFixture,
} from "../../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { makeRunRecord } from "../../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import {
  buildCase,
  changeCase,
} from "../../../dsh-shud-records/src/workspace-files-test-harness.ts";
import { fileSnapshot } from "../report-workflow/test-harness.ts";
import { plannedCard, putCard } from "../task-linked/test-harness.ts";
import { createToolHarness } from "../test-harness.ts";

// SHA-256's published "abc" test vector, independent of the production comparator.
export const OUTPUT_BYTES = "abc";
export const OUTPUT_SHA256 = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";
export const COMPARED_PATH = "output/tiny.out/tiny.rivqdown.dat";
export const PRIOR_VERIFICATION = VerificationIdSchema.parse("VC-20261101T090000-0001");
export const REVIEWER_NOTES = ["Byte equality is regression evidence, not scientific acceptance."];

async function seedCollectedRun(h: QueryFixture, suffix: string, build: BuildRecord) {
  // Construct immutable build evidence directly; the mutable workspace writer rejects builds.
  await io.mkdir(join(h.cwd, "builds", build.build_id), { recursive: true });
  await io.writeFile(
    join(h.cwd, "builds", build.build_id, "build-record.json"),
    `${JSON.stringify(build)}\n`,
  );
  const data = DataProvenanceSchema.parse({
    data_id: `DATA-20261022T031500-${suffix}`,
    basin: "tiny",
    event_window: { start: null, end: null },
    sources: {
      input_root: join(h.cwd, "runs", `RUN-20261022T031500-${suffix}`, "input"),
      files: [{ path: "tiny.cfg.para", sha256: OUTPUT_SHA256, size_bytes: 3 }],
      external_files: [{ path: "/fixture/forcing.dat", sha256: OUTPUT_SHA256, size_bytes: 3 }],
    },
    preprocess: null,
    uncertainty_notes: null,
  });
  writeWorkspaceRecord(h.cwd, "data", data);
  const job = await seedQueryRun(
    h,
    suffix,
    {
      task_id: build.task_id,
      build_id: build.build_id,
      binary_sha256: build.binary_sha256,
      threads: 1,
      data_id: data.data_id,
      status: "collected",
      input_dir: data.sources.input_root,
      exit_code: 0,
      submitted_at: "2026-10-22T03:15:00Z",
      started_at: "2026-10-22T03:15:00Z",
      finished_at: "2026-10-22T03:16:00Z",
    },
    "completed",
  );
  const run = makeRunRecord(job, {
    build_id: build.build_id,
    binary_sha256: build.binary_sha256,
    threads: 1,
    command: job.command,
    artifacts: {
      stdout: "stdout.log",
      stderr: "stderr.log",
      shud_output: "output/tiny.out",
      files: [{ path: COMPARED_PATH, size_bytes: 3 }],
    },
  });
  await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(run));
  await io.mkdir(join(job.run_dir, "output", "tiny.out"), { recursive: true });
  await io.writeFile(join(job.run_dir, COMPARED_PATH), OUTPUT_BYTES);
  return { job, run, build, data };
}

export async function verificationHarness(options: { rawDirs?: string[]; policy?: boolean } = {}) {
  const h = await createToolHarness({ pumpPollMs: 600_000 });
  const current: { preset: unknown } = { preset: "reviewer" };
  try {
    // Only the public current-session projection is doubled; tools and registry are real.
    Object.assign(h.agent.session.header, { agentPreset: "worker" });
    await h.agent.ctx.plugin((services: Context) => {
      services.provide("sessionProjections", {
        stateOf(session: object, key: string) {
          return session === h.agent.session && key === "agentPreset" ? current.preset : undefined;
        },
      });
    });
    await h.agent.ctx.plugin({
      inject: ["sessionProjections"],
      apply(consumer: Context) {
        Object.assign(h.agent, { ctx: consumer });
      },
    });
    const change = createChangeRequest(
      h.cwd,
      ChangeRequestSchema.parse({
        ...changeCase.value,
        status: "approved",
        approval_ref: "fixture-approved-change-540",
        approved_at: "2026-11-02T09:01:00Z",
      }),
    );
    const baseBuildId = "BUILD-20261102T090000-1001";
    const base = await seedCollectedRun(
      h,
      "1001",
      BuildRecordSchema.parse({
        ...buildCase.value,
        build_id: baseBuildId,
        change_id: null,
        patch_sha256: null,
        dirty_paths: [],
        binary_path: `builds/${baseBuildId}/shud`,
        stdout_path: `builds/${baseBuildId}/make.stdout.log`,
        stderr_path: `builds/${baseBuildId}/make.stderr.log`,
      }),
    );
    const candidate = await seedCollectedRun(
      h,
      "1002",
      BuildRecordSchema.parse({ ...buildCase.value, change_id: change.change_id }),
    );
    // Finalize the union once: seeding a second run must not lose the first job link.
    const card = putCard(
      h,
      plannedCard({
        task_id: change.task_id,
        type: "code_change",
        status: "running",
        runtime_phase: "running_local",
        source_base_commit: change.base_commit,
        linked_jobs: [base.job.job_id, candidate.job.job_id],
        linked_changes: [change.change_id],
        linked_reports: [],
        linked_verifications: [PRIOR_VERIFICATION],
      }),
    );
    if (options.rawDirs !== undefined) await h.apply(rawGuard, { rawDirs: options.rawDirs });
    if (options.policy) await h.apply(policyGate, {});
    return {
      ...h,
      base,
      candidate,
      change,
      card,
      current,
      invoke(
        arguments_: unknown = {
          task_id: card.task_id,
          base_run_id: base.job.run_id,
          candidate_run_id: candidate.job.run_id,
          reviewer_notes: [...REVIEWER_NOTES],
          compatibility_verdict: "compatible",
        },
      ) {
        return h.runtime.execute({
          callId: "verification-run-replay-540" as ToolCallId,
          name: "verification_run",
          arguments: arguments_,
          agent: h.agent,
          signal: new AbortController().signal,
        });
      },
      async evidenceSnapshot() {
        return {
          runs: await snapshotQueryTree(join(h.cwd, "runs")),
          provenance: await snapshotQueryTree(join(h.cwd, "provenance")),
          builds: await snapshotQueryTree(join(h.cwd, "builds")),
          changes: await snapshotQueryTree(join(h.cwd, "changes")),
          active: await fileSnapshot(join(h.stateDir, "active.json")),
          completed: await fileSnapshot(join(h.stateDir, "completed.json")),
        };
      },
    };
  } catch (error) {
    await h.dispose();
    throw error;
  }
}
