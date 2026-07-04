import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { BaseTool, BashTool } from "@zero-os/core";
import type { FuseRule, ToolContext, ToolResult } from "@zero-os/shared";
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
  protectedEvidencePaths?: readonly string[];
}

export interface RawDataSeatbeltProfileMetadata {
  profileVersion: typeof RAW_DATA_SANDBOX_PROFILE_VERSION;
  profileId: string;
  protectedRawPaths: readonly string[];
  protectedEvidencePaths: readonly string[];
  allowedWriteRoots: readonly string[];
  tempRoot: string;
  profileRoot?: string;
}

export interface RawDataSeatbeltProfile {
  profileId: string;
  profileText: string;
  metadata: RawDataSeatbeltProfileMetadata;
}

export type RawDataSandboxedBashToolOptions = RawDataSeatbeltProfileOptions & {
  toolId?: string;
  enableAdvisory?: boolean;
  auditWorkspaceRoot?: string;
  auditTaskId?: string;
} & (
    | { innerTool: BaseTool; fuseRules?: never }
    | { innerTool?: never; fuseRules: readonly FuseRule[] }
  );

export interface PolicyGateAuditRow {
  event: string;
  tool_id: string;
  rule: string;
  decision: string;
  ts: string;
  profile_id?: string;
  profile_path?: string;
  guard_class?: RawDataGuardClass;
  error_id?: string;
  invocation_id?: string;
  remediation_next_action?: string;
  remediation_ref?: string;
  [key: string]: unknown;
}

export interface AppendPolicyGateAuditRowOptions {
  workspaceRoot: string;
  row: PolicyGateAuditRow;
  taskId?: string;
  fileName?: string;
  protectedRawPaths?: readonly string[];
}

export interface RawDataDenialPayload {
  error: "raw_data_write_denied";
  tool_id: string;
  rule: typeof RAW_DATA_WRITE_RULE_ID;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  guard_class: RawDataGuardClass;
  reason: string;
  remediation: PolicyGateRemediation;
  profile_id: string;
  profile_path?: string;
  invocation_id?: string;
  error_record: ErrorRecord;
}

export type RawDataGuardClass = "authority" | "capability";

export interface RawDataDenialEvidence {
  payload: RawDataDenialPayload;
  toolResult: ToolResult;
  auditRow: PolicyGateAuditRow;
  toolFailedEventInput: RawDataToolFailedEventInput;
}

export interface RawDataToolFailedEventInput {
  toolId: string;
  rule: typeof RAW_DATA_WRITE_RULE_ID;
  decision: RawDataDenialPayload["decision"];
  guardClass: RawDataGuardClass;
  profileId: string;
  invocationId?: string;
  error: ErrorRecord;
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
  const protectedEvidencePaths = options.protectedEvidencePaths
    ? await canonicalizePathSet(options.protectedEvidencePaths)
    : [];
  const allowedWriteRoots = await canonicalizePathSet(options.allowedWriteRoots);
  const tempRoot = await canonicalizeExistingRootOutsideProtectedRaw(
    options.tempRoot ?? tmpdir(),
    protectedRawPaths,
    "seatbelt temp root"
  );
  const profileRoot = options.profileRoot
    ? await ensureDirectoryOutsideProtectedRaw(
        options.profileRoot,
        protectedRawPaths,
        "seatbelt profile root"
      )
    : undefined;

  const idInput = JSON.stringify({
    profileVersion: RAW_DATA_SANDBOX_PROFILE_VERSION,
    protectedRawPaths,
    protectedEvidencePaths,
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
    ...[...protectedRawPaths, ...protectedEvidencePaths].flatMap((protectedPath) => [
      `(deny file-write* (literal ${quoteSeatbeltString(protectedPath)}))`,
      `(deny file-write* (subpath ${quoteSeatbeltString(protectedPath)}))`
    ])
  ].join("\n");

  return {
    profileId,
    profileText,
    metadata: {
      profileVersion: RAW_DATA_SANDBOX_PROFILE_VERSION,
      profileId,
      protectedRawPaths,
      protectedEvidencePaths,
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
  const canonicalRoot = await ensureDirectoryOutsideProtectedRaw(
    root,
    profile.metadata.protectedRawPaths,
    "seatbelt profile root"
  );
  const runRoot = await mkdtemp(join(canonicalRoot, `${profile.profileId}-`));
  const profilePath = join(runRoot, rawDataSandboxProfileFileName(profile));
  await writeFile(profilePath, `${profile.profileText}\n`, { mode: 0o600, flag: "wx" });
  const metadata = await lstat(profilePath);
  if (!metadata.isFile()) {
    throw new Error(`Seatbelt profile path is not a regular file: ${profilePath}`);
  }
  return canonicalizeExistingPath(profilePath);
}

export class RawDataSandboxedBashTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  private readonly innerTool: BaseTool;

  constructor(private readonly options: RawDataSandboxedBashToolOptions) {
    super();
    if ("innerTool" in options && options.innerTool) {
      this.innerTool = options.innerTool;
    } else if ("fuseRules" in options && options.fuseRules) {
      this.innerTool = new BashTool([...options.fuseRules]);
    } else {
      throw new Error("RawDataSandboxedBashTool requires either innerTool or fuseRules.");
    }
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

    const protectedRawPaths = await canonicalizePathSet(this.options.protectedRawPaths);
    const auditReservation = await this.reserveAuditDir(ctx, protectedRawPaths);
    const profile = await buildRawDataSeatbeltProfile({
      protectedRawPaths,
      allowedWriteRoots: this.options.allowedWriteRoots,
      tempRoot: this.options.tempRoot,
      profileRoot: this.options.profileRoot,
      protectedEvidencePaths: [
        ...(this.options.protectedEvidencePaths ?? []),
        ...(auditReservation ? [auditReservation.auditDir] : [])
      ]
    });
    const profilePath = await writeRawDataSeatbeltProfileFile(profile, this.options.profileRoot);
    const protectedRawPathSignals = rawDataSignalPaths(
      this.options.protectedRawPaths,
      profile.metadata.protectedRawPaths
    );

    try {
      const suppressedDenial = evaluateSuppressedSandboxFailureGuard(
        command,
        protectedRawPathSignals
      );
      if (suppressedDenial.decision === "deny") {
        const evidence = buildRawDataDenialEvidence({
          toolId: this.name,
          decision: "denied_by_sandbox",
          reason: suppressedDenial.reason,
          profile,
          profilePath,
          invocationId: readInvocationId(ctx)
        });
        await this.appendDenialAudit(ctx, evidence, profile);
        return evidence.toolResult;
      }

      if (this.options.enableAdvisory !== false) {
        const advisory = evaluateRawDataWriteAdvisory(command, protectedRawPathSignals);
        if (advisory.decision === "deny") {
          const evidence = buildRawDataDenialEvidence({
            toolId: this.name,
            decision: "denied_by_advisory",
            reason: advisory.reason,
            profile,
            profilePath,
            invocationId: readInvocationId(ctx)
          });
          await this.appendDenialAudit(ctx, evidence, profile);
          return evidence.toolResult;
        }
      }

      const wrappedCommand = `sandbox-exec -f ${shellQuote(profilePath)} bash -c ${shellQuote(
        command
      )}`;
      const result = await this.innerTool.run(ctx, {
        ...(typeof input === "object" && input !== null ? input : {}),
        command: wrappedCommand
      });

      if (
        isLikelySandboxDenialForCommand(command, result.output, protectedRawPathSignals)
      ) {
        const evidence = buildRawDataDenialEvidence({
          toolId: this.name,
          decision: "denied_by_sandbox",
          reason: "raw data writes are blocked by the OS sandbox profile",
          profile,
          profilePath,
          underlyingOutput: result.output,
          invocationId: readInvocationId(ctx)
        });
        await this.appendDenialAudit(ctx, evidence, profile);
        return evidence.toolResult;
      }

      await this.appendAudit(ctx, {
        event: result.success ? "tool.completed" : "tool.failed",
        decision: result.success ? "allowed" : "failed",
        profile,
        profilePath
      });
      return result;
    } finally {
      await cleanupRawDataSeatbeltProfileFile(profilePath);
    }
  }

  private async appendDenialAudit(
    ctx: ToolContext,
    evidence: RawDataDenialEvidence,
    profile: RawDataSeatbeltProfile
  ): Promise<void> {
    try {
      await appendPolicyGateAuditRow({
        workspaceRoot: this.options.auditWorkspaceRoot ?? ctx.workDir,
        taskId: this.options.auditTaskId,
        protectedRawPaths: profile.metadata.protectedRawPaths,
        row: evidence.auditRow
      });
    } catch (error) {
      ctx.logger.warn("policy_gate_audit_append_failed", {
        tool: this.name,
        rule: evidence.payload.rule,
        decision: evidence.payload.decision,
        error: error instanceof Error ? error.message : String(error)
      });
    }
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
    try {
      await appendPolicyGateAuditRow({
        workspaceRoot,
        taskId: this.options.auditTaskId,
        protectedRawPaths: input.profile.metadata.protectedRawPaths,
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
    } catch (error) {
      ctx.logger.warn("policy_gate_audit_append_failed", {
        tool: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: input.decision,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async reserveAuditDir(
    ctx: ToolContext,
    protectedRawPaths: readonly string[]
  ): Promise<PolicyGateAuditReservation | undefined> {
    try {
      const auditDir = await ensurePolicyGateAuditDir(
        resolve(this.options.auditWorkspaceRoot ?? ctx.workDir),
        this.options.auditTaskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID,
        protectedRawPaths
      );
      return { auditDir };
    } catch (error) {
      ctx.logger.warn("policy_gate_audit_reserve_failed", {
        tool: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        error: error instanceof Error ? error.message : String(error)
      });
      return undefined;
    }
  }
}

interface PolicyGateAuditReservation {
  auditDir: string;
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
  const suppressedDenial = evaluateSuppressedSandboxFailureGuard(command, protectedRawPaths);
  if (suppressedDenial.decision === "deny") {
    return suppressedDenial;
  }

  if (hasStaticRawDataWrite(command, protectedRawPaths)) {
    return {
      decision: "deny",
      reason: "obvious static raw-data write target",
      remediation: rawDataWriteRemediation()
    };
  }

  return { decision: "allow" };
}

export function evaluateSuppressedSandboxFailureGuard(
  command: string,
  protectedRawPaths: readonly string[]
): PolicyRuleDecision {
  if (!canHideSandboxFailure(command)) {
    return { decision: "allow" };
  }

  if (
    !hasStaticRawDataWrite(command, protectedRawPaths) &&
    !hasDynamicRawDataWriteRisk(command)
  ) {
    return { decision: "allow" };
  }

  return {
    decision: "deny",
    reason: "raw-data write form can hide sandbox denial",
    remediation: rawDataWriteRemediation()
  };
}

export async function appendPolicyGateAuditRow(
  options: AppendPolicyGateAuditRowOptions
): Promise<string> {
  const taskId = options.taskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID;
  assertSafePathSegment(taskId, "audit task id");

  const fileName = options.fileName ?? DEFAULT_AUDIT_FILE_NAME;
  assertSafePathSegment(fileName, "audit file name");

  const auditDir = await ensurePolicyGateAuditDir(
    resolve(options.workspaceRoot),
    taskId,
    options.protectedRawPaths ?? []
  );
  const auditPath = join(auditDir, fileName);
  await appendAuditFileNoFollow(auditPath, `${JSON.stringify(options.row)}\n`);
  return auditPath;
}

export function buildRawDataDeniedPayload(input: {
  toolId: string;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
  invocationId?: string;
  ts?: string;
}): RawDataDenialPayload {
  const ts = input.ts ?? new Date().toISOString();
  const remediation = rawDataWriteRemediation();
  const guardClass = rawDataGuardClassForRawData();
  const errorId = [
    RAW_DATA_WRITE_RULE_ID,
    input.decision,
    input.profile.profileId,
    ...(input.invocationId ? [input.invocationId] : [])
  ].join(":");
  const message =
    input.decision === "denied_by_sandbox"
      ? "Raw data write denied by OS sandbox."
      : "Raw data write denied by advisory policy gate.";

  return {
    error: "raw_data_write_denied",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    decision: input.decision,
    guard_class: guardClass,
    reason: input.reason,
    remediation,
    profile_id: input.profile.profileId,
    ...(input.profilePath ? { profile_path: input.profilePath } : {}),
    ...(input.invocationId ? { invocation_id: input.invocationId } : {}),
    error_record: {
      error_id: errorId,
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

export function buildRawDataDenialEvidence(input: {
  toolId: string;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
  invocationId?: string;
  ts?: string;
}): RawDataDenialEvidence {
  const payload = buildRawDataDeniedPayload(input);
  const auditRow = rawDataDenialPayloadToAuditRow(payload, input.ts);
  const toolFailedEventInput = rawDataDenialPayloadToToolFailedEventInput(payload);
  const toolResult = {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Raw data write denied: ${input.reason}`
  };

  return {
    payload,
    toolResult,
    auditRow,
    toolFailedEventInput
  };
}

export function buildRawDataDeniedToolResult(input: {
  toolId: string;
  decision: "denied_by_advisory" | "denied_by_sandbox";
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
  invocationId?: string;
}): ToolResult {
  const payload = buildRawDataDeniedPayload(input);
  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: `Raw data write denied: ${input.reason}`
  };
}

export function rawDataDenialPayloadToAuditRow(
  payload: RawDataDenialPayload,
  ts = payload.error_record.created_at
): PolicyGateAuditRow {
  return {
    event: "tool.failed",
    tool_id: payload.tool_id,
    rule: payload.rule,
    decision: payload.decision,
    guard_class: payload.guard_class,
    ts,
    profile_id: payload.profile_id,
    ...(payload.profile_path ? { profile_path: payload.profile_path } : {}),
    error_id: payload.error_record.error_id,
    ...(payload.invocation_id ? { invocation_id: payload.invocation_id } : {}),
    remediation_next_action: payload.remediation.next_action,
    ...(payload.remediation.ref ? { remediation_ref: payload.remediation.ref } : {}),
    reason: payload.reason
  };
}

export function rawDataDenialPayloadToToolFailedEventInput(
  payload: RawDataDenialPayload
): RawDataToolFailedEventInput {
  return {
    toolId: payload.tool_id,
    rule: payload.rule,
    decision: payload.decision,
    guardClass: payload.guard_class,
    profileId: payload.profile_id,
    ...(payload.invocation_id ? { invocationId: payload.invocation_id } : {}),
    error: payload.error_record
  };
}

export async function scanProtectedHardlinks(input: {
  protectedRoots: readonly string[];
  maxScannedPathCount?: number;
}): Promise<HardlinkScanResult> {
  const protectedRoots = await canonicalizePathSet(input.protectedRoots);
  const maxScannedPathCount = input.maxScannedPathCount ?? 10_000;
  if (!Number.isInteger(maxScannedPathCount) || maxScannedPathCount < 1) {
    throw new Error(`Invalid hardlink scan budget: ${maxScannedPathCount}`);
  }

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
    if (scannedPathCount >= maxScannedPathCount) {
      throw new Error(`Protected hardlink scan exceeded budget: ${maxScannedPathCount}`);
    }

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

    const dir = await opendir(path);
    try {
      let entry = await dir.read();
      while (entry !== null) {
        if (scannedPathCount >= maxScannedPathCount) {
          throw new Error(`Protected hardlink scan exceeded budget: ${maxScannedPathCount}`);
        }
        await scanPath(join(path, entry.name));
        entry = await dir.read();
      }
    } finally {
      try {
        await Promise.resolve(dir.close());
      } catch {
        // Directory handles may already be closed after exhausting iteration.
      }
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

function hasStaticRawDataWrite(
  command: string,
  protectedRawPaths: readonly string[],
  options: { treatInitialRelativeRawAsProtected?: boolean } = {}
): boolean {
  const staticPathVariables = new Map<string, string>();
  let relativeRawPathsAmbiguous = options.treatInitialRelativeRawAsProtected === false;

  for (const segment of splitStaticShellSegments(command)) {
    const tokens = tokenizeStaticShellSegment(segment);
    if (tokens.length === 0) {
      continue;
    }

    collectStaticPathAssignments(tokens, staticPathVariables);
    const resolvedTokens = tokens.map((token) => resolveStaticPathToken(token, staticPathVariables));
    const commandName = normalizeCommandName(resolvedTokens[0]);

    if (isCwdChangingCommand(commandName)) {
      relativeRawPathsAmbiguous = true;
      continue;
    }

    const treatRelativeRawAsProtected = !relativeRawPathsAmbiguous;
    if (
      hasRawDataWriteRedirection(resolvedTokens, protectedRawPaths, {
        treatRelativeRawAsProtected
      })
    ) {
      return true;
    }

    if (
      (commandName === "bash" || commandName === "sh") &&
      hasChildShellRawDataWrite(resolvedTokens, protectedRawPaths, {
        treatRelativeRawAsProtected
      })
    ) {
      return true;
    }

    if (
      isInterpreterCommand(commandName) &&
      hasInterpreterRawDataWrite(resolvedTokens, protectedRawPaths, {
        treatRelativeRawAsProtected
      })
    ) {
      return true;
    }

    const operands = extractCommandOperands(resolvedTokens.slice(1));
    if (operands.length === 0) {
      continue;
    }

    if (commandName === "cp") {
      const destination = operands.at(-1);
      if (
        destination &&
        isRawDataPathToken(destination, protectedRawPaths, {
          treatRelativeRawAsProtected
        })
      ) {
        return true;
      }
      continue;
    }

    if (commandName === "dd") {
      if (
        operands.some((operand) => {
          const outputMatch = operand.match(/^of=(.+)$/);
          return (
            outputMatch !== null &&
            isRawDataPathToken(outputMatch[1], protectedRawPaths, {
              treatRelativeRawAsProtected
            })
          );
        })
      ) {
        return true;
      }
      continue;
    }

    if (commandName === "install" || commandName === "ln") {
      const destination = operands.at(-1);
      if (
        destination &&
        isRawDataPathToken(destination, protectedRawPaths, {
          treatRelativeRawAsProtected
        })
      ) {
        return true;
      }
      continue;
    }

    if (commandName === "mv") {
      if (
        operands.some((operand) =>
          isRawDataPathToken(operand, protectedRawPaths, {
            treatRelativeRawAsProtected
          })
        )
      ) {
        return true;
      }
      continue;
    }

    if (
      commandName === "tee" ||
      commandName === "touch" ||
      commandName === "mkdir" ||
      commandName === "truncate" ||
      commandName === "chmod" ||
      commandName === "chown" ||
      commandName === "chgrp" ||
      commandName === "xattr" ||
      commandName === "rm" ||
      commandName === "unlink"
    ) {
      if (
        operands.some((operand) =>
          isRawDataPathToken(operand, protectedRawPaths, {
            treatRelativeRawAsProtected
          })
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function collectStaticPathAssignments(tokens: readonly string[], bindings: Map<string, string>): void {
  for (const token of tokens) {
    const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
    if (!match) {
      continue;
    }
    const [, name, value] = match;
    if (/[`$*?[\]]/.test(value)) {
      continue;
    }
    bindings.set(name, value);
  }
}

function resolveStaticPathToken(token: string, bindings: ReadonlyMap<string, string>): string {
  const simpleVariable = token.match(/^\$([A-Za-z_][A-Za-z0-9_]*)$/);
  if (simpleVariable) {
    return bindings.get(simpleVariable[1]) ?? token;
  }

  const bracedVariable = token.match(/^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/);
  if (bracedVariable) {
    return bindings.get(bracedVariable[1]) ?? token;
  }

  return token;
}

function hasRawDataWriteRedirection(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      isWriteRedirectionToken(tokens[index]) &&
      isRawDataPathToken(tokens[index + 1], protectedRawPaths, options)
    ) {
      return true;
    }
  }

  return false;
}

function hasChildShellRawDataWrite(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "-c") {
      return hasStaticRawDataWrite(tokens[index + 1], protectedRawPaths, {
        treatInitialRelativeRawAsProtected: options.treatRelativeRawAsProtected !== false
      });
    }
  }

  return false;
}

function isInterpreterCommand(commandName: string): boolean {
  return /^(?:python(?:\d+(?:\.\d+)?)?|perl|ruby|node|bun)$/.test(commandName);
}

function hasInterpreterRawDataWrite(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  const payload = interpreterPayload(tokens);
  if (!payload) {
    return false;
  }

  if (!containsRawDataPathSignal(payload, protectedRawPaths, options)) {
    return false;
  }

  return hasInterpreterWriteApiSignal(payload);
}

function interpreterPayload(tokens: readonly string[]): string | undefined {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "-c" || tokens[index] === "-e") {
      return tokens[index + 1];
    }
  }

  return undefined;
}

function hasInterpreterWriteApiSignal(payload: string): boolean {
  return (
    /(?:^|[^\w.])open(?:Sync)?\s*\([^)]*["'`][waax+>][^"'`]*["'`]/.test(payload) ||
    /(?:^|[^\w])File\.open\s*\([^)]*["'`][waax+>][^"'`]*["'`]/.test(payload) ||
    /(?:fs\.)?(?:writeFile|appendFile)(?:Sync)?\s*\(/.test(payload) ||
    /(?:fs\.)?createWriteStream\s*\(/.test(payload) ||
    /(?:write_text|write_bytes)\s*\(/.test(payload) ||
    /(?:File|IO)\.write\s*\(/.test(payload)
  );
}

function isWriteRedirectionToken(token: string): boolean {
  return /^(?:\d*)?(?:>{1,2}|<>)$/.test(token);
}

function splitStaticShellSegments(command: string): string[] {
  const segments: string[] = [];
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;

  for (const char of command) {
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      current += char;
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      current += char;
      continue;
    }

    if (char === "'" || char === '"') {
      quote = char;
      current += char;
      continue;
    }

    if (char === ";" || char === "\n" || char === "|" || char === "&") {
      if (current.trim()) {
        segments.push(current.trim());
      }
      current = "";
      continue;
    }

    current += char;
  }

  if (current.trim()) {
    segments.push(current.trim());
  }

  return segments;
}

function tokenizeStaticShellSegment(segment: string): string[] {
  const tokens: string[] = [];
  let index = 0;

  while (index < segment.length) {
    while (index < segment.length && /\s/.test(segment[index])) {
      index += 1;
    }
    if (index >= segment.length) {
      break;
    }

    const descriptorRedirect = segment.slice(index).match(/^\d*(?:>>?|<>)/);
    if (descriptorRedirect) {
      tokens.push(descriptorRedirect[0]);
      index += descriptorRedirect[0].length;
      continue;
    }

    let token = "";
    let quote: "'" | '"' | undefined;
    let escaped = false;
    while (index < segment.length) {
      const char = segment[index];
      if (escaped) {
        token += char;
        escaped = false;
        index += 1;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        index += 1;
        continue;
      }

      if (quote) {
        if (char === quote) {
          quote = undefined;
          index += 1;
          continue;
        }
        token += char;
        index += 1;
        continue;
      }

      if (char === "'" || char === '"') {
        quote = char;
        index += 1;
        continue;
      }

      if (/\s/.test(char)) {
        break;
      }

      if (char === ">" || (char === "<" && segment[index + 1] === ">")) {
        break;
      }

      token += char;
      index += 1;
    }

    if (token.length > 0) {
      tokens.push(token);
    } else {
      index += 1;
    }
  }

  return tokens;
}

function normalizeCommandName(token: string): string {
  return basename(token);
}

function extractCommandOperands(tokens: readonly string[]): string[] {
  const operands: string[] = [];
  let afterOptionTerminator = false;

  for (const token of tokens) {
    if (token.length === 0) {
      continue;
    }
    if (!afterOptionTerminator && token === "--") {
      afterOptionTerminator = true;
      continue;
    }
    if (!afterOptionTerminator && token.startsWith("-")) {
      continue;
    }
    if (isWriteRedirectionToken(token)) {
      continue;
    }
    operands.push(token);
  }

  return operands;
}

function isRawDataPathToken(
  token: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  if (/[`$*?[\]]/.test(token)) {
    return false;
  }

  const cleaned = token.replace(/\/+$/, "");
  if (!cleaned) {
    return false;
  }

  const normalizedToken = normalize(cleaned);
  if (
    options.treatRelativeRawAsProtected !== false &&
    (normalizedToken === "data/raw" ||
      normalizedToken.startsWith("data/raw/") ||
      normalizedToken === "./data/raw" ||
      normalizedToken.startsWith("./data/raw/"))
  ) {
    return true;
  }

  if (!isAbsolute(cleaned)) {
    return false;
  }

  const absoluteToken = normalize(cleaned);
  return protectedRawPaths.some((protectedPath) => {
    const root = normalize(protectedPath).replace(/\/+$/, "");
    return absoluteToken === root || absoluteToken.startsWith(`${root}/`);
  });
}

function containsRawDataPathSignal(
  value: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  if (
    options.treatRelativeRawAsProtected !== false &&
    /(?:^|[\s"'`(=,:])(?:\.\.\/|\.\/)*data\/raw(?:\/|[\s"'`),:]|$)/.test(value)
  ) {
    return true;
  }

  return protectedRawPaths.some((protectedPath) => value.includes(protectedPath));
}

function hasDynamicRawDataWriteRisk(command: string): boolean {
  const rawCandidateVariables = collectDynamicRawPathVariables(command);
  if (rawCandidateVariables.size === 0) {
    return false;
  }

  let relativeRawPathsAmbiguous = false;
  for (const segment of splitStaticShellSegments(command)) {
    const tokens = tokenizeStaticShellSegment(segment);
    if (tokens.length === 0) {
      continue;
    }

    const commandName = normalizeCommandName(tokens[0]);
    if (isCwdChangingCommand(commandName)) {
      relativeRawPathsAmbiguous = true;
      continue;
    }

    if (relativeRawPathsAmbiguous) {
      continue;
    }

    if (hasRawCandidateVariableRedirection(tokens, rawCandidateVariables)) {
      return true;
    }

    const operands = extractCommandOperands(tokens.slice(1));
    if (operands.length === 0) {
      continue;
    }

    if (commandName === "cp") {
      const destination = operands.at(-1);
      if (destination && referencesAnyVariable(destination, rawCandidateVariables)) {
        return true;
      }
      continue;
    }

    if (commandName === "dd") {
      if (
        operands.some((operand) => {
          const outputMatch = operand.match(/^of=(.+)$/);
          return outputMatch !== null && referencesAnyVariable(outputMatch[1], rawCandidateVariables);
        })
      ) {
        return true;
      }
      continue;
    }

    if (commandName === "install" || commandName === "ln") {
      const destination = operands.at(-1);
      if (destination && referencesAnyVariable(destination, rawCandidateVariables)) {
        return true;
      }
      continue;
    }

    if (
      commandName === "mv" ||
      commandName === "tee" ||
      commandName === "touch" ||
      commandName === "mkdir" ||
      commandName === "truncate" ||
      commandName === "chmod" ||
      commandName === "chown" ||
      commandName === "chgrp" ||
      commandName === "xattr" ||
      commandName === "rm" ||
      commandName === "unlink"
    ) {
      if (operands.some((operand) => referencesAnyVariable(operand, rawCandidateVariables))) {
        return true;
      }
    }
  }

  return false;
}

function collectDynamicRawPathVariables(command: string): Set<string> {
  const assignments = collectShellPathAssignments(command);
  const values = new Map(assignments.map((assignment) => [assignment.name, assignment.value]));
  const dataVariables = new Set<string>();
  const rawVariables = new Set<string>();
  const rawCandidateVariables = new Set<string>();

  for (const [name, value] of values) {
    const normalized = normalize(value).replace(/\/+$/, "");
    if (normalized === "data" || normalized === "./data") {
      dataVariables.add(name);
    }
    if (normalized === "raw" || normalized === "./raw") {
      rawVariables.add(name);
    }
    if (containsRelativeRawLiteral(value)) {
      rawCandidateVariables.add(name);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const [name, value] of values) {
      if (rawCandidateVariables.has(name)) {
        continue;
      }
      const referencesRawCandidate = referencesAnyVariable(value, rawCandidateVariables);
      const referencesDataAndRaw =
        referencesAnyVariable(value, dataVariables) &&
        (referencesAnyVariable(value, rawVariables) || /(?:^|\/)raw(?:\/|$)/.test(value));

      if (referencesRawCandidate || referencesDataAndRaw) {
        rawCandidateVariables.add(name);
        changed = true;
      }
    }
  }

  return rawCandidateVariables;
}

function collectShellPathAssignments(command: string): { name: string; value: string }[] {
  const assignments: { name: string; value: string }[] = [];
  for (const segment of splitStaticShellSegments(command)) {
    for (const token of tokenizeStaticShellSegment(segment)) {
      const match = token.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.+)$/);
      if (match) {
        assignments.push({ name: match[1], value: match[2] });
      }
    }
  }
  return assignments;
}

function hasRawCandidateVariableRedirection(
  tokens: readonly string[],
  rawCandidateVariables: ReadonlySet<string>
): boolean {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      isWriteRedirectionToken(tokens[index]) &&
      referencesAnyVariable(tokens[index + 1], rawCandidateVariables)
    ) {
      return true;
    }
  }
  return false;
}

function containsRelativeRawLiteral(value: string): boolean {
  const normalized = normalize(value).replace(/\/+$/, "");
  return (
    normalized === "data/raw" ||
    normalized.startsWith("data/raw/") ||
    normalized === "./data/raw" ||
    normalized.startsWith("./data/raw/")
  );
}

function referencesAnyVariable(value: string, variables: ReadonlySet<string>): boolean {
  for (const variable of variables) {
    if (referencesVariable(value, variable)) {
      return true;
    }
  }
  return false;
}

function referencesVariable(value: string, variable: string): boolean {
  return new RegExp(`\\$(?:${escapeRegExp(variable)}\\b|\\{${escapeRegExp(variable)}\\})`).test(
    value
  );
}

function isCwdChangingCommand(commandName: string): boolean {
  return commandName === "cd" || commandName === "pushd" || commandName === "popd";
}

function canHideSandboxFailure(command: string): boolean {
  const stderrSuppressionPattern =
    /(?:^|[\s;&|])2\s*>{1,2}\s*\/dev\/null(?=[\s;|&)]|$)/g;
  const exitNormalizerPattern = /^\s*(?:\|\||;|\n|&)\s*true(?:\s|[;|&)]|$)/;
  let suppressionMatch: RegExpExecArray | null;

  while ((suppressionMatch = stderrSuppressionPattern.exec(command)) !== null) {
    const commandAfterSuppression = command.slice(
      suppressionMatch.index + suppressionMatch[0].length
    );
    if (exitNormalizerPattern.test(commandAfterSuppression)) {
      return true;
    }
  }

  return false;
}

function rawDataGuardClassForRawData(): RawDataGuardClass {
  return "authority";
}

function isLikelySandboxDenialForCommand(
  command: string,
  output: string,
  protectedRawPaths: readonly string[]
): boolean {
  const denialOutput =
    isLikelySandboxDenial(output) || INTERPRETER_WRITE_DENIAL_PATTERN.test(output);
  if (!denialOutput) {
    return false;
  }

  return (
    hasStaticRawDataWrite(command, protectedRawPaths) ||
    hasDynamicRawDataWriteRisk(command) ||
    hasRawWriteLiteralSignal(command, protectedRawPaths)
  );
}

function hasRawWriteLiteralSignal(command: string, protectedRawPaths: readonly string[]): boolean {
  const shellWriteSignal =
    /(?:^|[\s;&|])(?:cp|mv|tee|touch|mkdir|truncate|chmod|chown|chgrp|xattr|rm|unlink|dd|install|ln)\b|>/.test(
      command
    );
  const interpreterWriteSignal =
    /(?:^|[\s;&|])(?:python(?:\d+(?:\.\d+)?)?|perl|ruby|node|bun)\b/.test(command) &&
    hasInterpreterWriteApiSignal(command);
  if (!shellWriteSignal && !interpreterWriteSignal) {
    return false;
  }

  if (containsRawDataPathSignal(command, protectedRawPaths)) {
    return true;
  }

  return protectedRawPaths.some((protectedPath) => command.includes(protectedPath));
}

function readInvocationId(ctx: ToolContext): string | undefined {
  const id = (ctx as ToolContext & { currentToolUseId?: unknown }).currentToolUseId;
  return typeof id === "string" && id.length > 0 ? id : undefined;
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

function rawDataSignalPaths(
  inputPaths: readonly string[],
  canonicalPaths: readonly string[]
): string[] {
  return sortedUnique([
    ...canonicalPaths,
    ...inputPaths.map((path) => normalize(resolve(path)).replace(/\/+$/, ""))
  ]);
}

async function canonicalizeExistingRootOutsideProtectedRaw(
  path: string,
  protectedRawPaths: readonly string[],
  label: string
): Promise<string> {
  await assertRootOutsideProtectedRaw(path, protectedRawPaths, label);
  const canonical = await canonicalizeExistingPath(path);
  assertPathOutsideProtectedRaw(canonical, protectedRawPaths, label, "canonical");
  return canonical;
}

async function ensureDirectoryOutsideProtectedRaw(
  path: string,
  protectedRawPaths: readonly string[],
  label: string
): Promise<string> {
  const absolutePath = resolve(path);
  assertPathOutsideProtectedRaw(absolutePath, protectedRawPaths, label, "lexical");
  const parsedRoot = resolveRoot(absolutePath);
  let current = parsedRoot;

  for (const segment of absolutePath.slice(parsedRoot.length).split("/").filter(Boolean)) {
    current = join(current, segment);
    assertPathOutsideProtectedRaw(current, protectedRawPaths, label, "lexical");
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink()) {
        const canonical = await canonicalizeExistingPath(current);
        assertPathOutsideProtectedRaw(canonical, protectedRawPaths, label, "canonical");
        const canonicalMetadata = await lstat(canonical);
        if (!canonicalMetadata.isDirectory()) {
          throw new Error(`${label} path component is not a directory: ${current}`);
        }
        continue;
      }
      if (!metadata.isDirectory()) {
        throw new Error(`${label} path component is not a directory: ${current}`);
      }
    } catch (error) {
      if (!isErrno(error, "ENOENT")) {
        throw error;
      }
      await mkdir(current, { mode: 0o700 });
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new Error(`${label} path component is unsafe: ${current}`);
      }
    }

    const canonical = await canonicalizeExistingPath(current);
    assertPathOutsideProtectedRaw(canonical, protectedRawPaths, label, "canonical");
  }

  const canonicalPath = await canonicalizeExistingPath(absolutePath);
  assertPathOutsideProtectedRaw(canonicalPath, protectedRawPaths, label, "canonical");
  return canonicalPath;
}

async function assertRootOutsideProtectedRaw(
  path: string,
  protectedRawPaths: readonly string[],
  label: string
): Promise<void> {
  assertPathOutsideProtectedRaw(resolve(path), protectedRawPaths, label, "lexical");
  try {
    const canonical = await canonicalizeExistingPath(path);
    assertPathOutsideProtectedRaw(canonical, protectedRawPaths, label, "canonical");
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

function assertPathOutsideProtectedRaw(
  path: string,
  protectedRawPaths: readonly string[],
  label: string,
  mode: "lexical" | "canonical"
): void {
  const absolutePath = normalize(resolve(path)).replace(/\/+$/, "");
  for (const protectedRawPath of protectedRawPaths) {
    const rawRoot = normalize(resolve(protectedRawPath)).replace(/\/+$/, "");
    if (absolutePath === rawRoot || absolutePath.startsWith(`${rawRoot}/`)) {
      throw new Error(
        `${label} must not be inside protected raw data path (${mode}): ${path}`
      );
    }
  }
}

async function ensurePolicyGateAuditDir(
  workspaceRoot: string,
  taskId: string,
  protectedRawPaths: readonly string[] = []
): Promise<string> {
  const workspaceRealPath =
    protectedRawPaths.length > 0
      ? await ensureDirectoryOutsideProtectedRaw(
          workspaceRoot,
          protectedRawPaths,
          "policy gate audit workspace root"
        )
      : await ensureDirectory(workspaceRoot);
  let current = workspaceRealPath;

  for (const segment of ["workspace", "tasks", taskId, "audit"]) {
    current = join(current, segment);
    await ensureSafeAuditDirComponent(current, workspaceRealPath, protectedRawPaths);
  }

  return current;
}

async function ensureDirectory(path: string): Promise<string> {
  await mkdir(path, { recursive: true });
  return canonicalizeExistingPath(path);
}

async function ensureSafeAuditDirComponent(
  path: string,
  workspaceRealPath: string,
  protectedRawPaths: readonly string[]
): Promise<void> {
  assertPathOutsideProtectedRaw(path, protectedRawPaths, "policy gate audit path", "lexical");
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Policy gate audit path component must not be a symlink: ${path}`);
    }
    if (!metadata.isDirectory()) {
      throw new Error(`Policy gate audit path component is not a directory: ${path}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
    await mkdir(path, { mode: 0o700 });
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error(`Policy gate audit path component is unsafe: ${path}`);
    }
  }

  const componentRealPath = await canonicalizeExistingPath(path);
  assertPathOutsideProtectedRaw(
    componentRealPath,
    protectedRawPaths,
    "policy gate audit path",
    "canonical"
  );
  if (!isPathInsideOrEqual(componentRealPath, workspaceRealPath)) {
    throw new Error(`Policy gate audit path component escapes workspace root: ${path}`);
  }
}

async function appendAuditFileNoFollow(path: string, line: string): Promise<void> {
  await assertSafeAuditFileTarget(path);
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_APPEND |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile()) {
      throw new Error(`Policy gate audit target is not a regular file: ${path}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`Policy gate audit target must not be a hardlink: ${path}`);
    }
    await handle.writeFile(line, "utf8");
  } finally {
    await handle.close();
  }
}

async function assertSafeAuditFileTarget(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new Error(`Policy gate audit target must not be a symlink: ${path}`);
    }
    if (!metadata.isFile()) {
      throw new Error(`Policy gate audit target is not a regular file: ${path}`);
    }
    if (metadata.nlink > 1) {
      throw new Error(`Policy gate audit target must not be a hardlink: ${path}`);
    }
  } catch (error) {
    if (!isErrno(error, "ENOENT")) {
      throw error;
    }
  }
}

async function canonicalizeExistingPath(path: string): Promise<string> {
  return realpath(resolve(path));
}

async function cleanupRawDataSeatbeltProfileFile(profilePath: string): Promise<void> {
  await rm(dirname(profilePath), { recursive: true, force: true });
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

function isPathInsideOrEqual(path: string, root: string): boolean {
  const normalizedPath = normalize(resolve(path)).replace(/\/+$/, "");
  const normalizedRoot = normalize(resolve(root)).replace(/\/+$/, "");
  return normalizedPath === normalizedRoot || normalizedPath.startsWith(`${normalizedRoot}/`);
}

function resolveRoot(path: string): string {
  return parse(resolve(path)).root;
}

function isErrno(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === code
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function assertSafePathSegment(value: string, label: string): void {
  if (!/^[A-Za-z0-9._-]+$/.test(value) || value === "." || value === "..") {
    throw new Error(`Invalid ${label}: ${value}`);
  }
}

export function rawDataSandboxProfileFileName(profile: RawDataSeatbeltProfile): string {
  return `${basename(profile.profileId)}.sb`;
}
