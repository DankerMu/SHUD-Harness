import { constants } from "node:fs";
import { lstat, mkdir, open, realpath } from "node:fs/promises";
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
  const { workspaceRoot, auditDir, auditPath } = resolvePolicyGateAuditLocation(options);

  await assertAuditDirectoryCanBeCreatedInsideWorkspace(workspaceRoot, auditDir);
  await mkdir(auditDir, { recursive: true });
  await assertAuditLocationInsideWorkspace(workspaceRoot, auditDir, auditPath);
  await appendPolicyGateAuditLineNoFollow(auditPath, `${JSON.stringify(resolvedRow)}\n`);

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
  workspaceRoot: string;
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
    workspaceRoot,
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

async function assertAuditDirectoryCanBeCreatedInsideWorkspace(
  workspaceRoot: string,
  auditDir: string
): Promise<void> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const relativeAuditDir = path.relative(workspaceRoot, auditDir);
  let currentPath = workspaceRoot;

  for (const segment of relativeAuditDir.split(path.sep)) {
    if (!segment) {
      continue;
    }

    currentPath = path.join(currentPath, segment);
    const existingPath = await lstatIfExists(currentPath);
    if (!existingPath) {
      break;
    }

    const realCurrentPath = await realpath(currentPath);
    if (!isPathInside(realCurrentPath, realWorkspaceRoot)) {
      throw new Error("Invalid policy gate audit directory: resolves outside workspace.");
    }
  }
}

async function assertAuditLocationInsideWorkspace(
  workspaceRoot: string,
  auditDir: string,
  auditPath: string
): Promise<void> {
  const realWorkspaceRoot = await realpath(workspaceRoot);
  const realAuditDir = await realpath(auditDir);
  if (!isPathInside(realAuditDir, realWorkspaceRoot)) {
    throw new Error("Invalid policy gate audit directory: resolves outside workspace.");
  }

  const existingAuditPath = await lstatIfExists(auditPath);
  if (!existingAuditPath) {
    return;
  }

  const realAuditPath = await realpath(auditPath);
  if (!isPathInside(realAuditPath, realAuditDir)) {
    throw new Error("Invalid policy gate audit fileName: resolves outside audit directory.");
  }
}

async function appendPolicyGateAuditLineNoFollow(
  auditPath: string,
  line: string
): Promise<void> {
  const noFollowFlag =
    typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
  const flags = constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | noFollowFlag;
  let fileHandle: Awaited<ReturnType<typeof open>> | undefined;

  try {
    if (noFollowFlag === 0) {
      const existingAuditPath = await lstatIfExists(auditPath);
      if (existingAuditPath?.isSymbolicLink()) {
        throw new Error("Invalid policy gate audit fileName: must not be a symlink.");
      }
    }
    fileHandle = await open(auditPath, flags, 0o600);
    await fileHandle.writeFile(line, "utf8");
  } catch (error) {
    if (isSymlinkOpenError(error)) {
      throw new Error("Invalid policy gate audit fileName: must not be a symlink.");
    }
    throw error;
  } finally {
    await fileHandle?.close();
  }
}

async function lstatIfExists(filePath: string) {
  try {
    return await lstat(filePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  }
}

function isSymlinkOpenError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ELOOP" ||
      (error as { code?: unknown }).code === "EMLINK")
  );
}

function isNotFoundError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}
