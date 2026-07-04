import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { PolicyGateDenyDecision } from "./policy-gate-core";

export const DEFAULT_POLICY_GATE_AUDIT_TASK_ID = "TASK-M1-SPIKE" as const;
export const DEFAULT_POLICY_GATE_AUDIT_FILE = "policy-gate-audit.ndjson" as const;

export interface PolicyGateAuditRow {
  event: string;
  tool_id: string;
  rule: string;
  decision: "allow" | "deny";
  ts: string;
  guard_class?: string;
  remediation_ref?: string;
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

export interface BuildPolicyGateAuditRowFromDeniedDecisionInput {
  event?: string;
  toolId: string;
  decision: PolicyGateDenyDecision;
  ts?: string;
}

export async function appendPolicyGateAuditRow(
  row: Omit<PolicyGateAuditRow, "ts"> & { ts?: string },
  options: AppendPolicyGateAuditRowOptions = {}
): Promise<AppendPolicyGateAuditRowResult> {
  const resolvedRow: PolicyGateAuditRow = {
    ...row,
    ts: row.ts ?? options.now?.() ?? new Date().toISOString()
  };
  const { auditDir, auditPath } = resolvePolicyGateAuditLocation(options);

  await mkdir(auditDir, { recursive: true });
  await appendFile(auditPath, `${JSON.stringify(resolvedRow)}\n`, "utf8");

  return {
    auditDir,
    auditPath,
    row: resolvedRow
  };
}

export function getPolicyGateAuditDir(options: AppendPolicyGateAuditRowOptions = {}): string {
  return resolvePolicyGateAuditLocation(options).auditDir;
}

export function buildPolicyGateAuditRowFromDeniedDecision(
  input: BuildPolicyGateAuditRowFromDeniedDecisionInput
): Omit<PolicyGateAuditRow, "ts"> & { ts?: string } {
  return {
    event: input.event ?? "tool.failed",
    tool_id: input.toolId,
    rule: input.decision.ruleId,
    decision: "deny",
    ...(input.decision.guard_class ? { guard_class: input.decision.guard_class } : {}),
    remediation_ref: input.decision.remediation.ref,
    ...(input.ts ? { ts: input.ts } : {})
  };
}

function resolvePolicyGateAuditLocation(options: AppendPolicyGateAuditRowOptions = {}): {
  auditDir: string;
  auditPath: string;
} {
  const workspaceRoot = path.resolve(options.workspaceRoot ?? process.cwd());
  const taskId = validateAuditPathSegment(
    "taskId",
    options.taskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID
  );
  const fileName = validateAuditPathSegment(
    "fileName",
    options.fileName ?? DEFAULT_POLICY_GATE_AUDIT_FILE
  );
  const auditDir = path.resolve(workspaceRoot, "workspace", "tasks", taskId, "audit");
  const auditPath = path.resolve(auditDir, fileName);

  if (!isPathInside(auditPath, auditDir)) {
    throw new Error("Invalid policy gate audit fileName: must stay inside audit directory.");
  }

  return {
    auditDir,
    auditPath
  };
}

function validateAuditPathSegment(field: "taskId" | "fileName", value: string): string {
  if (
    value.length === 0 ||
    value === "." ||
    value === ".." ||
    value.includes("/") ||
    value.includes("\\") ||
    path.basename(value) !== value
  ) {
    throw new Error(`Invalid policy gate audit ${field}: must be a single path segment.`);
  }

  return value;
}

function isPathInside(candidatePath: string, containingDir: string): boolean {
  const relativePath = path.relative(containingDir, candidatePath);
  return relativePath.length === 0 || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}
