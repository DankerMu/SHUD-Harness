import * as fs from "node:fs";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import type { RunJob } from "../../packages/dsh-shud-core/src/schemas/run-job.ts";
import type { ShudProcessGroup } from "../../packages/dsh-shud-jobs/src/process-group.ts";
import { calls, data, resultFor } from "./shud-evidence-events.ts";
import { collectReplayLogs, discoverOwnedSessions } from "./shud-replay-snapshot.ts";
import { replayReady } from "./shud-replay-flow.ts";
import { object, requireFact, text } from "./shud-restart-evidence.ts";
import type { SessionLog } from "./shud-session-log.ts";
import { FIXED_PLAN } from "./shud-sensitivity-plan.ts";
import { prepareSensitivityWorkspace } from "./shud-sensitivity-prepare.ts";
import { runSensitivityRepeat, type RepeatBaseline } from "./shud-sensitivity-repeat.ts";
import {
  WebHost,
  canonicalLog,
  cleanupOwnedRuns,
  command,
  ownRunGroup,
  readPrivateJobs,
  screen,
  type NativeRunPolicy,
} from "./shud-web-driver.ts";

const ROOT = fs.realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
const SENSITIVITY_COMPLETE_MS = 45 * 60_000;
const MAX_RUNS = 8;
const PROJECT = FIXED_PLAN.project;
/** Host statuses that end a RunJob's host job; a failed pset still settles the batch. */
const HOST_TERMINAL = ["completed", "failed", "killed"] as const;
const RUN_JOB_TERMINAL = new Set<RunJob["status"]>([
  "succeeded",
  "failed",
  "cancelled",
  "collected",
]);
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
const ENGINEERING_EVIDENCE =
  "the automatic Allow once for report_submit is engineering evidence, not PI acceptance";

export interface SensitivityConfig {
  /** Requested scratch workspace; preparation records its physical path. */
  workspace: string;
  /** Physical executable solver, the same string in the host env, cleanup policy and repeat. */
  shudBin: string;
  dshBin: string;
}

/** Mutable state the stages share; every handle is set by the stage that created it. */
export interface SensitivityRun {
  config: SensitivityConfig;
  home: string;
  env: NodeJS.ProcessEnv;
  abort: AbortSignal;
  preparationRecord: string;
  repeatRecord: string;
  /** Physical workspace recorded by preparation. */
  workspace?: string;
  rootId?: string;
  host?: { readonly exited: boolean; stop(): Promise<void> };
  approvals?: { close(): Promise<void> };
  owners: Set<string>;
  groups: Map<number, ShudProcessGroup>;
}

export interface SensitivityStages {
  prepare(run: SensitivityRun): Promise<void>;
  install(run: SensitivityRun): Promise<void>;
  drive(run: SensitivityRun): Promise<void>;
  /** Returns every stop/cleanup error; any error withholds the solver repeat. */
  stop(run: SensitivityRun): Promise<string[]>;
  /** `reason` set: record `not_executed` with it and start no solver. */
  repeat(run: SensitivityRun, reason: string | undefined): Promise<void>;
  evaluate(run: SensitivityRun): Promise<number>;
  summary(run: SensitivityRun): Promise<void>;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
function say(line: string): void {
  let shown = line;
  try {
    screen(shown);
  } catch {
    shown = "detail suppressed by secret screen";
  }
  process.stderr.write(`shud:sensitivity: ${shown}\n`);
}
function physical(run: SensitivityRun): string {
  requireFact(run.workspace, "Workspace not prepared");
  return run.workspace;
}
function runPolicy(shudBin: string): NativeRunPolicy {
  return {
    minRuns: 0,
    maxRuns: MAX_RUNS,
    expectedArgv: () => [shudBin, "-o", `output/${PROJECT}.out`, PROJECT],
  };
}

/** The single coordinator prompt: the input path once and the fixed plan, nothing else. */
export function sensitivityPrompt(workspace: string): string {
  const input = fs.realpathSync.native(join(workspace, `input/${PROJECT}`));
  const [baseline, ...perturbed] = FIXED_PLAN.parameter_sets;
  return [
    `Run one OAT sensitivity task for the ${PROJECT} basin with input_dir ${JSON.stringify(input)}.`,
    `Use exactly this analysis plan: project: ${PROJECT}, end_days: ${FIXED_PLAN.end_days}, threads: ${FIXED_PLAN.threads}; parameter sets in this order: ${baseline} (no change), ${perturbed.join(", ")}, each a multiplier on the named calib key.`,
  ].join("\n");
}

function reportSubmitted(root: SessionLog): boolean {
  return calls(root, "report_submit").some((call) => {
    try {
      resultFor(root, call, "REPORT_SUBMIT");
      return true;
    } catch {
      return false;
    }
  });
}

export type BatchProgress =
  { state: "running" } | { state: "done" } | { state: "stopped"; reason: string };

/**
 * One wait decision on the root and every catalogued child (re-delegation included): done once
 * all sessions settled, report_submit succeeded and every RunJob and owned host job is terminal.
 * RunJobs that never started a host job count by their own status.
 */
export async function batchProgress(
  logs: { root: SessionLog; children: SessionLog[] },
  jobs: readonly RunJob[],
  host: {
    jobsTerminal(
      sessionIds: string[],
      currentJobIds: string[],
      accepted: readonly string[],
    ): Promise<{ terminal: boolean }>;
  },
): Promise<BatchProgress> {
  for (const log of [logs.root, ...logs.children])
    for (const event of log.events)
      if (event.type === "approval/asked" && data(event).toolName !== "report_submit")
        return {
          state: "stopped",
          reason: `Unexpected approval ${text(data(event).toolName)} ${text(data(event).callId)}`,
        };
  if (!replayReady(logs)) return { state: "running" };
  if (!reportSubmitted(logs.root))
    return { state: "stopped", reason: "Coordinator settled without a successful report_submit" };
  if (jobs.some((job) => !RUN_JOB_TERMINAL.has(job.status))) return { state: "running" };
  const sessions = [logs.root, ...logs.children].map((log) => text(log.header.id));
  const hostJobs = jobs.flatMap((job) => (job.dsh_job_id === null ? [] : [job.dsh_job_id]));
  const { terminal } = await host.jobsTerminal(sessions, hostJobs, HOST_TERMINAL);
  return terminal ? { state: "done" } : { state: "running" };
}

/** The report-only predicate (only `report_submit` is answered) on its own named stream. */
export async function openSensitivityApprovals(host: WebHost, rootId: string, workspace: string) {
  // Bootstrap boundary: the report predicate loads built records, which exist only after the
  // install stage's build (as shud-first-task.ts does).
  const { openReportApprovals } = await import("./shud-first-task-approval.ts");
  return openReportApprovals(host, rootId, workspace, {
    label: "Sensitivity",
    streamId: "sensitivity-approvals",
  });
}

async function drive(run: SensitivityRun): Promise<void> {
  const workspace = physical(run);
  const host = new WebHost(run.config.dshBin, workspace, run.env, run.abort, {
    interactions: "answer",
  });
  run.host = host;
  await host.ready(join(run.home, "profiles/shud/shud-jobs"));
  const rootId = text(
    object(await host.rpc("session/create", { cwd: workspace, agentPreset: "coordinator" }))
      .sessionId,
  );
  run.rootId = rootId;
  const approvals = await openSensitivityApprovals(host, rootId, workspace);
  run.approvals = approvals;
  const accepted = object(
    await host.rpc("session/prompt", {
      requestId: randomUUID(),
      sessionId: rootId,
      mode: "queue",
      content: [{ type: "text", text: sensitivityPrompt(workspace) }],
    }),
  );
  requireFact(accepted.accepted === true, "Sensitivity prompt not accepted");
  const policy = runPolicy(run.config.shudBin);
  const deadline = Date.now() + SENSITIVITY_COMPLETE_MS;
  while (Date.now() < deadline) {
    run.abort.throwIfAborted();
    approvals.healthy();
    const logs = await collectReplayLogs(run.home, rootId, host);
    for (const child of logs.children)
      if (
        child.header.agentPreset === "worker" &&
        child.header.parentSession === rootId &&
        child.header.origin === "subagent"
      )
        run.owners.add(text(child.header.id));
    const jobs = readPrivateJobs(workspace, MAX_RUNS);
    for (const job of jobs)
      if (job.pid && job.pid_started_at && job.owner_session && run.owners.has(job.owner_session))
        ownRunGroup(job, policy, run.owners, run.groups);
    const progress = await batchProgress(logs, jobs, approvals);
    if (progress.state === "done") return;
    if (progress.state === "stopped") throw new Error(progress.reason);
    await delay(500, undefined, { signal: run.abort });
  }
  throw new Error("Sensitivity batch deadline; evidence retained");
}

async function stop(run: SensitivityRun): Promise<string[]> {
  const errors: string[] = [];
  if (run.approvals)
    try {
      await run.approvals.close();
    } catch (error) {
      errors.push(`Approval stream close failed: ${message(error)}`);
    }
  if (run.host)
    try {
      await run.host.stop();
    } catch (error) {
      errors.push(`Web host shutdown unproved: ${message(error)}`);
    }
  const stopped = !run.host || run.host.exited;
  if (run.rootId && stopped)
    try {
      for (const child of discoverOwnedSessions(run.home, run.rootId))
        if (child.header.agentPreset === "worker") run.owners.add(text(child.header.id));
    } catch (error) {
      errors.push(`Stopped-host session discovery failed: ${message(error)}`);
    }
  if (run.workspace)
    errors.push(
      ...(await cleanupOwnedRuns(
        run.workspace,
        runPolicy(run.config.shudBin),
        run.owners,
        run.groups,
        stopped,
      )),
    );
  return errors;
}

async function repeat(run: SensitivityRun, reason: string | undefined): Promise<void> {
  let baseline: RepeatBaseline | string;
  let threads: number = FIXED_PLAN.threads;
  if (reason !== undefined) baseline = reason;
  else
    try {
      const workspace = physical(run);
      // Bootstrap boundary: the criteria modules load built records.
      const { bound, loadSensitivityBatch } =
        await import("./shud-sensitivity-criteria-workspace.ts");
      const { inBatchBaseline } = await import("./shud-sensitivity-criteria-numeric.ts");
      const batch = loadSensitivityBatch(workspace);
      threads = bound(batch).plan.threads;
      baseline = inBatchBaseline(workspace, batch);
    } catch (error) {
      baseline = message(error);
    }
  await runSensitivityRepeat({
    home: run.home,
    shudBin: run.config.shudBin,
    baseline,
    threads,
    abort: run.abort,
  });
}

const DEFAULT_STAGES: SensitivityStages = {
  async prepare(run) {
    const record = await prepareSensitivityWorkspace({
      workspace: run.config.workspace,
      recordPath: run.preparationRecord,
      env: run.env,
    });
    run.workspace = record.workspace;
  },
  async install(run) {
    await command("pnpm", ["run", "build"], ROOT, run.env, run.abort);
    const installer = join(ROOT, "scripts/runtime/profile-install.sh");
    await command("sh", [installer], physical(run), run.env, run.abort);
  },
  drive,
  stop,
  repeat,
  async evaluate(run) {
    requireFact(run.rootId, "No session to evaluate");
    // Bootstrap boundary: the evaluator loads built records.
    const { runSensitivityEvaluateCli } = await import("./shud-sensitivity-evaluate.ts");
    return runSensitivityEvaluateCli([
      physical(run),
      canonicalLog(run.home, run.rootId),
      run.preparationRecord,
      run.repeatRecord,
    ]);
  },
  async summary(run) {
    const { sensitivitySummary } = await import("./shud-sensitivity-summary.ts");
    process.stdout.write(sensitivitySummary(physical(run), run.repeatRecord));
  },
};

function retain(run: SensitivityRun, errors: readonly string[]): void {
  say(`retained workspace ${run.workspace ?? run.config.workspace}`);
  say(`retained home ${run.home}`);
  let log = "unavailable (no canonical session)";
  if (run.rootId)
    try {
      log = canonicalLog(run.home, run.rootId);
    } catch (error) {
      log = `unavailable: ${message(error)}`;
    }
  say(`retained session log ${log}`);
  say(`retained preparation record ${run.preparationRecord}`);
  say(`retained repeat record ${run.repeatRecord}`);
  for (const error of errors) say(`stop/cleanup error: ${error}`);
}

/**
 * prepare → install → drive (bounded wait) → stop (host exit confirmed) → batch-external repeat
 * → evaluate → summary. Exit is the evaluator's; prepare/install failure or no session is 1.
 */
export async function runSensitivity(
  config: SensitivityConfig,
  overrides: Partial<SensitivityStages> = {},
  abort: AbortSignal = new AbortController().signal,
): Promise<number> {
  const stages = { ...DEFAULT_STAGES, ...overrides };
  const home = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), "shud-sensitivity-")));
  screen(home);
  fs.chmodSync(home, 0o700);
  fs.mkdirSync(join(home, "sensitivity"), { mode: 0o700 });
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    DSH_HOME: home,
    PROFILE_NAME: "shud",
    PROFILE_TEMPLATE: "web",
    SHUD_BIN: config.shudBin,
  };
  delete env.ALL_PROXY;
  const run: SensitivityRun = {
    config,
    home,
    env,
    abort,
    preparationRecord: join(home, "sensitivity/preparation.json"),
    repeatRecord: join(home, "sensitivity/repeat.json"),
    owners: new Set(),
    groups: new Map(),
  };
  say(`retained workspace ${config.workspace}`);
  say(`retained home ${home}`);
  try {
    await stages.prepare(run);
    await stages.install(run);
  } catch (error) {
    say(message(error));
    retain(run, []);
    return 1;
  }
  try {
    await stages.drive(run);
  } catch (error) {
    say(`session: ${message(abort.aborted ? abort.reason : error)}`);
  }
  let errors: string[];
  try {
    errors = await stages.stop(run);
  } catch (error) {
    errors = [`stop failed: ${message(error)}`];
  }
  if (!run.rootId) {
    say("no session was created; the evaluator was not run");
    retain(run, errors);
    return 1;
  }
  const withheld = errors.length
    ? errors.join("; ")
    : abort.aborted
      ? "interrupted before the repeat run"
      : undefined;
  try {
    await stages.repeat(run, withheld);
  } catch (error) {
    say(`repeat: ${message(error)}`);
  }
  let code = 1;
  if (fs.existsSync(run.repeatRecord))
    try {
      code = await stages.evaluate(run);
    } catch (error) {
      say(`evaluate: ${message(error)}`);
    }
  else say("repeat record missing; the evaluator was not run");
  if (code === 0)
    try {
      await stages.summary(run);
    } catch (error) {
      say(`summary: ${message(error)}`);
      code = 1;
    }
  if (code !== 0) retain(run, errors);
  process.stdout.write(`shud:sensitivity: ${ENGINEERING_EVIDENCE}\n`);
  return code;
}

/** Side-effect free; the shell wrapper and preparation check the remaining prerequisites. */
function preflight(argv: string[]): SensitivityConfig {
  requireFact(
    argv.length === 1 && argv[0]?.trim(),
    "usage: shud-sensitivity.sh <scratch-workspace>; explicit workspace required",
  );
  // The shell wrapper proved a regular executable; preparation re-checks it before any write.
  const shud = process.env.SHUD_BIN;
  requireFact(shud && isAbsolute(shud), "Missing explicit absolute SHUD_BIN");
  const shudBin = fs.realpathSync(shud);
  const dshBin = process.env.DSH_BIN;
  requireFact(
    dshBin && isAbsolute(dshBin) && fs.existsSync(dshBin),
    "Missing pinned DSH_BIN; use shud-sensitivity.sh",
  );
  return { workspace: resolve(argv[0]), shudBin, dshBin };
}

/** `<scratch-workspace>`; SIGINT/SIGTERM/SIGHUP abort the wait and still run stop. */
export async function runSensitivityCli(
  argv: string[],
  overrides: Partial<SensitivityStages> = {},
): Promise<number> {
  let config: SensitivityConfig;
  try {
    config = preflight(argv);
  } catch (error) {
    say(`${message(error)}; no session started`);
    return 1;
  }
  const abort = new AbortController();
  const interrupted = () => abort.abort(new Error("Sensitivity gate interrupted"));
  for (const signal of SIGNALS) process.on(signal, interrupted);
  try {
    return await runSensitivity(config, overrides, abort.signal);
  } finally {
    for (const signal of SIGNALS) process.off(signal, interrupted);
  }
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  process.exitCode = await runSensitivityCli(process.argv.slice(2));
}
