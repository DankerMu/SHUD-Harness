import {
  DataIdSchema,
  JobRecordIdSchema,
  ReportIdSchema,
  RunIdSchema,
  StackIdSchema,
  TaskIdSchema,
} from "@shud-harness/dsh-shud-core";
import type { ShudJobRegistry } from "@shud-harness/dsh-shud-jobs";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";

export interface AuthoredReport {
  summary: string;
  observations: string[];
  limitations: string[];
  pi_questions: string[];
}

// Only standalone tokens in the six specified namespaces are citations. The core brands
// remain authoritative; DEC and malformed/embedded substrings are ordinary authored text.
const CITATION =
  /(?<![A-Za-z0-9_-])(?:TASK|STACK|DATA|REPORT|RUN|JOB)-[0-9]{8}T[0-9]{6}-[0-9a-f]{4}(?![A-Za-z0-9_-])/gu;

export function checkReportCitations(
  cwd: string,
  jobs: ShudJobRegistry,
  authored: AuthoredReport,
): void {
  const seen = new Set<string>();
  for (const text of [
    authored.summary,
    ...authored.observations,
    ...authored.limitations,
    ...authored.pi_questions,
  ]) {
    for (const [token] of text.matchAll(CITATION)) {
      if (seen.has(token)) continue;
      seen.add(token);
      try {
        if (token.startsWith("TASK-")) {
          readWorkspaceRecord(cwd, "task", TaskIdSchema.parse(token), { readonly: true });
        } else if (token.startsWith("STACK-")) {
          readWorkspaceRecord(cwd, "stack", StackIdSchema.parse(token), { readonly: true });
        } else if (token.startsWith("DATA-")) {
          readWorkspaceRecord(cwd, "data", DataIdSchema.parse(token), { readonly: true });
        } else if (token.startsWith("REPORT-")) {
          readWorkspaceRecord(cwd, "report", ReportIdSchema.parse(token), { readonly: true });
        } else {
          const id = token.startsWith("RUN-")
            ? RunIdSchema.parse(token)
            : JobRecordIdSchema.parse(token);
          if (!jobs.indexes.lookup(id)) throw new Error("Citation is not indexed");
        }
      } catch {
        throw new Error(`report_generate citation unavailable: ${token}`);
      }
    }
  }
}
