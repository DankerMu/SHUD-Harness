import type { EvidenceReport } from "@shud-harness/dsh-shud-core";
import { ReportRenderError } from "./report-render-error.ts";

/** Package-internal projection shared by rendering and staleness, not a public getter. */
export function reportWatermark(report: EvidenceReport): { header: string; footer: string | null } {
  if (
    report.status === "draft" ||
    report.status === "reviewed" ||
    report.status === "awaiting_pi"
  ) {
    return { header: "DRAFT — not accepted by PI", footer: "DRAFT — not accepted by PI" };
  }
  const decision = report.decision_history[0];
  if (
    report.decision_history.length !== 1 ||
    decision === undefined ||
    decision.report_id !== report.report_id ||
    (report.status !== "archived" && decision.outcome !== report.status)
  ) {
    throw new ReportRenderError("decision_history");
  }
  const terminal =
    decision.outcome === "accepted"
      ? `Accepted by PI · ${decision.decided_at} · ${decision.decision_id}`
      : decision.outcome === "rejected"
        ? "REJECTED — not accepted by PI"
        : "REVISION REQUESTED — not accepted by PI";
  if (report.status === "archived") {
    const header = `${terminal} · ARCHIVED`;
    return { header, footer: decision.outcome === "accepted" ? "ARCHIVED" : header };
  }
  return { header: terminal, footer: decision.outcome === "accepted" ? null : terminal };
}

/**
 * Pure projection of a validated report's expected physical second-line watermark.
 * No file, clock, body/footer inspection or mutation; ambiguous terminal evidence throws
 * even when Markdown is missing. Future report tools own reads and atomic publication.
 */
export function isReportMarkdownStale(
  report: EvidenceReport,
  markdown: string | undefined,
): boolean {
  const expected = reportWatermark(report).header;
  if (markdown === undefined) return true;
  const titleEnd = markdown.indexOf("\n");
  if (titleEnd === -1) return true;
  const headerEnd = markdown.indexOf("\n", titleEnd + 1);
  return markdown.slice(titleEnd + 1, headerEnd === -1 ? undefined : headerEnd) !== expected;
}
