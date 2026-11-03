import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  RunRecordSchema,
  type BuildId,
  type BuildRecord,
  type ChangeRequest,
  type EvidenceReport,
  type RunId,
  type RunRecord,
  type VerificationCase,
} from "@shud-harness/dsh-shud-core";
import {
  readWorkspaceRecord,
  WorkspaceRecordError,
  type WorkspaceRecordMap,
} from "./workspace-records.ts";
import { regularTarget } from "./workspace-paths.ts";
import { ReportRenderError } from "./report-render-error.ts";

type ReportInputKind = "report" | "stack" | "data" | "change" | "verification" | "build";

/** Reuse non-creating workspace reads, including schema, path safety and cited identity binding. */
export function readReportInput<K extends ReportInputKind>(
  cwd: string,
  kind: K,
  id: string,
): WorkspaceRecordMap[K] {
  try {
    return readWorkspaceRecord(cwd, kind, id, { readonly: true });
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
}

/** Required canonical facts, retaining each VC's own ordered build pair for display. */
export interface ReportCodeChangeFacts {
  readonly changes: readonly ChangeRequest[];
  readonly verifications: readonly {
    readonly record: VerificationCase;
    readonly baseBuild: BuildRecord;
    readonly candidateBuild: BuildRecord;
  }[];
}

/**
 * Read cited JSON only, without following StackLock build ids or VC change ids.
 * Shared builds are read once per projection but remain present in every VC pair.
 * This validates file/schema/identity safety, not task, approval or hash relationships.
 */
export function readReportCodeChangeFacts(
  cwd: string,
  report: EvidenceReport,
): ReportCodeChangeFacts {
  const changes = report.change_ids.map((id) => readReportInput(cwd, "change", id));
  const builds = new Map<BuildId, BuildRecord>();
  const readBuild = (id: BuildId): BuildRecord => {
    const cached = builds.get(id);
    if (cached !== undefined) return cached;
    const build = readReportInput(cwd, "build", id);
    builds.set(id, build);
    return build;
  };
  const verifications = report.verification_ids.map((id) => {
    const record = readReportInput(cwd, "verification", id);
    return {
      record,
      baseBuild: readBuild(record.base_build_id),
      candidateBuild: readBuild(record.candidate_build_id),
    };
  });
  return { changes, verifications };
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
