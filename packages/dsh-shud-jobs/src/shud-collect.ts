import type { Stats } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import {
  classifyRunExit,
  COLLECT_RETRY_INTERVAL_MS,
  MAX_COLLECT_ATTEMPTS,
  RunJobSchema,
  RunRecordSchema,
  type RunJob,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import { readExit } from "./shud-exit.ts";
import { isProjectComponent } from "./shud-input.ts";
import { writeJson } from "@shud-harness/dsh-shud-records";
import type { IndexEntry } from "./state-indexes.ts";
import {
  CollectFailure,
  collectFailure,
  regularFile,
  validationFailure,
  verifyRunFile,
  isTerminal,
  updateRunJob,
  type RoutedRun,
} from "./shud-run-file.ts";

/** Copied native start accepted by the original submitting instance; never persisted. */
export interface RunStartObservation extends IndexEntry {
  pid: number;
  pid_started_at: string;
  started_at: string;
}

export interface RunTerminalObservation extends RunStartObservation {
  finished_at: string;
}

/** Observation matching does not replace the process-ownership or file-routing guards. */
export function matchesRunStart(observed: RunStartObservation, job: RunJob): boolean {
  return (
    observed.run_id === job.run_id &&
    observed.job_id === job.job_id &&
    observed.run_dir === job.run_dir &&
    observed.pid === job.pid &&
    job.pid_started_at !== null &&
    Date.parse(observed.pid_started_at) === Date.parse(job.pid_started_at) &&
    job.started_at !== null &&
    Date.parse(observed.started_at) === Date.parse(job.started_at)
  );
}

interface CollectLedger {
  attempts: number;
  last_error: string;
  at: string;
}

async function readLedger(runDir: string): Promise<CollectLedger | undefined> {
  const path = join(runDir, "collect-error.json");
  if (!(await regularFile(path, "collect-error ledger", true))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(path, "utf8"));
  } catch (error) {
    throw collectFailure("collect-error ledger", error);
  }
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    Object.keys(value).length !== 3 ||
    !("attempts" in value) ||
    typeof value.attempts !== "number" ||
    !Number.isSafeInteger(value.attempts) ||
    value.attempts < 0 ||
    !("last_error" in value) ||
    typeof value.last_error !== "string" ||
    !value.last_error.trim() ||
    !("at" in value) ||
    typeof value.at !== "string" ||
    !RunJobSchema.shape.finished_at.safeParse(value.at).success
  ) {
    throw new CollectFailure("collect-error ledger", "INVALID_FIELDS");
  }
  return { attempts: value.attempts, last_error: value.last_error, at: value.at };
}

async function existingRecord(entry: IndexEntry): Promise<RunRecord | undefined> {
  const path = join(entry.run_dir, "run-record.json");
  if (!(await regularFile(path, "run-record", true))) return undefined;
  let value: unknown;
  try {
    value = JSON.parse(await io.readFile(path, "utf8"));
  } catch (error) {
    throw collectFailure("run-record JSON", error);
  }
  const parsed = RunRecordSchema.safeParse(value);
  if (!parsed.success) throw validationFailure("RunRecord", parsed.error.issues);
  if (parsed.data.run_id !== entry.run_id || parsed.data.job_id !== entry.job_id) {
    throw new CollectFailure("run-record identity", "MISMATCH");
  }
  return parsed.data;
}

export type CollectCheckpoint =
  | { kind: "committed"; record: RunRecord }
  | {
      kind: "generation";
      ledger: CollectLedger | undefined;
      existingFailure: CollectFailure | undefined;
    };

/** A committed record takes precedence without opening its historical generation ledger. */
export async function readCollectCheckpoint(entry: IndexEntry): Promise<CollectCheckpoint> {
  let existingFailure: CollectFailure | undefined;
  try {
    const record = await existingRecord(entry);
    if (record) return { kind: "committed", record };
  } catch (error) {
    existingFailure = collectFailure("run-record", error);
  }
  return { kind: "generation", ledger: await readLedger(entry.run_dir), existingFailure };
}

function fullJob(routed: RoutedRun): RunJob {
  const parsed = RunJobSchema.safeParse(routed.raw);
  if (!parsed.success) throw validationFailure("RunJob", parsed.error.issues);
  return parsed.data;
}

async function projectCollected(entry: IndexEntry, routed: RoutedRun): Promise<void> {
  try {
    fullJob(routed);
    const path = join(entry.run_dir, "run-job.json");
    await regularFile(path, "collected status projection");
    updateRunJob(
      entry,
      (current) => {
        if (current.status === "collected") return current;
        if (!isTerminal(current.status))
          throw new CollectFailure("collected status projection", "NOT_TERMINAL");
        return { ...current, status: "collected" };
      },
      routed,
    );
  } catch (error) {
    throw collectFailure("collected status projection", error);
  }
}

async function exitCode(job: RunJob): Promise<number | null> {
  try {
    const present = await regularFile(join(job.run_dir, "exit_code"), "exit evidence", true);
    const evidence = present ? await readExit(job.run_dir) : undefined;
    if (evidence?.error) {
      if (evidence.kind === "invalid")
        throw new CollectFailure("exit evidence", "INVALID_INTEGER", true);
      throw collectFailure("exit evidence", evidence.error.cause, true);
    }
    const code = evidence?.code ?? null;
    if (job.exit_code !== null && code !== job.exit_code) {
      throw new CollectFailure("exit evidence", code === null ? "MISSING" : "MISMATCH", true);
    }
    return code;
  } catch (error) {
    throw collectFailure("exit evidence", error, true);
  }
}

async function initialDirectory(path: string): Promise<boolean> {
  let stat: Stats;
  try {
    stat = await io.lstat(path);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw collectFailure("output directory", error);
  }
  if (stat.isSymbolicLink()) throw new CollectFailure("output directory", "SYMLINK");
  if (!stat.isDirectory()) throw new CollectFailure("output directory", "NOT_DIRECTORY");
  return true;
}

async function outputFiles(
  runDir: string,
  project: string,
): Promise<RunRecord["artifacts"]["files"]> {
  const parent = join(runDir, "output");
  const root = join(parent, `${project}.out`);
  if (!(await initialDirectory(parent)) || !(await initialDirectory(root))) return [];
  const files: RunRecord["artifacts"]["files"] = [];
  async function visit(directory: string, relative: string): Promise<void> {
    const names = await io.readdir(directory);
    for (const name of names) {
      const path = join(directory, name);
      const child = relative ? `${relative}/${name}` : name;
      const stat = await io.lstat(path);
      if (stat.isSymbolicLink()) throw new CollectFailure("output scan", "SYMLINK");
      if (stat.isDirectory()) await visit(path, child);
      else if (stat.isFile()) files.push({ path: child, size_bytes: stat.size });
      else throw new CollectFailure("output scan", "NOT_REGULAR");
    }
  }
  try {
    await visit(root, "");
  } catch (error) {
    throw collectFailure("output scan", error);
  }
  files.sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
  return files;
}

async function failedAttempt(
  entry: IndexEntry,
  routed: RoutedRun,
  ledger: CollectLedger | undefined,
  job: RunJob | undefined,
  failure: CollectFailure,
): Promise<never> {
  const failures: CollectFailure[] = [failure];
  try {
    const attempts = (ledger?.attempts ?? 0) + 1;
    if (!Number.isSafeInteger(attempts))
      throw new CollectFailure("collect-error write", "ATTEMPT_OVERFLOW");
    verifyRunFile(entry, routed);
    const path = join(entry.run_dir, "collect-error.json");
    await regularFile(path, "collect-error write", true);
    await writeJson(path, { attempts, last_error: failure.message, at: new Date().toISOString() });
  } catch (error) {
    failures.push(collectFailure("collect-error write", error));
  }
  if (failure.exitEvidence && job && job.status !== "failed") {
    try {
      const path = join(entry.run_dir, "run-job.json");
      await regularFile(path, "failure status projection");
      updateRunJob(
        entry,
        (current) => {
          if (current.status === "collected" || current.status === "failed") return current;
          if (!isTerminal(current.status))
            throw new CollectFailure("failure status projection", "NOT_TERMINAL");
          return { ...current, status: "failed" };
        },
        routed,
      );
    } catch (error) {
      failures.push(collectFailure("failure status projection", error));
    }
  }
  if (failures.length > 1) {
    throw new AggregateError(
      failures,
      `SHUD collect persistence failed: ${failures.map((item) => item.message).join("; ")}`,
      { cause: failure },
    );
  }
  throw failure;
}

export function collectRun(
  entry: IndexEntry,
  routed: RoutedRun,
  automatic: false,
  observation: RunTerminalObservation | undefined,
  checkpoint?: CollectCheckpoint,
): Promise<RunRecord>;
export function collectRun(
  entry: IndexEntry,
  routed: RoutedRun,
  automatic: boolean,
  observation: RunTerminalObservation | undefined,
  checkpoint?: CollectCheckpoint,
): Promise<RunRecord | undefined>;
/** Caller owns per-entry exclusion. This is the only generation, retry, and existing-result backend. */
export async function collectRun(
  entry: IndexEntry,
  routed: RoutedRun,
  automatic: boolean,
  observation: RunTerminalObservation | undefined,
  preparedCheckpoint?: CollectCheckpoint,
): Promise<RunRecord | undefined> {
  const checkpoint = preparedCheckpoint ?? (await readCollectCheckpoint(entry));
  if (checkpoint.kind === "committed") {
    // A valid immutable file is already committed; projection failure is not another generation attempt.
    await projectCollected(entry, routed);
    return checkpoint.record;
  }
  const { ledger, existingFailure } = checkpoint;
  if (
    automatic &&
    ledger &&
    (ledger.attempts >= MAX_COLLECT_ATTEMPTS ||
      (ledger.attempts > 0 && Date.now() - Date.parse(ledger.at) < COLLECT_RETRY_INTERVAL_MS))
  )
    return undefined;

  let job: RunJob | undefined;
  let result: RunRecord;
  try {
    if (existingFailure) throw existingFailure;
    job = fullJob(routed);
    if (!isProjectComponent(job.project)) throw new CollectFailure("project", "INVALID_COMPONENT");
    const code = await exitCode(job);
    const missing =
      job.status === "cancelled" || job.cancel_requested_at !== null ? "cancelled" : "lost";
    const exitClass = classifyRunExit(code, missing);
    const files = await outputFiles(job.run_dir, job.project);
    const candidate = RunRecordSchema.safeParse({
      run_id: job.run_id,
      job_id: job.job_id,
      task_id: job.task_id,
      stack_id: job.stack_id,
      data_id: job.data_id,
      status: exitClass === "ok" ? "succeeded" : "failed",
      command: job.command,
      exit_code: code,
      exit_class: exitClass,
      artifacts: {
        stdout: join(job.run_dir, "stdout.log"),
        stderr: join(job.run_dir, "stderr.log"),
        shud_output: join(job.run_dir, "output", `${job.project}.out`),
        files,
      },
      numerical_health: {
        water_balance_residual: null,
        cvode_failures: null,
        negative_state_count: null,
        max_solver_dt: null,
      },
      resources: {
        wall_seconds:
          job.started_at !== null && job.finished_at !== null
            ? (Date.parse(job.finished_at) - Date.parse(job.started_at)) / 1000
            : null,
        peak_memory_mb: null,
      },
      llm: {
        response_model: job.llm.response_model,
        response_model_source: job.llm.response_model_source,
      },
      collected_at: new Date().toISOString(),
    });
    if (!candidate.success) throw validationFailure("RunRecord", candidate.error.issues);
    result = candidate.data;
    // Validate the known interval first: missing observations must not hide a negative duration.
    if (
      !observation ||
      !matchesRunStart(observation, job) ||
      job.finished_at === null ||
      Date.parse(observation.finished_at) !== Date.parse(job.finished_at)
    )
      result.resources.wall_seconds = null;
    verifyRunFile(entry, routed);
    const path = join(entry.run_dir, "run-record.json");
    if (await regularFile(path, "run-record publication", true))
      throw new CollectFailure("run-record publication", "ALREADY_EXISTS");
    try {
      await writeJson(path, result);
    } catch (error) {
      throw collectFailure("run-record publication", error);
    }
  } catch (error) {
    return failedAttempt(entry, routed, ledger, job, collectFailure("generation", error));
  }
  // Never roll back or rewrite the committed file if this second atomic write fails.
  await projectCollected(entry, routed);
  return result;
}
