import {
  EvidenceReportSchema,
  PiGateDecisionSchema,
  type EvidenceReport,
  type PiGateDecision,
} from "@shud-harness/dsh-shud-core";
import { reportCase } from "./test-harness.ts";

export function makeEvidenceReport(overrides: Partial<EvidenceReport> = {}): EvidenceReport {
  return EvidenceReportSchema.parse({
    ...reportCase.value,
    summary: "private-report-summary-440",
    observations: ["private-report-observation-440"],
    limitations: ["private-report-limitation-440"],
    pi_questions: ["private-report-question-440"],
    created_at: "2026-10-29T08:00:00Z",
    updated_at: "2026-10-30T12:34:56Z",
    ...overrides,
  });
}

export function makeReportDecision(
  outcome: PiGateDecision["outcome"],
  overrides: Partial<PiGateDecision> = {},
): PiGateDecision {
  return PiGateDecisionSchema.parse({
    decision_id: "DEC-20261029T100000-a001",
    report_id: reportCase.id,
    approval_ref: "private-approval-reference-440",
    outcome,
    comment: outcome === "accepted" ? null : "private-decision-comment-440",
    decided_at: "2026-10-29T10:00:00Z",
    ...overrides,
  });
}

export function freezeEvidenceReport(report: EvidenceReport): EvidenceReport {
  Object.freeze(report.observations);
  Object.freeze(report.limitations);
  Object.freeze(report.pi_questions);
  Object.freeze(report.linked_runs);
  Object.freeze(report.stack_ids);
  Object.freeze(report.data_ids);
  Object.freeze(report.llm_response_models);
  report.decision_history.forEach(Object.freeze);
  Object.freeze(report.decision_history);
  return Object.freeze(report);
}
