import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { zstdCompressSync } from "node:zlib";
import {
  AnalysisPlanSchema,
  DataProvenanceSchema,
  StackLockSchema,
  type AnalysisPlan,
  type EvidenceReport,
  type RunJob,
  type RunRecord,
  type TaskCard,
} from "../../../packages/dsh-shud-core/src/schemas/index.ts";
import {
  buildSensitivitySummary,
  createSensitivityClosureLoaders,
  deriveSensitivityClosure,
  renderReport,
  serializeRunMetrics,
  serializeSensitivitySummary,
} from "../../../packages/dsh-shud-records/src/index.ts";
import {
  COVERAGE,
  PARAMETER_RANGE,
} from "../../../packages/dsh-shud-records/src/report-sensitivity-test-harness.ts";
import {
  makeEvidenceReport,
  makeReportDecision,
} from "../../../packages/dsh-shud-records/src/report-render-test-harness.ts";
import { completeMetrics } from "../../../packages/dsh-shud-records/src/run-metrics-test-harness.ts";
import { sections } from "../../../packages/dsh-shud-records/src/shud-text-test-harness.ts";
import {
  makeRunJob,
  makeRunRecord,
  makeTaskCard,
} from "../../../packages/dsh-shud-records/src/task-lifecycle-test-harness.ts";
import { stackCase } from "../../../packages/dsh-shud-records/src/test-harness.ts";
import { runSensitivityEvaluateCli } from "../shud-sensitivity-evaluate.ts";
import { prepareSensitivityWorkspace } from "../shud-sensitivity-prepare.ts";
import {
  hash,
  makeSensitivityHarness,
  type SensitivityHarness,
} from "../sensitivity/test-harness.ts";

const TASK = "TASK-20261110T090000-a001";
export const PLAN = "PLAN-20261110T090000-b001";
export const REPORT = "REPORT-20261110T090000-c001";
const STACK = "STACK-20261110T090000-d001";
const DATA = "DATA-20261110T090000-e001";
export const job = (n: number) => `JOB-20261110T090000-000${n}`;
export const run = (n: number) => `RUN-20261110T090000-000${n}`;
export const ROOT_ID = "session-coordinator-670";
export const WORKER_ID = "session-worker-670";
const SUBMIT_CALL = "call-report-submit-670";
/** The fixed acceptance plan, written out independently of the evaluator's constant. */
const FIXED_CHANGES = [{}, { GEOL_KSATH: 0.5 }, { GEOL_KSATH: 2 }, { LC_ROUGH: 2 }];

interface Event {
  type: string;
  seq: number;
  time: number;
  data: unknown;
}
export interface FixtureSession {
  header: Record<string, unknown>;
  events: Event[];
}

let clock = 1_762_765_200_000;
export function emit(session: FixtureSession, type: string, data: unknown): void {
  session.events.push({ type, seq: session.events.length, time: ++clock, data });
}
/** One tool round trip as the canonical log records it: `tool/call` then its `tool/result`. */
export function toolRoundTrip(
  session: FixtureSession,
  name: string,
  callId: string,
  output: unknown,
) {
  emit(session, "tool/call", { callId, name, arguments: "{}" });
  const content = [{ type: "text", text: JSON.stringify(output) }];
  const source = { kind: "tool", callId };
  emit(session, "tool/result", {
    message: { role: "tool", toolCallId: callId, source, content, isError: false },
  });
}
export function ask(session: FixtureSession, id: string, toolName: string, callId: string) {
  emit(session, "approval/asked", { id, toolName, callId, reason: "fixture approval" });
  emit(session, "approval/decided", { id, outcome: "allowed-once" });
}
export function newSession(id: string, agentPreset: string, cwd: string): FixtureSession {
  const child = agentPreset === "coordinator" ? {} : { origin: "subagent", parentSession: ROOT_ID };
  const header = {
    type: "session",
    version: 4,
    id,
    createdAt: ++clock,
    cwd,
    agentPreset,
    ...child,
  };
  const session = { header, events: [] };
  emit(session, "request/header", { reason: "initial", header: { config: { model: "m" } } });
  return session;
}

export interface EvaluateFixture {
  h: SensitivityHarness;
  workspace: string;
  home: string;
  logPath: string;
  repeatPath: string;
  argv: string[];
  plan: AnalysisPlan;
  card: TaskCard;
  jobs: RunJob[];
  records: RunRecord[];
  report: EvidenceReport;
  sessions: FixtureSession[];
  writeJson(relative: string, value: unknown): void;
  publishReport(): void;
  publishLogs(): void;
}

/**
 * Best constructed PR A fixture: a prepared ccw workspace (through the real preparation writer),
 * one sensitivity card bound to the fixed plan, four collected succeeded runs on one StackLock,
 * an accepted report whose Markdown is the records rendering, and coordinator + worker canonical
 * logs with exactly one report_submit approval. Criteria 4-7 and 13 evidence is not constructed.
 */
export async function makeEvaluateFixture(): Promise<EvaluateFixture> {
  const h = makeSensitivityHarness();
  fs.writeFileSync(join(h.source, "ccw.para.geol"), sections.geol);
  fs.writeFileSync(join(h.source, "ccw.para.lc"), sections.lc);
  const scratch = dirname(h.workspace);
  const repeatPath = join(h.evidence, "repeat.json");
  const home = join(scratch, "home");
  await prepareSensitivityWorkspace({
    workspace: h.workspace,
    recordPath: h.record,
    root: h.root,
    env: h.env,
  });
  const ws = h.workspace;
  const input = join(ws, "input/ccw");
  const writeJson = (relative: string, value: unknown) => {
    fs.mkdirSync(dirname(join(ws, relative)), { recursive: true });
    fs.writeFileSync(join(ws, relative), `${JSON.stringify(value, null, 2)}\n`);
  };
  const digestOf = (name: string) => hash("sha256", fs.readFileSync(join(input, name)));
  const plan = AnalysisPlanSchema.parse({
    analysis_plan_id: PLAN,
    task_id: TASK,
    mode: "sensitivity",
    strategy: "one_at_a_time",
    input_dir: input,
    project: "ccw",
    end_days: 90,
    threads: 1,
    parameter_sets: FIXED_CHANGES.map((changes, index) => ({
      parameter_set_id: `PSET-${index + 1}`,
      label: index === 0 ? "baseline" : null,
      baseline: index === 0,
      changes,
    })),
    parameter_space_rationale: { proposed_by: "agent", basis: "OAT", confirmed_by: null },
    input_digests: Object.fromEntries(
      ["ccw.cfg.calib", "ccw.para.geol", "ccw.para.lc"].map((name) => [name, digestOf(name)]),
    ),
    created_by: "coordinator",
    created_at: "2026-11-10T09:00:00Z",
  });
  const planBytes = Buffer.from(`${JSON.stringify(plan, null, 2)}\n`);
  fs.mkdirSync(join(ws, "analyses"));
  fs.writeFileSync(join(ws, `analyses/${PLAN}.json`), planBytes);
  writeJson(`stacks/${STACK}.json`, StackLockSchema.parse({ ...stackCase.value, stack_id: STACK }));
  writeJson(
    `provenance/${DATA}.json`,
    DataProvenanceSchema.parse({
      data_id: DATA,
      basin: "ccw",
      event_window: { start: null, end: null },
      sources: { input_root: input, files: [] },
      preprocess: null,
      uncertainty_notes: null,
    }),
  );
  const metrics = serializeRunMetrics(completeMetrics());
  const bound = { task_id: TASK, stack_id: STACK, data_id: DATA, analysis_plan_id: PLAN };
  const jobs = plan.parameter_sets.map((set, index) =>
    makeRunJob(job(index + 1), {
      ...bound,
      parameter_set_id: set.parameter_set_id,
      end_days: 90,
      threads: 1,
      input_dir: join(ws, "runs", run(index + 1), "input/ccw"),
      run_dir: join(ws, "runs", run(index + 1)),
      owner_session: WORKER_ID,
    }),
  );
  const records = jobs.map((value) => {
    const artifacts = makeRunRecord(value).artifacts;
    return makeRunRecord(value, {
      ...bound,
      parameter_set_id: value.parameter_set_id,
      threads: 1,
      artifacts: {
        ...artifacts,
        metrics_summary: { path: "metrics.json", sha256: hash("sha256", Buffer.from(metrics)) },
      },
    });
  });
  jobs.forEach((value, index) => {
    writeJson(`runs/${value.run_id}/run-job.json`, value);
    writeJson(`runs/${value.run_id}/run-record.json`, records[index]);
    fs.writeFileSync(join(ws, `runs/${value.run_id}/metrics.json`), metrics);
  });
  const card = makeTaskCard({
    task_id: TASK,
    type: "sensitivity",
    status: "done",
    runtime_phase: null,
    source_base_commit: null,
    stack_id: STACK,
    data_id: DATA,
    linked_analyses: [PLAN],
    linked_jobs: jobs.map((value) => value.job_id),
    linked_reports: [REPORT],
  });
  writeJson(`tasks/${TASK}/task.json`, card);
  const draft = {
    observations: ["Section 5 lists stored per-run metrics."],
    limitations: [COVERAGE, PARAMETER_RANGE],
    pi_questions: ["Review the stored sensitivity facts?"],
  };
  const runJobs = jobs.map((value) => ({ job: value, collect_error_attempts: 0 }));
  const closure = deriveSensitivityClosure(
    card,
    runJobs,
    records,
    draft,
    createSensitivityClosureLoaders(ws),
  );
  if (!closure.ok) throw new Error(`Fixture closure failed: ${JSON.stringify(closure)}`);
  const summary = serializeSensitivitySummary(buildSensitivitySummary(closure, planBytes));
  const summaryPath = `reports/${REPORT}.sensitivity.json`;
  fs.mkdirSync(join(ws, "reports"));
  fs.writeFileSync(join(ws, summaryPath), summary);
  const report = makeEvidenceReport({
    ...draft,
    report_id: REPORT,
    task_id: TASK,
    status: "accepted",
    summary: "Four parameter sets were run relative to one baseline.",
    linked_runs: records.map((value) => value.run_id),
    stack_ids: [STACK],
    data_ids: [DATA],
    llm_response_models: ["fixture-model"],
    analysis_ids: [PLAN],
    sensitivity_summary: { path: summaryPath, sha256: hash("sha256", Buffer.from(summary)) },
    decision_history: [
      makeReportDecision("accepted", { report_id: REPORT, approval_ref: SUBMIT_CALL }),
    ],
  } as Partial<EvidenceReport>);

  const root = newSession(ROOT_ID, "coordinator", ws);
  toolRoundTrip(root, "analysis_create", "call-analysis-create", { analysis_plan_id: PLAN });
  emit(root, "subagent/catalog", { childId: WORKER_ID });
  const worker = newSession(WORKER_ID, "worker", ws);
  jobs.forEach((value, index) => toolRoundTrip(worker, "shud_run", `call-run-${index + 1}`, value));
  ask(root, "approval-report", "report_submit", SUBMIT_CALL);
  toolRoundTrip(root, "report_submit", SUBMIT_CALL, { report_id: REPORT, status: "awaiting_pi" });
  const logPath = join(home, "sessions/fixture", ROOT_ID, "session.v4.jsonl.zstd");
  const fixture: EvaluateFixture = {
    h,
    workspace: ws,
    home,
    logPath,
    repeatPath,
    argv: [ws, logPath, h.record, repeatPath],
    plan,
    card,
    jobs,
    records,
    report,
    sessions: [root, worker],
    writeJson,
    publishReport() {
      writeJson(`reports/${REPORT}.json`, fixture.report);
      fs.writeFileSync(join(ws, `reports/${REPORT}.md`), renderReport(ws, REPORT));
    },
    publishLogs() {
      for (const { header, events } of fixture.sessions) {
        const path = join(home, "sessions/fixture", String(header.id), "session.v4.jsonl.zstd");
        fs.mkdirSync(dirname(path), { recursive: true });
        const lines = [header, ...events].map((row) =>
          zstdCompressSync(`${JSON.stringify(row)}\n`),
        );
        fs.writeFileSync(path, Buffer.concat(lines));
      }
    },
  };
  fixture.publishReport();
  fixture.publishLogs();
  const baseline = fs.readdirSync(input).filter((name) => fs.statSync(join(input, name)).isFile());
  fs.writeFileSync(
    repeatPath,
    `${JSON.stringify({
      status: "executed",
      exit_code: 0,
      input_sha256: Object.fromEntries(baseline.map((name) => [name, digestOf(name)])),
      omp_num_threads: "1",
      shud_rhs_threads: "1",
      rivqdown_sha256: hash("sha256", Buffer.from("rivqdown")),
      run_id: "repeat-baseline",
      baseline_run_id: run(1),
    })}\n`,
  );
  return fixture;
}

/** Paths, byte sha256 and mtimes of every entry under a directory (directories included). */
export function treeState(directory: string): Record<string, string> {
  const state: Record<string, string> = {};
  for (const name of fs.readdirSync(directory, { recursive: true, encoding: "utf8" }).sort()) {
    const path = join(directory, name);
    const stat = fs.lstatSync(path);
    state[name] = stat.isFile()
      ? `${hash("sha256", fs.readFileSync(path))} ${stat.mtimeMs}`
      : `${stat.isDirectory() ? "dir" : "other"} ${stat.mtimeMs}`;
  }
  return state;
}

/** In-process CLI run capturing stderr; failed criteria are keyed by number. */
export async function evaluate(f: EvaluateFixture, argv = f.argv) {
  const chunks: string[] = [];
  const write = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk: string | Uint8Array) => {
    chunks.push(String(chunk));
    return true;
  };
  let code: number;
  try {
    code = await runSensitivityEvaluateCli(argv, { root: f.h.root });
  } finally {
    process.stderr.write = write;
  }
  const stderr = chunks.join("");
  const lines = [...stderr.matchAll(/^shud:sensitivity: criterion (\d+): (.*)$/gmu)];
  return { code, stderr, criteria: new Map(lines.map((m) => [Number(m[1]), m[2]])) };
}
