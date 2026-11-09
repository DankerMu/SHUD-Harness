import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { REPORT_LIMITATION_TEMPLATES } from "../../../packages/dsh-shud-core/src/governance/wording.ts";
import { renderReport } from "../../../packages/dsh-shud-records/src/report-render.ts";
import { makeRenderingFixture } from "../../../packages/dsh-shud-records/src/report-workspace-test-harness.ts";
import {
  makeEvidenceReport,
  makeReportDecision,
} from "../../../packages/dsh-shud-records/src/report-render-test-harness.ts";
import {
  makeRunJob,
  makeRunRecord,
  makeTaskCard,
} from "../../../packages/dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { digest } from "../../../packages/dsh-shud-records/src/run-metrics-test-harness.ts";
import type { FirstTaskEvidence } from "../shud-first-task-evidence.ts";
import type { SessionLog } from "../shud-session-log.ts";
import { snapshotFirstTaskFiles } from "../shud-first-task.ts";

/** Synthetic accepted evidence with real report files; no host, solver, credentials or historic logs. */
export function makeFirstTaskFixture(workspace: string, metricBytes?: string) {
  const home = join(workspace, "private-home");
  const base = makeRenderingFixture();
  const stack = base.stacks[0];
  const provenance = base.data[0];
  const job = makeRunJob("JOB-20261029T080000-b002", {
    task_id: base.report.task_id,
    stack_id: stack.stack_id,
    data_id: provenance.data_id,
    owner_session: "first-worker",
    run_dir: join(workspace, "runs/RUN-20261029T080000-b002"),
    input_dir: join(workspace, "input/ccw"),
    dsh_job_id: "shud-0123456789abcdef",
    dsh_job_ids: ["shud-0123456789abcdef"],
    llm: { response_model: stack.llm.response_model, response_model_source: "response" },
  });
  const record = makeRunRecord(job, { llm: job.llm });
  if (metricBytes !== undefined) {
    record.artifacts.metrics_summary = { path: "metrics.json", sha256: digest(metricBytes) };
  }
  const report = makeEvidenceReport({
    task_id: job.task_id!,
    status: "accepted",
    linked_runs: [record.run_id],
    stack_ids: [stack.stack_id],
    data_ids: [provenance.data_id],
    llm_response_models: [record.llm.response_model],
    change_ids: [],
    verification_ids: [],
    limitations: [
      "Constructed engineering evidence only.",
      REPORT_LIMITATION_TEMPLATES.max_solver_dt,
    ],
    decision_history: [makeReportDecision("accepted", { approval_ref: "call-submit" })],
  });
  const task = makeTaskCard({
    task_id: report.task_id,
    type: "science_assist",
    status: "done",
    runtime_phase: null,
    stack_id: stack.stack_id,
    data_id: provenance.data_id,
    linked_jobs: [job.job_id],
    linked_reports: [report.report_id],
  });
  const files: Record<string, unknown> = {
    [`tasks/${task.task_id}/task.json`]: task,
    [`runs/${job.run_id}/run-job.json`]: job,
    [`runs/${job.run_id}/run-record.json`]: record,
    [`stacks/${stack.stack_id}.json`]: stack,
    [`provenance/${provenance.data_id}.json`]: provenance,
    [`reports/${report.report_id}.json`]: report,
  };
  for (const [relative, value] of Object.entries(files)) {
    const path = join(workspace, relative);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(value));
  }
  if (metricBytes !== undefined) writeFileSync(join(job.run_dir, "metrics.json"), metricBytes);
  const markdownPath = `reports/${report.report_id}.md`;
  writeFileSync(join(workspace, markdownPath), renderReport(workspace, report.report_id));

  let clock = Date.parse("2026-10-29T08:00:00Z");
  function session(id: string, worker: boolean): SessionLog {
    return {
      header: {
        type: "session",
        version: 4,
        id,
        createdAt: ++clock,
        cwd: workspace,
        agentPreset: worker ? "worker" : "coordinator",
        delegationDepth: worker ? 1 : 0,
        ...(worker ? { origin: "subagent", parentSession: "first-root" } : {}),
      },
      events: [],
      asOfSeq: -1,
      flushedThroughSeq: -1,
      canonicalLog: `${home}/sessions/2026-10-29/${id}/session.v4.jsonl.zstd`,
    };
  }
  function append(log: SessionLog, type: string, data: unknown) {
    const seq = log.events.length;
    log.events.push({ type, data, seq, time: ++clock });
    log.asOfSeq = seq;
    log.flushedThroughSeq = seq;
  }
  function call(log: SessionLog, name: string, callId: string, args: unknown) {
    append(log, "tool/call", { name, callId, arguments: JSON.stringify(args) });
  }
  function result(log: SessionLog, callId: string, value: unknown) {
    append(log, "tool/result", {
      message: {
        role: "tool",
        toolCallId: callId,
        source: { kind: "tool", callId },
        isError: false,
        content: [
          { type: "text", text: typeof value === "string" ? value : JSON.stringify(value) },
        ],
      },
    });
  }
  const root = session("first-root", false);
  const worker = session("first-worker", true);
  call(root, "task_create", "call-task", { type: "science_assist" });
  result(root, "call-task", { task_id: task.task_id, status: "planned" });
  call(root, "subagent", "call-worker", {
    agent_preset: "worker",
    prompt: `${task.task_id} ${job.input_dir}`,
  });
  append(root, "subagent/catalog", {
    childId: worker.header.id,
    childCreatedAt: worker.header.createdAt,
  });
  result(root, "call-worker", "started subagent first-worker");
  call(worker, "shud_run", "call-run", {
    task_id: task.task_id,
    input_dir: job.input_dir,
    end_days: 30,
  });
  result(
    worker,
    "call-run",
    `SHUD running: job_id=${job.job_id}, run_id=${job.run_id}, dsh_job_id=${job.dsh_job_id}, run_dir=${job.run_dir}.\n`,
  );
  call(worker, "job_output", "call-wait", { job_id: job.dsh_job_id, wait: true });
  result(worker, "call-wait", "[status: completed, SHUD exited with code 0]");
  call(worker, "shud_collect", "call-collect", { run_id: job.run_id });
  result(worker, "call-collect", record);
  append(worker, "turn/end", { reason: { kind: "completed" } });
  append(root, "user/message", {
    source: { kind: "subagent-settled", senderSessionId: worker.header.id },
  });
  call(root, "report_generate", "call-generate", { task_id: task.task_id });
  result(root, "call-generate", { report_id: report.report_id, status: "draft" });
  call(root, "report_validate", "call-validate", { report_id: report.report_id });
  result(root, "call-validate", { report_id: report.report_id, status: "reviewed", ok: true });
  call(root, "report_submit", "call-submit", { report_id: report.report_id });
  append(root, "approval/asked", {
    id: "approval-submit",
    callId: "call-submit",
    toolName: "report_submit",
    reason: `PI approval required for report ${report.report_id}`,
  });
  append(root, "approval/decided", { id: "approval-submit", outcome: "allowed-once" });
  result(root, "call-submit", {
    report_id: report.report_id,
    status: "accepted",
    decision_id: report.decision_history[0].decision_id,
  });
  const hashes = { "ccw.mesh": "a".repeat(64) };
  const evidence: FirstTaskEvidence = {
    workspace,
    home,
    root,
    children: [worker],
    files: snapshotFirstTaskFiles(workspace),
    actualStack: {
      commits: {
        SHUD: stack.repos.SHUD.commit,
        rSHUD: stack.repos.rSHUD.commit,
        AutoSHUD: stack.repos.AutoSHUD.commit,
      },
      llm: { ...stack.llm },
    },
    inputs: { before: hashes, sourceAfter: { ...hashes }, copyAfter: { ...hashes } },
  };
  return { evidence, record, report, markdownPath };
}
