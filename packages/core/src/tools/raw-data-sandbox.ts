import { createHash } from "node:crypto";
import { mkdir, readdir, realpath, appendFile, lstat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { BaseTool, BashTool } from "@zero-os/core";
import type { ToolContext, ToolResult } from "@zero-os/shared";
import type { ErrorRecord } from "../domain/schemas";
import type {
  PolicyGateRemediation,
  PolicyGateToolCall,
  PolicyRule,
  PolicyRuleDecision
} from "./policy-gate-core";

export const RAW_DATA_WRITE_RULE_ID = "raw-data-write";
export const RAW_DATA_SANDBOX_PROFILE_VERSION = "raw-data-seatbelt-v1";
export const RAW_DATA_POLICY_REF =
  "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md";
export const DEFAULT_POLICY_GATE_AUDIT_TASK_ID = "TASK-M1-SPIKE";

const DEFAULT_AUDIT_FILE_NAME = "policy-gate.ndjson";
const SANDBOX_DENIAL_PATTERN = /Operation not permitted|Permission denied|sandbox/i;
const INTERPRETER_WRITE_DENIAL_PATTERN = /can't open file/i;

export interface RawDataSeatbeltProfileOptions {
  protectedRawPaths: readonly string[];
  allowedWriteRoots: readonly string[];
  tempRoot?: string;
  profileRoot?: string;
}

export interface RawDataSeatbeltProfileMetadata {
  profileVersion: typeof RAW_DATA_SANDBOX_PROFILE_VERSION;
  profileId: string;
  protectedRawPaths: readonly string[];
  allowedWriteRoots: readonly string[];
  tempRoot: string;
  profileRoot?: string;
}

export interface RawDataSeatbeltProfile {
  profileId: string;
  profileText: string;
  metadata: RawDataSeatbeltProfileMetadata;
}

export interface RawDataSandboxedBashToolOptions extends RawDataSeatbeltProfileOptions {
  innerTool?: BaseTool;
  toolId?: string;
  enableAdvisory?: boolean;
  auditWorkspaceRoot?: string;
  auditTaskId?: string;
}

export interface PolicyGateAuditRow {
  event: string;
  tool_id: string;
  rule: string;
  decision: string;
  ts: string;
  profile_id?: string;
  profile_path?: string;
  [key: string]: unknown;
}

export interface AppendPolicyGateAuditRowOptions {
  workspaceRoot: string;
  row: PolicyGateAuditRow;
  taskId?: string;
  fileName?: string;
}

export interface RawDataDenialPayload {
  error: "raw_data_write_denied";
  tool_id: string;
  rule: typeof RAW_DATA_WRITE_RULE_ID;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  remediation: PolicyGateRemediation;
  profile_id: string;
  profile_path?: string;
  error_record: ErrorRecord;
}

export interface HardlinkRisk {
  path: string;
  nlink: number;
  dev: number;
  ino: number;
}

export interface HardlinkScanResult {
  protectedRoots: readonly string[];
  scannedPathCount: number;
  riskyPaths: readonly HardlinkRisk[];
}

export async function buildRawDataSeatbeltProfile(
  options: RawDataSeatbeltProfileOptions
): Promise<RawDataSeatbeltProfile> {
  if (options.protectedRawPaths.length === 0) {
    throw new Error("At least one protected raw path is required.");
  }
  if (options.allowedWriteRoots.length === 0) {
    throw new Error("At least one allowed write root is required.");
  }

  const protectedRawPaths = await canonicalizePathSet(options.protectedRawPaths);
  const allowedWriteRoots = await canonicalizePathSet(options.allowedWriteRoots);
  const tempRoot = await canonicalizeExistingPath(options.tempRoot ?? tmpdir());
  const profileRoot = options.profileRoot
    ? await canonicalizeDirectory(options.profileRoot)
    : undefined;

  const idInput = JSON.stringify({
    profileVersion: RAW_DATA_SANDBOX_PROFILE_VERSION,
    protectedRawPaths,
    allowedWriteRoots,
    tempRoot
  });
  const profileId = `shud-raw-seatbelt-${createHash("sha256")
    .update(idInput)
    .digest("hex")
    .slice(0, 16)}`;

  const writeAllowRoots = sortedUnique([tempRoot, ...allowedWriteRoots]);
  const profileText = [
    "(version 1)",
    "(deny default)",
    "(allow file-read*)",
    "(allow process*)",
    "(allow sysctl*)",
    "(allow mach-lookup)",
    "(allow network*)",
    `(allow file-write* (literal ${quoteSeatbeltString("/dev/null")}))`,
    ...writeAllowRoots.map(
      (allowedRoot) => `(allow file-write* (subpath ${quoteSeatbeltString(allowedRoot)}))`
    ),
    ...protectedRawPaths.map(
      (protectedPath) => `(deny file-write* (subpath ${quoteSeatbeltString(protectedPath)}))`
    )
  ].join("\n");

  return {
    profileId,
    profileText,
    metadata: {
      profileVersion: RAW_DATA_SANDBOX_PROFILE_VERSION,
      profileId,
      protectedRawPaths,
      allowedWriteRoots,
      tempRoot,
      ...(profileRoot ? { profileRoot } : {})
    }
  };
}

export async function writeRawDataSeatbeltProfileFile(
  profile: RawDataSeatbeltProfile,
  profileRoot?: string
): Promise<string> {
  const root = profileRoot ?? profile.metadata.profileRoot ?? profile.metadata.tempRoot;
  await mkdir(root, { recursive: true });
  const canonicalRoot = await canonicalizeExistingPath(root);
  const profilePath = join(canonicalRoot, `${profile.profileId}.sb`);
  await writeFile(profilePath, `${profile.profileText}\n`, { mode: 0o600 });
  return canonicalizeExistingPath(profilePath);
}

export class RawDataSandboxedBashTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  private readonly innerTool: BaseTool;

  constructor(private readonly options: RawDataSandboxedBashToolOptions) {
    super();
    this.innerTool = options.innerTool ?? new BashTool([]);
    this.name = options.toolId ?? this.innerTool.name;
    this.description = this.innerTool.description;
    this.parameters = this.innerTool.parameters;
    this.kind = this.innerTool.kind;
    this.requiredModelCapabilities = this.innerTool.requiredModelCapabilities;
  }

  protected async execute(ctx: ToolContext, input: unknown): Promise<ToolResult> {
    const command = readBashCommand(input);
    if (!command) {
      return {
        success: false,
        output: "Sandboxed bash requires a string command.",
        outputSummary: "Sandboxed bash missing command"
      };
    }

    const profile = await buildRawDataSeatbeltProfile(this.options);
    const profilePath = await writeRawDataSeatbeltProfileFile(profile, this.options.profileRoot);

    if (this.options.enableAdvisory !== false) {
      const advisory = evaluateRawDataWriteAdvisory(command, profile.metadata.protectedRawPaths);
      if (advisory.decision === "deny") {
        const result = buildRawDataDeniedToolResult({
          toolId: this.name,
          decision: "denied_by_advisory",
          reason: advisory.reason,
          profile,
          profilePath
        });
        await this.appendAudit(ctx, {
          event: "tool.failed",
          decision: "denied_by_advisory",
          profile,
          profilePath
        });
        return result;
      }
    }

    const wrappedCommand = `sandbox-exec -f ${shellQuote(profilePath)} bash -c ${shellQuote(
      command
    )}`;
    const result = await this.innerTool.run(ctx, {
      ...(typeof input === "object" && input !== null ? input : {}),
      command: wrappedCommand
    });

    if (isLikelySandboxDenialForCommand(command, result.output)) {
      const denied = buildRawDataDeniedToolResult({
        toolId: this.name,
        decision: "denied_by_sandbox",
        reason: "raw data writes are blocked by the OS sandbox profile",
        profile,
        profilePath,
        underlyingOutput: result.output
      });
      await this.appendAudit(ctx, {
        event: "tool.failed",
        decision: "denied_by_sandbox",
        profile,
        profilePath
      });
      return denied;
    }

    await this.appendAudit(ctx, {
      event: result.success ? "tool.completed" : "tool.failed",
      decision: result.success ? "allowed" : "failed",
      profile,
      profilePath
    });
    return result;
  }

  private async appendAudit(
    ctx: ToolContext,
    input: {
      event: string;
      decision: string;
      profile: RawDataSeatbeltProfile;
      profilePath: string;
    }
  ): Promise<void> {
    const workspaceRoot = this.options.auditWorkspaceRoot ?? ctx.workDir;
    await appendPolicyGateAuditRow({
      workspaceRoot,
      taskId: this.options.auditTaskId,
      row: {
        event: input.event,
        tool_id: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: input.decision,
        ts: new Date().toISOString(),
        profile_id: input.profile.profileId,
        profile_path: input.profilePath
      }
    });
  }
}

export function createRawDataWriteAdvisoryRule(
  protectedRawPaths: readonly string[]
): PolicyRule {
  return {
    ruleId: RAW_DATA_WRITE_RULE_ID,
    description:
      "Advisory-only detection for obvious static writes to protected raw data paths.",
    evaluate(call: PolicyGateToolCall): PolicyRuleDecision {
      if (call.toolId !== "bash") {
        return { decision: "allow" };
      }

      const command = readBashCommand(call.input);
      if (!command) {
        return { decision: "allow" };
      }

      return evaluateRawDataWriteAdvisory(command, protectedRawPaths);
    }
  };
}

export function evaluateRawDataWriteAdvisory(
  command: string,
  protectedRawPaths: readonly string[]
): PolicyRuleDecision {
  const protectedTargets = [
    "data/raw/",
    "./data/raw/",
    ...protectedRawPaths.flatMap((protectedPath) => [
      ensureTrailingSlash(protectedPath),
      ensureTrailingSlash(resolve(protectedPath))
    ])
  ];

  for (const target of sortedUnique(protectedTargets)) {
    const escapedTarget = escapeRegExp(target);
    const quotedTarget = String.raw`(?:"${escapedTarget}|'${escapedTarget}|${escapedTarget})`;
    const redirectionPattern = new RegExp(String.raw`(?:^|[\s;&|])(?:>{1,2}|<>)\s*${quotedTarget}`);
    const writeCommandPattern = new RegExp(
      String.raw`(?:^|[\s;&|])(?:/usr/bin/)?(?:tee|touch|rm|unlink|mv|cp)\b[^\n;&|]*\s+${quotedTarget}`
    );

    if (redirectionPattern.test(command) || writeCommandPattern.test(command)) {
      return {
        decision: "deny",
        reason: "obvious static raw-data write target",
        remediation: rawDataWriteRemediation()
      };
    }
  }

  return { decision: "allow" };
}

export async function appendPolicyGateAuditRow(
  options: AppendPolicyGateAuditRowOptions
): Promise<string> {
  const taskId = options.taskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID;
  if (!/^[A-Za-z0-9._-]+$/.test(taskId)) {
    throw new Error(`Invalid audit task id: ${taskId}`);
  }

  const auditDir = join(resolve(options.workspaceRoot), "workspace", "tasks", taskId, "audit");
  await mkdir(auditDir, { recursive: true });
  const auditPath = join(auditDir, options.fileName ?? DEFAULT_AUDIT_FILE_NAME);
  await appendFile(auditPath, `${JSON.stringify(options.row)}\n`, "utf8");
  return auditPath;
}

export function buildRawDataDeniedPayload(input: {
  toolId: string;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
  ts?: string;
}): RawDataDenialPayload {
  const ts = input.ts ?? new Date().toISOString();
  const remediation = rawDataWriteRemediation();
  const message =
    input.decision === "denied_by_sandbox"
      ? "Raw data write denied by OS sandbox."
      : "Raw data write denied by advisory policy gate.";

  return {
    error: "raw_data_write_denied",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    decision: input.decision,
    reason: input.reason,
    remediation,
    profile_id: input.profile.profileId,
    ...(input.profilePath ? { profile_path: input.profilePath } : {}),
    error_record: {
      error_id: `${RAW_DATA_WRITE_RULE_ID}:${input.decision}:${input.profile.profileId}`,
      category: input.decision === "denied_by_sandbox" ? "sandbox_error" : "permission_error",
      severity: "error",
      message,
      user_message: "data/raw is protected evidence input and cannot be mutated by bash.",
      evidence_refs: [
        RAW_DATA_POLICY_REF,
        ...(input.underlyingOutput ? [`sandbox-output:${input.underlyingOutput.slice(0, 240)}`] : [])
      ],
      retryable: false,
      recommended_next_actions: [remediation.hint],
      remediation,
      created_at: ts
    }
  };
}

export function buildRawDataDeniedToolResult(input: {
  toolId: string;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
}): ToolResult {
  const payload = buildRawDataDeniedPayload(input);
  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Raw data write denied: ${input.reason}`
  };
}

export async function scanProtectedHardlinks(input: {
  protectedRoots: readonly string[];
}): Promise<HardlinkScanResult> {
  const protectedRoots = await canonicalizePathSet(input.protectedRoots);
  const riskyPaths: HardlinkRisk[] = [];
  let scannedPathCount = 0;

  for (const root of protectedRoots) {
    await scanPath(root);
  }

  return {
    protectedRoots,
    scannedPathCount,
    riskyPaths
  };

  async function scanPath(path: string): Promise<void> {
    const metadata = await lstat(path);
    scannedPathCount += 1;

    if (metadata.nlink > 1 && metadata.isFile()) {
      riskyPaths.push({
        path,
        nlink: metadata.nlink,
        dev: metadata.dev,
        ino: metadata.ino
      });
    }

    if (!metadata.isDirectory()) {
      return;
    }

    const entries = await readdir(path, { withFileTypes: true });
    for (const entry of entries) {
      await scanPath(join(path, entry.name));
    }
  }
}

export function rawDataWriteRemediation(): PolicyGateRemediation {
  return {
    next_action: "adjust_scope",
    hint: "Write derived or temporary files outside data/raw; keep raw inputs read-only.",
    ref: RAW_DATA_POLICY_REF
  };
}

export function isLikelySandboxDenial(output: string): boolean {
  return SANDBOX_DENIAL_PATTERN.test(output);
}

function isLikelySandboxDenialForCommand(command: string, output: string): boolean {
  return (
    isLikelySandboxDenial(output) ||
    (INTERPRETER_WRITE_DENIAL_PATTERN.test(output) &&
      command.includes(">") &&
      command.includes("data/raw"))
  );
}

function readBashCommand(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const command = (input as { command?: unknown }).command;
  return typeof command === "string" && command.length > 0 ? command : undefined;
}

async function canonicalizePathSet(paths: readonly string[]): Promise<string[]> {
  return sortedUnique(await Promise.all(paths.map((path) => canonicalizeExistingPath(path))));
}

async function canonicalizeDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return canonicalizeExistingPath(path);
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

function quoteSeatbeltString(value: string): string {
  return `"${value
    .replaceAll("\\", "\\\\")
    .replaceAll('"', '\\"')
    .replaceAll("\n", "\\n")
    .replaceAll("\r", "\\r")}"`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function sortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function ensureTrailingSlash(value: string): string {
  return value.endsWith("/") ? value : `${value}/`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function rawDataSandboxProfileFileName(profile: RawDataSeatbeltProfile): string {
  return `${basename(profile.profileId)}.sb`;
}
