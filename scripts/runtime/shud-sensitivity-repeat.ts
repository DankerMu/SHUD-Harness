import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import {
  groupCanPerformIo,
  processStart,
} from "../../packages/dsh-shud-jobs/src/process-identity.ts";
import {
  recoverProcessGroup,
  type ShudProcessGroup,
} from "../../packages/dsh-shud-jobs/src/process-group.ts";
import type { RunId } from "../../packages/dsh-shud-core/src/schemas/run-identifiers.ts";
import { requireFact } from "./shud-restart-evidence.ts";
import type { SensitivityRepeatRecord } from "./shud-sensitivity-evaluate.ts";
import { FIXED_PLAN } from "./shud-sensitivity-plan.ts";
import { ccwSha256 } from "./shud-sensitivity-prepare.ts";
import { stopGroup } from "./shud-web-driver.ts";

/** Bound on the single batch-external solver run (design "Issue #671 ... contract"). */
const REPEAT_MS = 20 * 60_000;
const PROJECT = FIXED_PLAN.project;
const COPY = `input/${PROJECT}`;
const RIVQDOWN = `output/${PROJECT}.out/${PROJECT}.rivqdown.dat`;

export interface RepeatBaseline {
  run_id: RunId;
  /** `<workspace>/runs/<run_id>` of the in-batch baseline run. */
  dir: string;
}

export interface RepeatInput {
  /** Script-owned home; writes only `<home>/sensitivity/repeat/` and `<home>/sensitivity/repeat.json`. */
  home: string;
  shudBin: string;
  /** The in-batch baseline, or the reason there is none (then no solver starts). */
  baseline: RepeatBaseline | string;
  /** The plan's `threads`, set as both thread variables. */
  threads: number;
  timeoutMs?: number;
  abort?: AbortSignal;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** sha256 of a regular file opened without following a final symlink; null when absent. */
function fileSha256(path: string): string | null {
  let fd: number;
  try {
    fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
  try {
    requireFact(fs.fstatSync(fd).isFile(), `Not a regular file: ${path}`);
    return createHash("sha256").update(fs.readFileSync(fd)).digest("hex");
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Spawn the solver as its own group leader. The group identity is taken before any await, while
 * the child is unreaped; a leader that already exited may not leave a live group behind.
 */
function launch(
  input: RepeatInput,
  cwd: string,
  env: NodeJS.ProcessEnv,
): { child: ChildProcess; exited: Promise<void>; group?: ShudProcessGroup } {
  const stdout = fs.openSync(join(cwd, "stdout.log"), "wx", 0o600);
  let stderr: number | undefined;
  let child: ChildProcess;
  try {
    stderr = fs.openSync(join(cwd, "stderr.log"), "wx", 0o600);
    child = spawn(input.shudBin, ["-o", `output/${PROJECT}.out`, PROJECT], {
      cwd,
      detached: true,
      stdio: ["ignore", stdout, stderr],
      env,
    });
  } finally {
    fs.closeSync(stdout);
    if (stderr !== undefined) fs.closeSync(stderr);
  }
  const exited = new Promise<void>((resolve, reject) => {
    child.once("exit", () => resolve());
    child.once("error", (error) => {
      if (child.pid === undefined) reject(error);
    });
  });
  const pid = child.pid;
  if (pid === undefined) return { child, exited };
  const stamp = processStart(pid);
  requireFact(stamp, `Repeat solver ${pid} start identity unavailable`);
  try {
    const group = recoverProcessGroup({
      pid,
      pid_started_at: new Date(`${stamp} UTC`).toISOString(),
    });
    return { child, exited, group };
  } catch (error) {
    requireFact(
      !groupCanPerformIo(pid),
      `Repeat solver ${pid} exited with live group members; ownership unproved: ${message(error)}`,
    );
    return { child, exited };
  }
}

async function execute(
  input: RepeatInput,
  baseline: RepeatBaseline,
): Promise<SensitivityRepeatRecord> {
  const directory = join(input.home, "sensitivity/repeat");
  const copy = join(directory, COPY);
  const source = join(baseline.dir, COPY);
  const expected = ccwSha256(source);
  fs.mkdirSync(directory, { mode: 0o700 });
  fs.cpSync(source, copy, { recursive: true, errorOnExist: true, force: false });
  requireFact(
    JSON.stringify(ccwSha256(copy)) === JSON.stringify(expected),
    `Repeat input copy differs from ${source}`,
  );
  fs.mkdirSync(join(directory, "output"));
  const threads = String(input.threads);
  const env = { ...process.env, OMP_NUM_THREADS: threads, SHUD_RHS_THREADS: threads };
  const { child, exited, group } = launch(input, directory, env);
  const bound = AbortSignal.any([
    AbortSignal.timeout(input.timeoutMs ?? REPEAT_MS),
    ...(input.abort ? [input.abort] : []),
  ]);
  const stopped = new Promise<"bound">((resolve) => {
    if (bound.aborted) resolve("bound");
    bound.addEventListener("abort", () => resolve("bound"), { once: true });
  });
  const outcome = await Promise.race([exited.then(() => "exited" as const), stopped]);
  if (outcome === "bound") {
    requireFact(group, "Repeat solver bound reached without an owned group to stop");
    await stopGroup(group);
    await Promise.race([exited, delay(5_000)]);
  }
  if (group?.isGroupActive()) await stopGroup(group);
  return {
    status: "executed",
    exit_code: outcome === "exited" ? child.exitCode : null,
    input_sha256: ccwSha256(copy),
    omp_num_threads: threads,
    shud_rhs_threads: threads,
    rivqdown_sha256: fileSha256(join(directory, RIVQDOWN)),
    run_id: `repeat-${baseline.run_id}`,
    baseline_run_id: baseline.run_id,
  };
}

/**
 * The batch-external baseline repeat: a byte-identical copy of the in-batch baseline input in a
 * script-owned directory, run directly with the same solver. It creates no RunJob, RunRecord,
 * registry entry, card link or session event. Always writes exactly one record (`wx`).
 */
export async function runSensitivityRepeat(input: RepeatInput): Promise<SensitivityRepeatRecord> {
  let record: SensitivityRepeatRecord;
  if (typeof input.baseline === "string")
    record = { status: "not_executed", reason: input.baseline };
  else
    try {
      record = await execute(input, input.baseline);
    } catch (error) {
      record = { status: "not_executed", reason: `repeat run failed: ${message(error)}` };
    }
  fs.writeFileSync(join(input.home, "sensitivity/repeat.json"), `${JSON.stringify(record)}\n`, {
    flag: "wx",
    mode: 0o600,
  });
  return record;
}
