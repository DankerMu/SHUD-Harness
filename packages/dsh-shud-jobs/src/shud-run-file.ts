import type { Stats } from "node:fs";
import * as io from "node:fs/promises";
import { dirname, join } from "node:path";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { realDirectory, verifyRun } from "./shud-input.ts";
import type { IndexEntry } from "./state-indexes.ts";

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

export function verifyRunFile(entry: IndexEntry, routed: RoutedRun): void {
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
