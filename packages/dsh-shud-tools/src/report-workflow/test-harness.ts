import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import type { ToolCallId } from "@deepseek-ai/dsh-llm";
import type { ToolExecutionResult } from "@deepseek-ai/dsh-tools";
import {
  BuildRecordSchema,
  ChangeRequestSchema,
  EvidenceReportSchema,
  ReportIdSchema,
  type EvidenceReport,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import {
  createChangeRequest,
  createVerificationCase,
  renderReport,
  serializeRunMetrics,
  writeChangePatch,
  writeWorkspaceRecord,
  type RunMetrics,
} from "@shud-harness/dsh-shud-records";
import { expect } from "vitest";
import { createToolHarness } from "../test-harness.ts";
import { TASK, plannedCard, putCard } from "../task-linked/test-harness.ts";
import { seedQueryRun } from "../../../dsh-shud-jobs/src/list-run-jobs/test-harness.ts";
import { makeRunRecord } from "../../../dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { makeRenderingFixture } from "../../../dsh-shud-records/src/report-workspace-test-harness.ts";
import { completeMetrics, digest } from "../../../dsh-shud-records/src/run-metrics-test-harness.ts";
import {
  makeEvidenceReport,
  makeReportDecision,
} from "../../../dsh-shud-records/src/report-render-test-harness.ts";
import {
  buildCase,
  changeCase,
  verificationCase,
} from "../../../dsh-shud-records/src/workspace-files-test-harness.ts";

export const REPORT = ReportIdSchema.parse("REPORT-20261029T080000-a001");
export const OTHER_REPORT = ReportIdSchema.parse("REPORT-20261029T080000-b002");
export const PRIVATE = "PRIVATE_REPORT_IO_FAILURE_446";
export const DRAFT = {
  task_id: TASK,
  summary: "  Evidence only; {{summary}} stays literal.  ",
  observations: ["Observed one successful execution."],
  limitations: ["No physical interpretation is established."],
  pi_questions: ["Does this evidence justify further investigation?"],
};

export async function reportHarness() {
  const h = await createToolHarness({ pumpPollMs: 600_000 });
  return {
    ...h,
    invoke(name: "report_generate" | "report_validate", args: unknown, withAgent = true) {
      return h.runtime.execute({
        callId: "report-workflow-446" as ToolCallId,
        name,
        arguments: args,
        ...(withAgent ? { agent: h.agent } : {}),
        signal: new AbortController().signal,
      });
    },
  };
}
export interface ReportHarness {
  cwd: string;
  shudBin: string;
  registry: ShudJobRegistry;
}
/** Publish the rendering fixture's first StackLock and DataProvenance that runs reference. */
export function seedStackAndData(h: Pick<ReportHarness, "cwd">) {
  const fixture = makeRenderingFixture();
  const stack = fixture.stacks[0];
  const data = fixture.data[0];
  fs.mkdirSync(join(h.cwd, "stacks"), { recursive: true });
  fs.writeFileSync(join(h.cwd, "stacks", `${stack.stack_id}.json`), JSON.stringify(stack));
  writeWorkspaceRecord(h.cwd, "data", data);
  return { stack, data };
}
export async function seedEvidence(
  h: ReportHarness,
  suffix = "a001",
  jobChanges: Partial<RunJob> = {},
  runChanges: Partial<RunRecord> = {},
  index: "active" | "completed" = "completed",
) {
  const { stack, data } = seedStackAndData(h);
  const job = await seedQueryRun(
    h,
    suffix,
    {
      task_id: TASK,
      status: "collected",
      stack_id: stack.stack_id,
      data_id: data.data_id,
      exit_code: 0,
      submitted_at: "2026-10-22T03:15:00Z",
      started_at: "2026-10-22T03:15:00Z",
      finished_at: "2026-10-22T03:16:00Z",
      ...jobChanges,
    },
    index,
  );
  const run = makeRunRecord(job, runChanges);
  await io.writeFile(join(job.run_dir, "run-record.json"), JSON.stringify(run));
  putCard(
    h,
    plannedCard({
      status: "running",
      linked_jobs: [job.job_id],
      linked_reports: [],
      stack_id: job.stack_id,
      data_id: job.data_id,
    }),
  );
  return { job, run, stack, data };
}

/** completeMetrics with zero CVODE failures and negative states: every verdict passes. */
export function passingMetrics(): RunMetrics {
  const metrics = completeMetrics();
  metrics.numerical_health.cvode_failures = 0;
  metrics.numerical_health.negative_state_count = 0;
  return {
    ...metrics,
    verdicts: {
      water_balance_residual: "pass",
      cvode_failures: "pass",
      negative_state_count: "pass",
    },
  };
}

export function installMetrics(runDir: string, run: RunRecord, metrics: RunMetrics) {
  const bytes = serializeRunMetrics(metrics);
  const path = join(runDir, "metrics.json");
  fs.writeFileSync(path, bytes);
  run.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(bytes) };
  fs.writeFileSync(join(runDir, "run-record.json"), JSON.stringify(run));
  return path;
}

export async function seedCodeChangeEvidence(h: ReportHarness) {
  // Published SHA-256 "abc" vector from the canonical record fixtures.
  const bytes = "abc";
  const change = createChangeRequest(
    h.cwd,
    ChangeRequestSchema.parse({
      ...changeCase.value,
      task_id: TASK,
      status: "approved",
      approval_ref: "fixture-approved-change-541",
      approved_at: "2026-11-02T09:01:00Z",
    }),
  );
  writeChangePatch(h.cwd, change.change_id, bytes);
  const runs = [];
  for (const [index, suffix] of ["1001", "1002"].entries()) {
    const buildId = `BUILD-20261102T090000-${suffix}`;
    const build = BuildRecordSchema.parse({
      ...buildCase.value,
      build_id: buildId,
      task_id: TASK,
      change_id: index === 0 ? null : change.change_id,
      patch_sha256: index === 0 ? null : change.patch_sha256,
      dirty_paths: index === 0 ? [] : change.files_changed,
      binary_path: `builds/${buildId}/shud`,
      stdout_path: `builds/${buildId}/make.stdout.log`,
      stderr_path: `builds/${buildId}/make.stderr.log`,
    });
    // Immutable build evidence uses a schema-qualified fixture, never the mutable writer.
    await io.mkdir(join(h.cwd, "builds", buildId), { recursive: true });
    await io.writeFile(join(h.cwd, "builds", buildId, "build-record.json"), JSON.stringify(build));
    const lineage = {
      build_id: build.build_id,
      binary_sha256: build.binary_sha256,
      threads: 1,
    };
    const evidence = await seedEvidence(h, suffix, lineage, {
      ...lineage,
      artifacts: {
        stdout: "stdout.log",
        stderr: "stderr.log",
        shud_output: "output/tiny.out",
        files: [{ path: "output/tiny.out/tiny.rivqdown.dat", size_bytes: 3 }],
      },
    });
    await io.mkdir(join(evidence.job.run_dir, "output", "tiny.out"), { recursive: true });
    await io.writeFile(
      join(evidence.job.run_dir, "output", "tiny.out", "tiny.rivqdown.dat"),
      bytes,
    );
    runs.push({ ...evidence, build });
  }
  const [base, candidate] = runs;
  const verification = createVerificationCase(h.cwd, {
    ...verificationCase.schema.parse(verificationCase.value),
    task_id: TASK,
    change_id: change.change_id,
    base_run_id: base.run.run_id,
    candidate_run_id: candidate.run.run_id,
    base_build_id: base.build.build_id,
    candidate_build_id: candidate.build.build_id,
    artifact_refs: runs.map(({ run }) => `runs/${run.run_id}/output/tiny.out/tiny.rivqdown.dat`),
    observed: {
      ...verificationCase.value.observed,
      compared_path: "output/tiny.out/tiny.rivqdown.dat",
    },
  });
  // seedEvidence replaces the card: publish the complete union only after both runs exist.
  const card = putCard(
    h,
    plannedCard({
      type: "code_change",
      status: "running",
      runtime_phase: "running_local",
      source_base_commit: change.base_commit,
      stack_id: base.stack.stack_id,
      data_id: base.data.data_id,
      linked_jobs: runs.map(({ job }) => job.job_id),
      linked_changes: [change.change_id],
      linked_verifications: [verification.vc_id],
      linked_reports: [],
    }),
  );
  return { card, change, verification, runs };
}

export function reportPath(h: Pick<ReportHarness, "cwd">, id = REPORT, extension = "json") {
  return join(fs.realpathSync.native(h.cwd), "reports", `${id}.${extension}`);
}
export function readReport(h: ReportHarness, id = REPORT) {
  return EvidenceReportSchema.parse(JSON.parse(fs.readFileSync(reportPath(h, id), "utf8")));
}
export function resultValue(result: ToolExecutionResult): Record<string, unknown> {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  if (result.isError) throw new Error(result.error.message);
  expect(result.value).toBeTypeOf("object");
  return result.value as Record<string, unknown>;
}
export function generated(h: ReportHarness, result: ToolExecutionResult) {
  const value = resultValue(result);
  const id = ReportIdSchema.parse(value.report_id);
  expect(value).toEqual({ report_id: id, status: "draft" });
  return readReport(h, id);
}
export function putReport(
  h: ReportHarness,
  run: RunRecord,
  changes: Partial<EvidenceReport> = {},
  markdown = true,
) {
  const report = makeEvidenceReport({
    report_id: REPORT,
    task_id: TASK,
    linked_runs: [run.run_id],
    stack_ids: [run.stack_id!],
    data_ids: [run.data_id!],
    llm_response_models: [run.llm.response_model],
    ...changes,
  });
  writeWorkspaceRecord(h.cwd, "report", report);
  if (markdown)
    fs.writeFileSync(reportPath(h, report.report_id, "md"), renderReport(h.cwd, report.report_id));
  return report;
}
export function terminalReport(
  h: ReportHarness,
  run: RunRecord,
  status: "accepted" | "rejected" | "revision_requested",
) {
  return putReport(h, run, {
    status,
    decision_history: [makeReportDecision(status, { report_id: REPORT })],
  });
}
export async function fileSnapshot(path: string) {
  return { bytes: await io.readFile(path), mtime: (await io.stat(path, { bigint: true })).mtimeNs };
}

export function expectReportError(result: ToolExecutionResult, message: RegExp) {
  expect(result.isError, JSON.stringify(result)).toBe(true);
  if (!result.isError) throw new Error("Expected a controlled report tool error");
  const info: unknown = result.error.info;
  const code = typeof info === "object" && info !== null && "code" in info ? info.code : undefined;
  expect(code).not.toBe("UNKNOWN_TOOL");
  expect(result.error.message).toMatch(message);
  return result.error.message;
}
