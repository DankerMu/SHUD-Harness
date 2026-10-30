import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { ReportIdSchema } from "@shud-harness/dsh-shud-core";
import type { ReportId } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";

export const REPORT_APPROVAL_REASON_PREFIX = "PI approval required for report";
export const INVALID_REPORT_ID_MARKER = "<invalid-report-id>";

function summaryFirstLine(cwd: string | undefined, id: ReportId): string | undefined {
  if (!cwd) return undefined;
  try {
    // The canonical reader may create reports/, but never repairs a missing or invalid report.
    const report = readWorkspaceRecord(cwd, "report", id);
    if (report.report_id !== id) return undefined;
    const newline = report.summary.indexOf("\n");
    if (newline < 0) return report.summary;
    const end = newline > 0 && report.summary[newline - 1] === "\r" ? newline - 1 : newline;
    return report.summary.slice(0, end);
  } catch {
    return undefined;
  }
}

function field(input: unknown, key: string): unknown {
  if (!input || typeof input !== "object") return undefined;
  try {
    return Reflect.get(input, key);
  } catch {
    return undefined;
  }
}

/** Presentation does not authorize report state transitions or initiate approval itself. */
export function reportApproval(
  tool: "report_submit" | "report_decide",
  input: unknown,
  cwd: string | undefined,
): Extract<PreToolDecision, { kind: "ask" }> {
  const parsed = ReportIdSchema.safeParse(field(input, "report_id"));
  const id = parsed.success ? parsed.data : INVALID_REPORT_ID_MARKER;
  const summary = parsed.success ? summaryFirstLine(cwd, parsed.data) : undefined;
  const path = parsed.success ? `reports/${parsed.data}.md` : undefined;
  const unavailableEn = "Unavailable (cannot read)";
  const unavailableZh = "无法读取";
  let en = `Report: ${id}\nPath: ${path ?? unavailableEn}\nSummary: ${summary ?? unavailableEn}`;
  let zh = `报告：${id}\n路径：${path ?? unavailableZh}\n摘要：${summary ?? unavailableZh}`;
  if (tool === "report_decide") {
    const disposition = field(input, "disposition");
    const comment = field(input, "comment");
    en += `\nDisposition: ${typeof disposition === "string" ? disposition : unavailableEn}`;
    en += `\nComment: ${typeof comment === "string" ? comment : unavailableEn}`;
    zh += `\n处置：${typeof disposition === "string" ? disposition : unavailableZh}`;
    zh += `\n意见：${typeof comment === "string" ? comment : unavailableZh}`;
  }
  return {
    kind: "ask",
    reason: `${REPORT_APPROVAL_REASON_PREFIX} ${id}`,
    displayReason: { en, zh },
  };
}
