import type { Stats } from "node:fs";
import { lstatSync, readFileSync } from "node:fs";
import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { realDirectory, verifyRun } from "./shud-input.ts";
import type { IndexEntry } from "./state-indexes.ts";
import { writeJsonSync } from "./state-files.ts";

/** Messages crossing the collection persistence/log boundary contain controlled facts, never raw causes. */
export class CollectFailure extends Error {
  readonly exitEvidence: boolean;
  readonly stage: string;
  readonly code: string;

  constructor(stage: string, code: string, exitEvidence = false) {
    super(`SHUD collect ${stage}: ${code}`);
    this.name = "CollectFailure";
    this.stage = stage;
    this.code = code;
    this.exitEvidence = exitEvidence;
  }
}

const filesystemCodes = new Set([
  "EACCES",
  "EPERM",
  "EIO",
  "ENOENT",
  "ENOTDIR",
  "EISDIR",
  "ELOOP",
  "ENOSPC",
  "EROFS",
  "EMFILE",
  "ENFILE",
  "EEXIST",
  "EINVAL",
  "ENAMETOOLONG",
  "EBADF",
  "EXDEV",
  "EBUSY",
]);

interface CollectDiagnosticRule {
  filesystem?: true;
  codes?: readonly string[];
  validation?: true;
}

// Historical ledgers carry strings, not trusted CollectFailure instances. Keep the collector's
// stage/code grammar here beside safeCode; filesystem errno vocabulary has only one owner.
const collectDiagnosticRules: Record<string, CollectDiagnosticRule> = {
  "collect-error ledger": { filesystem: true, codes: ["SYMLINK", "NOT_REGULAR", "INVALID_FIELDS"] },
  "run-record": { filesystem: true, codes: ["SYMLINK", "NOT_REGULAR"] },
  "run-record JSON": { filesystem: true },
  "run-record identity": { codes: ["MISMATCH"] },
  RunJob: { validation: true },
  RunRecord: { validation: true },
  "collected status projection": {
    filesystem: true,
    codes: ["SYMLINK", "NOT_REGULAR", "NOT_TERMINAL"],
  },
  "exit evidence": {
    filesystem: true,
    codes: ["SYMLINK", "NOT_REGULAR", "INVALID_INTEGER", "MISSING", "MISMATCH"],
  },
  "output directory": { filesystem: true, codes: ["SYMLINK", "NOT_DIRECTORY"] },
  "output scan": { filesystem: true, codes: ["SYMLINK", "NOT_REGULAR"] },
  "collect-error write": {
    filesystem: true,
    codes: ["SYMLINK", "NOT_REGULAR", "ATTEMPT_OVERFLOW"],
  },
  "failure status projection": {
    filesystem: true,
    codes: ["SYMLINK", "NOT_REGULAR", "NOT_TERMINAL"],
  },
  project: { codes: ["INVALID_COMPONENT"] },
  "run-record publication": {
    filesystem: true,
    codes: ["SYMLINK", "NOT_REGULAR", "ALREADY_EXISTS"],
  },
  generation: { filesystem: true },
  "run path": { filesystem: true },
  "run metadata": { filesystem: true, codes: ["SYMLINK", "NOT_REGULAR"] },
  "run metadata JSON": { filesystem: true },
  "run identity/path": { codes: ["MISMATCH"] },
  "run status": { codes: ["INVALID_STATUS"] },
  "run-job publication": { filesystem: true },
};

function safeCode(error: unknown): string {
  if (error instanceof CollectFailure) return error.code;
  if (error instanceof AggregateError)
    return error.errors.map((item: unknown) => safeCode(item)).join("+") || "IO_ERROR";
  if (
    error instanceof Error &&
    "code" in error &&
    typeof error.code === "string" &&
    filesystemCodes.has(error.code)
  )
    return error.code;
  if (error instanceof SyntaxError) return "INVALID_JSON";
  return "IO_ERROR";
}

export function collectFailure(
  stage: string,
  error: unknown,
  exitEvidence = false,
): CollectFailure {
  if (error instanceof CollectFailure && (!exitEvidence || error.exitEvidence)) return error;
  return new CollectFailure(stage, safeCode(error), exitEvidence);
}

/** Issue paths come from the fixed core schemas, not from exception messages or unknown input keys. */
export function validationFailure(
  stage: string,
  issues: readonly { path: readonly PropertyKey[] }[],
): CollectFailure {
  const path =
    issues[0]?.path
      .filter((part) => typeof part === "string" || typeof part === "number")
      .join(".") || "record";
  return new CollectFailure(stage, `VALIDATION ${path}`);
}

/** Reconstruct a controlled historical reason; never forward an arbitrary ledger string or path. */
export function normalizeCollectFailureReason(message: string): string {
  const prefix = "SHUD collect ";
  const separator = message.indexOf(": ", prefix.length);
  const stage = message.slice(prefix.length, separator);
  if (
    !message.startsWith(prefix) ||
    separator < prefix.length ||
    !Object.hasOwn(collectDiagnosticRules, stage)
  )
    throw new CollectFailure("collect-error diagnostic", "UNRECOGNIZED");
  const rule = collectDiagnosticRules[stage];
  const code = message.slice(separator + 2);
  if (rule.validation) {
    if (!/^VALIDATION(?: [A-Za-z0-9_.]+)?$/u.test(code))
      throw new CollectFailure("collect-error diagnostic", "UNRECOGNIZED");
    // Schema paths may evolve; only the known stage and fixed validation label cross this boundary.
    return `${prefix}${stage}: VALIDATION`;
  }
  const codes = code.split("+");
  for (const part of codes) {
    if (
      !rule.codes?.includes(part) &&
      !(
        rule.filesystem &&
        (filesystemCodes.has(part) || part === "INVALID_JSON" || part === "IO_ERROR")
      )
    )
      throw new CollectFailure("collect-error diagnostic", "UNRECOGNIZED");
  }
  return `${prefix}${stage}: ${codes.join("+")}`;
}

export async function regularFile(
  path: string,
  stage: string,
  optional = false,
): Promise<Stats | undefined> {
  let stat: Stats;
  try {
    stat = await io.lstat(path);
  } catch (error) {
    if (optional && error instanceof Error && "code" in error && error.code === "ENOENT")
      return undefined;
    throw collectFailure(stage, error);
  }
  if (stat.isSymbolicLink()) throw new CollectFailure(stage, "SYMLINK");
  if (!stat.isFile()) throw new CollectFailure(stage, "NOT_REGULAR");
  return stat;
}

export interface RoutedRun {
  raw: Record<string, unknown>;
  status: RunJob["status"];
  parent: Stats;
  directory: Stats;
}

export function verifyRunFile(
  entry: IndexEntry,
  routed: Pick<RoutedRun, "parent" | "directory">,
): void {
  try {
    verifyRun(dirname(entry.run_dir), routed.parent, entry.run_dir, routed.directory);
  } catch (error) {
    throw collectFailure("run path", error);
  }
}

/** Route terminal payloads before validating their full schema inside the collection attempt. */
export async function readRunFile(entry: IndexEntry): Promise<RoutedRun> {
  let parent: Stats;
  let directory: Stats;
  try {
    parent = realDirectory(dirname(entry.run_dir));
    directory = realDirectory(entry.run_dir);
  } catch (error) {
    throw collectFailure("run path", error);
  }
  const path = join(entry.run_dir, "run-job.json");
  await regularFile(path, "run metadata");
  let raw: unknown;
  try {
    raw = JSON.parse(await io.readFile(path, "utf8"));
  } catch (error) {
    throw collectFailure("run metadata JSON", error);
  }
  return routeRun(entry, raw, parent, directory);
}

function routeRun(entry: IndexEntry, raw: unknown, parent: Stats, directory: Stats): RoutedRun {
  if (
    typeof raw !== "object" ||
    raw === null ||
    Array.isArray(raw) ||
    !("run_id" in raw) ||
    raw.run_id !== entry.run_id ||
    !("job_id" in raw) ||
    raw.job_id !== entry.job_id ||
    !("run_dir" in raw) ||
    raw.run_dir !== entry.run_dir
  ) {
    throw new CollectFailure("run identity/path", "MISMATCH");
  }
  const value = raw as Record<string, unknown>;
  const status = RunJobSchema.shape.status.safeParse(value.status);
  if (!status.success) throw new CollectFailure("run status", "INVALID_STATUS");
  return { raw: value, status: status.data, parent, directory };
}

/** No yield between the fresh validated read, transition and atomic publication. */
export function updateRunJob(
  entry: IndexEntry,
  transition: (current: RunJob) => RunJob,
  expected?: Pick<RoutedRun, "parent" | "directory">,
): RunJob {
  try {
    if (expected) verifyRunFile(entry, expected);
    const parent = realDirectory(dirname(entry.run_dir));
    const directory = realDirectory(entry.run_dir);
    const path = join(entry.run_dir, "run-job.json");
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new CollectFailure("run metadata", "SYMLINK");
    if (!stat.isFile()) throw new CollectFailure("run metadata", "NOT_REGULAR");
    const routed = routeRun(entry, JSON.parse(readFileSync(path, "utf8")), parent, directory);
    const parsed = RunJobSchema.safeParse(routed.raw);
    if (!parsed.success) throw validationFailure("RunJob", parsed.error.issues);
    const next = transition(parsed.data);
    if (next === parsed.data) return next;
    const checked = RunJobSchema.safeParse(next);
    if (!checked.success) throw validationFailure("RunJob", checked.error.issues);
    routeRun(entry, checked.data, parent, directory);
    verifyRunFile(entry, routed);
    writeJsonSync(path, checked.data);
    return checked.data;
  } catch (error) {
    throw collectFailure("run-job publication", error);
  }
}

export function isTerminal(status: RunJob["status"]): boolean {
  return (
    status === "succeeded" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "collected"
  );
}

export function notificationFinished(raw: Record<string, unknown>): boolean {
  const notify = raw.notify;
  return (
    typeof notify === "object" &&
    notify !== null &&
    "status" in notify &&
    (notify.status === "delivered" || notify.status === "unreachable")
  );
}
