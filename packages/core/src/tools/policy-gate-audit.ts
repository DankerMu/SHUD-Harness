import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";

export const DEFAULT_POLICY_GATE_AUDIT_TASK_ID = "TASK-M1-SPIKE" as const;
export const DEFAULT_POLICY_GATE_AUDIT_FILE = "policy-gate-audit.ndjson" as const;

export interface PolicyGateAuditRow {
  event: string;
  tool_id: string;
  rule: string;
  decision: "allow" | "deny";
  ts: string;
  guard_class?: string;
}

export interface AppendPolicyGateAuditRowOptions {
  workspaceRoot?: string;
  taskId?: string;
  fileName?: string;
  now?: () => string;
}

export interface AppendPolicyGateAuditRowResult {
  auditDir: string;
  auditPath: string;
  row: PolicyGateAuditRow;
}

export async function appendPolicyGateAuditRow(
  row: Omit<PolicyGateAuditRow, "ts"> & { ts?: string },
  options: AppendPolicyGateAuditRowOptions = {}
): Promise<AppendPolicyGateAuditRowResult> {
  const resolvedRow: PolicyGateAuditRow = {
    ...row,
    ts: row.ts ?? options.now?.() ?? new Date().toISOString()
  };
  const auditDir = getPolicyGateAuditDir(options);
  const auditPath = path.join(auditDir, options.fileName ?? DEFAULT_POLICY_GATE_AUDIT_FILE);

  await mkdir(auditDir, { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(resolvedRow)}\n`, "utf8");

  return {
    auditDir,
    auditPath,
    row: resolvedRow
  };
}

export function getPolicyGateAuditDir(options: AppendPolicyGateAuditRowOptions = {}): string {
  return path.join(
    options.workspaceRoot ?? process.cwd(),
    "workspace",
    "tasks",
    options.taskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID,
    "audit"
  );
}
