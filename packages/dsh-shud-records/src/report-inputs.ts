import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { RunRecordSchema, type RunId, type RunRecord } from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  WorkspaceRecordError,
  type WorkspaceRecordMap,
} from "./workspace-records.ts";
import { regularTarget } from "./workspace-paths.ts";
import { ReportRenderError } from "./report-render-error.ts";

type ReportInputKind = "report" | "stack" | "data";

/** Reuse workspace safety/schema rules, then bind the cited identity to its file. */
export function readReportInput<K extends ReportInputKind>(
  cwd: string,
  kind: K,
  id: string,
): WorkspaceRecordMap[K] {
  let record: WorkspaceRecordMap[K];
  try {
    record = readWorkspaceRecord(cwd, kind, id);
  } catch (error) {
    if (
      error instanceof WorkspaceRecordError &&
      error.stage !== "kind" &&
      error.stage !== "write"
    ) {
      throw new ReportRenderError(error.stage, error.path);
    }
    throw new ReportRenderError("read");
  }
  const embeddedId =
    "report_id" in record
      ? record.report_id
      : "stack_id" in record
        ? record.stack_id
        : record.data_id;
  if (embeddedId !== id) {
    const directory = kind === "report" ? "reports" : kind === "stack" ? "stacks" : "provenance";
    throw new ReportRenderError("identity", join(cwd, directory, `${id}.json`));
  }
  return record;
}

function requireRunDirectory(path: string): void {
  try {
    if (lstatSync(path).isDirectory()) return;
  } catch {
    // Missing, inaccessible and unsafe run directories share the controlled boundary.
  }
  throw new ReportRenderError("directory", path);
}

/** Read only the cited same-workspace record; never create or discover run directories. */
export function readReportRun(cwd: string, runId: RunId): RunRecord {
  const root = join(cwd, "runs");
  requireRunDirectory(root);
  const directory = join(root, runId);
  requireRunDirectory(directory);
  const path = join(directory, "run-record.json");
  let exists: boolean;
  try {
    exists = regularTarget(path, "Report run") !== undefined;
  } catch {
    throw new ReportRenderError("target", path);
  }
  if (!exists) throw new ReportRenderError("missing", path);
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    const missing = error instanceof Error && "code" in error && error.code === "ENOENT";
    throw new ReportRenderError(missing ? "missing" : "read", path);
  }
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch {
    throw new ReportRenderError("parse", path);
  }
  const parsed = RunRecordSchema.safeParse(value);
  if (!parsed.success) throw new ReportRenderError("schema", path);
  if (parsed.data.run_id !== runId) throw new ReportRenderError("identity", path);
  return parsed.data;
}
