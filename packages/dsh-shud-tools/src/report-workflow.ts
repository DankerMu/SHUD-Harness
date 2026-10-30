import { realpathSync } from "node:fs";
import type { EvidenceReport, ReportId, TaskCard, TaskId } from "@shud-harness/dsh-shud-core";
import {
  isReportMarkdownStale,
  needsReportTaskRepair,
  readReportMarkdown,
  readWorkspaceRecord,
  renderReport,
  reportTaskStatus,
  transitionTask,
  WorkspaceRecordError,
  writeReportMarkdown,
  writeWorkspaceRecord,
} from "@shud-harness/dsh-shud-records";

export function reportCwd(cwd: unknown): string {
  if (typeof cwd !== "string" || cwd.length === 0) {
    throw new Error("Report tools require the calling session's cwd");
  }
  return cwd;
}

const reportOperations = new Map<string, Promise<void>>();

/**
 * One single-process publication lane for a physical workspace/report pair.
 * Register synchronously (including immediately after generation's JSON commit);
 * approval is already resolved by the host before any caller reaches this boundary.
 */
export function withReportOperation<T>(
  cwd: string,
  reportId: ReportId,
  operation: () => Promise<T>,
): Promise<T> {
  let physicalCwd: string;
  try {
    physicalCwd = realpathSync.native(cwd);
  } catch {
    throw new Error(`Report ${reportId}: workspace cwd cannot be resolved`);
  }
  const key = `${physicalCwd}\0${reportId}`;
  const result = (reportOperations.get(key) ?? Promise.resolve()).then(operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  reportOperations.set(key, tail);
  void tail.then(() => {
    if (reportOperations.get(key) === tail) reportOperations.delete(key);
  });
  return result;
}

function readReportTask(cwd: string, taskId: TaskId): TaskCard {
  let stage: WorkspaceRecordError["stage"];
  try {
    return readWorkspaceRecord(cwd, "task", taskId, { readonly: true });
  } catch (error) {
    stage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  throw new Error(`Report task ${taskId}: ${stage} failed`);
}

export function readGeneratableTask(cwd: string, taskId: TaskId): TaskCard {
  const card = readReportTask(cwd, taskId);
  if (card.status !== "planned" && card.status !== "running" && card.status !== "reporting") {
    throw new Error(`report_generate task ${taskId}: invalid state ${card.status}`);
  }
  return card;
}

export function readReport(cwd: string, reportId: ReportId): EvidenceReport {
  let stage: WorkspaceRecordError["stage"];
  try {
    return readWorkspaceRecord(cwd, "report", reportId, { readonly: true });
  } catch (error) {
    stage = error instanceof WorkspaceRecordError ? error.stage : "read";
  }
  throw new Error(`Report ${reportId}: ${stage} failed`);
}

export function reportStepError(stage: "task_card" | "render", reportId: ReportId): Error {
  return new Error(`Report ${reportId}: ${stage} failed; prior commits retained`);
}

/** Fresh synchronous card boundary; all transitions are computed before its single publication. */
function repairReportTask(cwd: string, report: EvidenceReport): void {
  try {
    const projected = reportTaskStatus(report.status);
    const card = readReportTask(cwd, report.task_id);
    if (!needsReportTaskRepair(card, report)) return;
    const unlinked = !card.linked_reports.includes(report.report_id);
    let repaired = unlinked ? transitionTask(card, { type: "report_generate" }) : card;
    if (repaired.status !== projected) {
      if (report.status === "draft" || report.status === "reviewed") {
        repaired = transitionTask(repaired, { type: "report_generate" });
      } else if (report.status === "accepted") {
        repaired = transitionTask(repaired, { type: "report_submit" });
      } else if (report.status === "revision_requested" || report.status === "rejected") {
        repaired = transitionTask(repaired, { type: "report_decide", disposition: report.status });
      }
    }
    writeWorkspaceRecord(cwd, "task", {
      ...repaired,
      linked_reports: unlinked
        ? [...repaired.linked_reports, report.report_id]
        : repaired.linked_reports,
    });
  } catch {
    throw reportStepError("task_card", report.report_id);
  }
}

/** Normal approved projection is explicit, even for a linked older report. */
export function publishReportDecisionTask(
  cwd: string,
  report: EvidenceReport,
  outcome: "accepted" | "rejected" | "revision_requested",
): void {
  try {
    const card = readReportTask(cwd, report.task_id);
    const transitioned = transitionTask(
      card,
      outcome === "accepted"
        ? { type: "report_submit" }
        : { type: "report_decide", disposition: outcome },
    );
    writeWorkspaceRecord(cwd, "task", transitioned);
  } catch {
    throw reportStepError("task_card", report.report_id);
  }
}

export async function publishReportMarkdown(cwd: string, reportId: ReportId): Promise<void> {
  try {
    await writeReportMarkdown(cwd, reportId, renderReport(cwd, reportId));
  } catch {
    throw reportStepError("render", reportId);
  }
}

/** Repairs are independent commits, ordered card then watermark, before the tool's precondition. */
export async function repairReportEntry(cwd: string, report: EvidenceReport): Promise<void> {
  repairReportTask(cwd, report);
  try {
    const markdown = readReportMarkdown(cwd, report.report_id);
    if (isReportMarkdownStale(report, markdown)) {
      await publishReportMarkdown(cwd, report.report_id);
    }
  } catch {
    throw reportStepError("render", report.report_id);
  }
}
