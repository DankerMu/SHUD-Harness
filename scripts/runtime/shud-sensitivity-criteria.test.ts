import * as fs from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, expect, test } from "vitest";
import { git } from "./sensitivity/test-harness.ts";
import {
  PLAN,
  REPORT,
  ROOT_ID,
  WORKER_ID,
  ask,
  emit,
  evaluate,
  job,
  makeEvaluateFixture,
  newSession,
  run,
  toolRoundTrip,
  treeState,
  type EvaluateFixture,
  type FixtureSession,
} from "./sensitivity-evaluate/test-harness.ts";

let f: EvaluateFixture;
beforeEach(async () => {
  f = await makeEvaluateFixture();
});
afterEach(() => f.h.dispose());

const PR_B = "implemented in 7.1b-2";
const writePlan = () => f.writeJson(`analyses/${PLAN}.json`, f.plan);
const writeCard = () => f.writeJson(`tasks/${f.card.task_id}/task.json`, f.card);
const writeRecord = (n: number) => f.writeJson(`runs/${run(n)}/run-record.json`, f.records[n - 1]);
/** Rewrite the root coordinator log's events (where the one report_submit approval lives). */
const rootEvents = (edit: (events: FixtureSession["events"]) => FixtureSession["events"]) => {
  f.sessions[0].events = edit(f.sessions[0].events).map((event, seq) => ({ ...event, seq }));
  f.publishLogs();
};
const OTHER_TASK = "TASK-20261110T090000-a002";
const OTHER_PLAN = "PLAN-20261110T090000-b002";

test("the best PR A fixture satisfies criteria 1, 2, 3, 8, 9, 10, 11 and 12", async () => {
  const result = await evaluate(f);
  expect(result.code).toBe(1);
  expect([...result.criteria.keys()]).toEqual([4, 5, 6, 7, 13]);
  for (const detail of result.criteria.values()) expect(detail).toBe(PR_B);
});

type Case = [name: string, criterion: number, mutate: () => void, detail: RegExp[]];
const SHA_A = "a".repeat(64);
const STACK = "STACK-20261110T090000-d001";
const CASES: Case[] = [
  [
    "no sensitivity card",
    1,
    () => fs.rmSync(join(f.workspace, "tasks"), { recursive: true }),
    [/0 sensitivity TaskCards/u],
  ],
  [
    "empty linked_analyses",
    1,
    () => {
      f.card.linked_analyses = [];
      writeCard();
    },
    [/linked_analyses has 0 entries/u],
  ],
  [
    "LC_ROUGH×0.5 instead of ×2",
    1,
    () => {
      f.plan.parameter_sets[3].changes = { LC_ROUGH: 0.5 };
      writePlan();
    },
    [/PSET-4 LC_ROUGH×0\.5 is not in the fixed plan/u, /fixed LC_ROUGH×2 is missing/u],
  ],
  [
    "end_days 60",
    1,
    () => {
      f.plan.end_days = 60;
      writePlan();
    },
    [/end_days 60 \(fixed 90\)/u],
  ],
  [
    "threads 2",
    1,
    () => {
      f.plan.threads = 2;
      writePlan();
    },
    [/threads 2 \(fixed 1\)/u],
  ],
  [
    "input_dir on the untouched harness source",
    1,
    () => {
      f.plan.input_dir = f.h.source;
      writePlan();
    },
    [
      /^input_dir \/\S+\/harness\/SHUD\/input\/ccw \(fixed \/\S+\/scratch\/workspace\/input\/ccw\)$/u,
    ],
  ],
  [
    "project ccx",
    1,
    () => {
      f.plan.project = "ccx";
      f.plan.input_digests = Object.fromEntries(
        Object.entries(f.plan.input_digests).map(([name, sha]) => [
          name.replace("ccw", "ccx"),
          sha,
        ]),
      );
      writePlan();
    },
    [/project ccx \(fixed ccw\)/u],
  ],
  [
    "plan bound to another task",
    1,
    () => {
      f.plan.task_id = OTHER_TASK;
      writePlan();
    },
    [new RegExp(`plan ${PLAN} belongs to ${OTHER_TASK}`, "u")],
  ],
  [
    "failed GEOL_KSATH×2 run",
    2,
    () => {
      f.records[2] = { ...f.records[2], status: "failed", exit_code: 19, exit_class: "cvode" };
      writeRecord(3);
    },
    [
      new RegExp(
        `PSET-3: 0 collected succeeded RunJobs; ${run(3)} job collected record failed`,
        "u",
      ),
    ],
  ],
  [
    "missing collected RunJob despite a model claim of success",
    2,
    () => {
      fs.rmSync(join(f.workspace, "runs", run(2)), { recursive: true });
      emit(f.sessions[0], "assistant/message", {
        message: {
          role: "assistant",
          content: [{ type: "text", text: "All four parameter sets succeeded." }],
        },
      });
      f.publishLogs();
    },
    [/PSET-2: 0 collected succeeded RunJobs; no RunJob/u],
  ],
  [
    "a superseded attempt stays linked",
    2,
    () => {
      f.card.linked_jobs.push(job(9));
      writeCard();
    },
    [new RegExp(`linked_jobs has ${job(9)} outside the batch`, "u")],
  ],
  [
    "the one succeeded run not linked",
    2,
    () => {
      f.card.linked_jobs = f.card.linked_jobs.filter((id) => id !== job(2));
      writeCard();
    },
    [new RegExp(`PSET-2: ${run(2)} \\(${job(2)}\\) is not in linked_jobs`, "u")],
  ],
  [
    "an earlier failed attempt recovered (#718) stays linked",
    2,
    () => {
      const runDir = join(f.workspace, "runs", run(5));
      const attempt = { ...f.jobs[1], job_id: job(5), run_id: run(5), run_dir: runDir };
      const failed = { ...f.records[1], job_id: job(5), run_id: run(5), status: "failed" };
      f.writeJson(`runs/${run(5)}/run-job.json`, attempt);
      f.writeJson(`runs/${run(5)}/run-record.json`, {
        ...failed,
        exit_code: 19,
        exit_class: "cvode",
      });
      f.card.linked_jobs.push(job(5));
      writeCard();
    },
    [new RegExp(`linked_jobs has ${job(5)} outside the batch \\(${run(5)}\\)$`, "u")],
  ],
  [
    "divergent StackLock",
    3,
    () => {
      f.records[1] = { ...f.records[1], stack_id: "STACK-20261110T090000-ffff" };
      writeRecord(2);
    },
    [
      new RegExp(
        `stack_id differs or is null: ${run(1)}=${STACK}, ${run(2)}=STACK-20261110T090000-ffff, ` +
          `${run(3)}=${STACK}, ${run(4)}=${STACK}$`,
        "u",
      ),
    ],
  ],
  [
    "linked job without a RunRecord",
    3,
    () => fs.rmSync(join(f.workspace, "runs", run(2), "run-record.json")),
    [new RegExp(`^${job(2)} has no RunRecord$`, "u")],
  ],
  [
    "null data_id",
    3,
    () => {
      f.records[0] = { ...f.records[0], data_id: null };
      writeRecord(1);
    },
    [new RegExp(`${run(1)} data_id is null`, "u")],
  ],
  [
    "Markdown differs from renderReport",
    8,
    () => fs.appendFileSync(join(f.workspace, `reports/${REPORT}.md`), "\n"),
    [/differs from renderReport/u],
  ],
  [
    "missing coverage statement",
    8,
    () => {
      f.report.limitations = f.report.limitations.slice(1);
      f.publishReport();
    },
    [/lacks "仅在 ccw 单流域、90 天窗口/u],
  ],
  [
    "missing agent-range label",
    8,
    () => {
      f.report.limitations = f.report.limitations.slice(0, 1);
      f.publishReport();
    },
    [/lacks "参数范围为 agent 建议值，未经 PI 确认"/u],
  ],
  [
    "missing invariant sentence",
    8,
    () => {
      const path = join(f.workspace, `reports/${REPORT}.md`);
      fs.writeFileSync(path, fs.readFileSync(path, "utf8").replace("校准结果不等于结构验证", ""));
    },
    [/differs from renderReport/u, /lacks "校准结果不等于结构验证"/u],
  ],
  [
    "report not accepted and card not done",
    8,
    () => {
      f.card.status = "awaiting_pi";
      writeCard();
      f.report.status = "awaiting_pi";
      f.publishReport();
    },
    [/TaskCard status awaiting_pi \(expected done\)/u, /0 accepted linked reports/u],
  ],
  [
    "report analysis_ids name the plan and another",
    8,
    () => {
      f.report.analysis_ids = [PLAN, OTHER_PLAN];
      f.writeJson(`reports/${REPORT}.json`, f.report);
    },
    [new RegExp(`analysis_ids \\[${PLAN}, ${OTHER_PLAN}\\] \\(expected \\[${PLAN}\\]\\)`, "u")],
  ],
  [
    "report analysis_ids name another plan only",
    8,
    () => {
      f.report.analysis_ids = [OTHER_PLAN];
      f.writeJson(`reports/${REPORT}.json`, f.report);
    },
    [new RegExp(`analysis_ids \\[${OTHER_PLAN}\\] \\(expected \\[${PLAN}\\]\\)`, "u")],
  ],
  [
    "analysis_create approval",
    9,
    () => {
      ask(f.sessions[0], "approval-plan", "analysis_create", "call-analysis-create");
      f.publishLogs();
    },
    [new RegExp(`analysis_create/call-analysis-create in ${ROOT_ID}`, "u")],
  ],
  [
    "shud_run approval",
    9,
    () => {
      ask(f.sessions[1], "approval-run", "shud_run", "call-run-1");
      f.publishLogs();
    },
    [new RegExp(`shud_run/call-run-1 in ${WORKER_ID}`, "u")],
  ],
  [
    "second approval in an uncatalogued child session",
    9,
    () => {
      const child = newSession("session-reviewer-670", "reviewer", f.workspace);
      ask(child, "approval-second", "report_submit", "call-second-submit");
      f.sessions.push(child);
      f.publishLogs();
    },
    [/report_submit\/call-second-submit in session-reviewer-670/u],
  ],
  [
    "decision approval_ref differs from the callId",
    9,
    () => {
      f.report.decision_history = [{ ...f.report.decision_history[0], approval_ref: "other-call" }];
      f.publishReport();
    },
    [/approval_ref other-call/u],
  ],
  [
    "the one approval is for shud_run, not report_submit",
    9,
    () => {
      rootEvents((events) => events.filter((event) => !event.type.startsWith("approval/")));
      ask(f.sessions[1], "approval-run", "shud_run", "call-run-1");
      f.publishLogs();
    },
    [
      new RegExp(
        `expected one report_submit approval/asked, found 1: shud_run/call-run-1 in ${WORKER_ID}$`,
        "u",
      ),
    ],
  ],
  [
    "the report_submit approval was never decided",
    9,
    () => rootEvents((events) => events.filter((event) => event.type !== "approval/decided")),
    [/^approval call-report-submit-670 decided \[\] \(expected allowed-once\)$/u],
  ],
  [
    "the report_submit approval was decided twice",
    9,
    () =>
      rootEvents((events) =>
        events.flatMap((event) => (event.type === "approval/decided" ? [event, event] : [event])),
      ),
    [/^approval call-report-submit-670 decided \[allowed-once, allowed-once\] \(expected/u],
  ],
  [
    "the report_submit approval was denied",
    9,
    () =>
      rootEvents((events) =>
        events.map((event) =>
          event.type === "approval/decided"
            ? { ...event, data: { id: "approval-report", outcome: "denied" } }
            : event,
        ),
      ),
    [/^approval call-report-submit-670 decided \[denied\] \(expected allowed-once\)/u],
  ],
  [
    "no worker session header",
    10,
    () => {
      f.sessions[1].header.agentPreset = "reviewer";
      f.publishLogs();
    },
    [/no worker session header/u],
  ],
  [
    "no coordinator session header",
    10,
    () => {
      f.sessions[0].header.agentPreset = "reviewer";
      f.publishLogs();
    },
    [
      /no coordinator session header/u,
      /analysis_create tool\/result not in a coordinator session/u,
    ],
  ],
  [
    "batch shud_run result in the coordinator session",
    10,
    () => {
      toolRoundTrip(f.sessions[0], "shud_run", "call-run-root", {});
      f.publishLogs();
    },
    [new RegExp(`shud_run tool/result in non-worker session ${ROOT_ID}`, "u")],
  ],
  [
    "source md5 change",
    11,
    () => fs.appendFileSync(join(f.h.source, "ccw.cfg.calib"), "x"),
    [/SHUD\/input\/ccw\/ccw\.cfg\.calib: [0-9a-f]{32} -> [0-9a-f]{32}/u],
  ],
  [
    "submodule revision change",
    11,
    () => git(join(f.h.root, "rSHUD"), "commit", "-q", "--allow-empty", "-m", "moved"),
    [/rSHUD [0-9a-f]{40} -> [0-9a-f]{40}/u],
  ],
  [
    "data/raw change",
    11,
    () => {
      fs.mkdirSync(join(f.h.root, "data/raw"), { recursive: true });
      fs.writeFileSync(join(f.h.root, "data/raw/x.txt"), "raw");
    },
    [/data\/raw harness\/x\.txt: absent -> [0-9a-f]{32}/u],
  ],
  [
    "an empty harness data/raw appears",
    11,
    () => fs.mkdirSync(join(f.h.root, "data/raw"), { recursive: true }),
    [/^data\/raw harness root exists false -> true$/u],
  ],
  [
    "an empty workspace data/raw appears",
    11,
    () => fs.mkdirSync(join(f.workspace, "data/raw"), { recursive: true }),
    [/^data\/raw workspace root exists false -> true$/u],
  ],
  [
    "input_digests sha mismatch",
    12,
    () => {
      f.plan.input_digests["ccw.para.lc"] = SHA_A;
      writePlan();
    },
    [new RegExp(`ccw\\.para\\.lc: plan ${SHA_A} prepared [0-9a-f]{64}`, "u")],
  ],
  [
    "end-state input/ccw change",
    12,
    () => fs.appendFileSync(join(f.workspace, "input/ccw/ccw.sp.att"), "x"),
    [/input\/ccw\/ccw\.sp\.att: [0-9a-f]{64} -> [0-9a-f]{64}/u],
  ],
];

test.each(CASES)("%s fails criterion %i", async (_name, criterion, mutate, details) => {
  mutate();
  const before = treeState(dirname(f.h.root));
  const result = await evaluate(f);
  expect(treeState(dirname(f.h.root))).toStrictEqual(before);
  expect(result.code).toBe(1);
  const detail = result.criteria.get(criterion);
  expect(detail, result.stderr).toBeDefined();
  for (const pattern of details) expect(detail).toMatch(pattern);
});

test("an input_digests set the plan schema rejects fails criteria 1 and 12, never as a deviation", async () => {
  const plan = {
    ...f.plan,
    input_digests: { ...f.plan.input_digests, "ccw.sp.att": "b".repeat(64) },
  };
  f.writeJson(`analyses/${PLAN}.json`, plan);
  const result = await evaluate(f);
  expect(result.code).toBe(1);
  expect(result.criteria.get(1)).toMatch(new RegExp(`analyses/${PLAN}\\.json`, "u"));
  expect(result.criteria.get(12)).toMatch(
    new RegExp(`no readable linked plan: analyses/${PLAN}\\.json: `, "u"),
  );
  expect(result.stderr).not.toMatch(/INCONCLUSIVE/u);
});
