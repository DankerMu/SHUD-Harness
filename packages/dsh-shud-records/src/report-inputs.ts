import { lstatSync, readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
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
import { regularTarget, resolveManagedRoot } from "./workspace-paths.ts";
import { ReportRenderError } from "./report-render-error.ts";
import { readRunMetricsAt, type RunMetrics } from "./run-metrics-wire.ts";
import { ShudInputError } from "./shud-input-file.ts";

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

/** Read only the cited physical same-workspace record; never create or discover run directories. */
export function readReportRun(cwd: string, runId: RunId): RunRecord {
  let root: string | undefined;
  try {
    root = resolveManagedRoot(cwd, "runs", "Report run", true);
  } catch {
    throw new ReportRenderError(
      "directory",
      typeof cwd === "string" ? `${cwd || "."}/runs` : undefined,
    );
  }
  if (root === undefined) throw new ReportRenderError("directory", `${cwd || "."}/runs`);
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

export interface ReportMetricFacts {
  readonly run_id: RunId;
  readonly source_ref: { readonly path: string; readonly sha256: string } | null;
  readonly metrics: RunMetrics | null;
}

/** Fresh, referenced-only reads; runs and run directories remain untrusted relative ancestors. */
export function readReportMetricFacts(
  cwd: string,
  runs: readonly RunRecord[],
): ReportMetricFacts[] {
  return runs.map((run) => {
    const reference = run.artifacts.metrics_summary;
    if (reference === null) return { run_id: run.run_id, source_ref: null, metrics: null };
    const path = `runs/${run.run_id}/metrics.json`;
    try {
      return {
        run_id: run.run_id,
        source_ref: { path, sha256: reference.sha256 },
        metrics: readRunMetricsAt(
          isAbsolute(cwd) ? cwd : `${process.cwd()}/${cwd || "."}`,
          path,
          reference.sha256,
        ),
      };
    } catch (error) {
      throw new ReportRenderError(
        error instanceof ShudInputError
          ? error.stage === "unsafe"
            ? "target"
            : error.stage
          : "read",
        path,
      );
    }
  });
}
