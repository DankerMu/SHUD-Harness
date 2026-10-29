import {
  PiGateDecisionSchema,
  type EvidenceReport,
  type PiGateDecision,
  type TaskCard,
  type TaskStatus,
} from "@shud-harness/dsh-shud-core";

/** Controlled report-state diagnostics never retain prose or decision/schema payloads. */
export class ReportStateError extends Error {
  constructor(
    readonly reason:
      | "invalid_decision"
      | "invalid_transition"
      | "report_id_mismatch"
      | "inconsistent_decision_history"
      | "unsupported_report_status"
      | "task_id_mismatch",
  ) {
    super(`Report state failed: ${reason}`);
    this.name = "ReportStateError";
  }
}

/**
 * Record caller-established validation success without invoking a validator or publishing files.
 * Only draft may become reviewed; terminal decision history cannot re-enter a preterminal state.
 * Change only status and updated_at, reading the default clock only after accepting the event.
 */
export function markReportReviewed(report: EvidenceReport, now?: Date): EvidenceReport {
  if (report.status !== "draft") throw new ReportStateError("invalid_transition");
  if (report.decision_history.length !== 0) {
    throw new ReportStateError("inconsistent_decision_history");
  }
  return { ...report, status: "reviewed", updated_at: (now ?? new Date()).toISOString() };
}

/**
 * Apply a caller-established allowed-once decision to a reviewed report, without IO or mutation.
 * A decision object is not approval authority: the caller owns approval and publication.
 * The core schema owns decision validation; append its parsed value without altering decided_at.
 * Only status, decision_history and observation-time updated_at change. No time ordering is imposed.
 */
export function applyDecision(
  report: EvidenceReport,
  decision: PiGateDecision,
  now?: Date,
): EvidenceReport {
  if (report.status !== "reviewed") throw new ReportStateError("invalid_transition");
  if (report.decision_history.length !== 0) {
    throw new ReportStateError("inconsistent_decision_history");
  }
  const parsed = PiGateDecisionSchema.safeParse(decision);
  if (!parsed.success) throw new ReportStateError("invalid_decision");
  if (parsed.data.report_id !== report.report_id) {
    throw new ReportStateError("report_id_mismatch");
  }
  return {
    ...report,
    status: parsed.data.outcome,
    decision_history: [...report.decision_history, parsed.data],
    updated_at: (now ?? new Date()).toISOString(),
  };
}

/**
 * Project a supported M3 report status without authenticating decision history or approval.
 * Reserved and unknown runtime states fail closed; no clock or persistent transition is involved.
 */
export function reportTaskStatus(status: EvidenceReport["status"]): TaskStatus {
  switch (status) {
    case "draft":
    case "reviewed":
      return "reporting";
    case "accepted":
      return "done";
    case "revision_requested":
      return "planned";
    case "rejected":
      return "cancelled";
    default:
      throw new ReportStateError("unsupported_report_status");
  }
}

/**
 * Indicate a missing link or a last-linked report's outstanding status projection.
 * Task identity and supported status are prerequisites even for unlinked or older reports.
 * The last array entry owns projection, including duplicates; no metadata/history/clock checks
 * are repair triggers. This predicate neither mutates a card nor performs the future tools'
 * missing-link append/reporting step, subsequent terminal projection or atomic publication.
 */
export function needsReportTaskRepair(card: TaskCard, report: EvidenceReport): boolean {
  if (card.task_id !== report.task_id) throw new ReportStateError("task_id_mismatch");
  const status = reportTaskStatus(report.status);
  return (
    !card.linked_reports.includes(report.report_id) ||
    (card.linked_reports.at(-1) === report.report_id && card.status !== status)
  );
}
