import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  lstat,
  mkdir,
  mkdtemp,
  open,
  opendir,
  realpath,
  rm,
  writeFile
} from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize, parse, resolve } from "node:path";
import { BaseTool, BashTool, FuseListChecker } from "@zero-os/core";
import type {
  FuseRule,
  RunningToolTerminationCause,
  ToolContext,
  ToolResult
} from "@zero-os/shared";
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
const DEFAULT_SANDBOX_EXECUTABLE = "/usr/bin/sandbox-exec";
const DEFAULT_SANDBOX_BASH = "/bin/bash";
const SANDBOX_DENIAL_PATTERN = /Operation not permitted|Permission denied|sandbox/i;
const INTERPRETER_WRITE_DENIAL_PATTERN = /can't open file/i;
const PIPE_GRACE_MS = 1000;
const FORCE_KILL_GRACE_MS = 750;
const FORCE_KILL_SETTLE_MS = 75;
const DEFAULT_ABORT_MESSAGE = "Command aborted by user from Session Detail.";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
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
  protectedRawPaths: readonly string[];
  taskId?: string;
  fileName?: string;
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
  const protectedWriteDenyPaths = sortedUnique([
    ...protectedRawPaths,
    ...protectedEvidencePaths
  ]);
  const allowedWriteRoots = await canonicalizePathSet(options.allowedWriteRoots);
  const tempRoot = await ensureDirectoryOutsideProtectedRaw(
    options.tempRoot ?? tmpdir(),
    protectedWriteDenyPaths,
    "seatbelt temp root"
  );
  const profileRoot = options.profileRoot
    ? await ensureDirectoryOutsideProtectedRaw(
        options.profileRoot,
        protectedWriteDenyPaths,
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
  const protectedWriteDenyPaths = sortedUnique([
    ...profile.metadata.protectedRawPaths,
    ...profile.metadata.protectedEvidencePaths
  ]);
  const canonicalRoot = await ensureDirectoryOutsideProtectedRaw(
    root,
    protectedWriteDenyPaths,
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

  private readonly fuseChecker: FuseListChecker;

  constructor(private readonly options: RawDataSandboxedBashToolOptions) {
    super();
    let metadataTool: BaseTool;
    let fuseRules: readonly FuseRule[] = [];
    if ("innerTool" in options && options.innerTool) {
      metadataTool = options.innerTool;
    } else if ("fuseRules" in options && options.fuseRules) {
      fuseRules = options.fuseRules;
      metadataTool = new BashTool([]);
    } else {
      throw new Error("RawDataSandboxedBashTool requires either innerTool or fuseRules.");
    }
    this.fuseChecker = new FuseListChecker([...fuseRules]);
    this.name = options.toolId ?? metadataTool.name;
    this.description = metadataTool.description;
    this.parameters = metadataTool.parameters;
    this.kind = metadataTool.kind;
    this.requiredModelCapabilities = metadataTool.requiredModelCapabilities;
  }

  protected async fuseCheck(input: unknown): Promise<void> {
    const command = readBashCommand(input);
    if (command) {
      this.fuseChecker.check(command);
    }
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
    const auditReservation = await this.reserveAuditEvidence(ctx, protectedRawPaths);
    if ("toolResult" in auditReservation) {
      return auditReservation.toolResult;
    }

    let profilePath: string | undefined;
    try {
      const profile = await buildRawDataSeatbeltProfile({
        protectedRawPaths,
        allowedWriteRoots: this.options.allowedWriteRoots,
        tempRoot: this.options.tempRoot,
        profileRoot: this.options.profileRoot,
        protectedEvidencePaths: [
          ...(this.options.protectedEvidencePaths ?? []),
          auditReservation.protectedEvidencePath
        ]
      });
      profilePath = await writeRawDataSeatbeltProfileFile(profile, this.options.profileRoot);
      const protectedRawPathSignals = rawDataSignalPaths(
        this.options.protectedRawPaths,
        profile.metadata.protectedRawPaths
      );

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
        const appendFailure = await this.appendDenialAudit(ctx, auditReservation, evidence);
        if (appendFailure) {
          return appendFailure;
        }
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
          const appendFailure = await this.appendDenialAudit(ctx, auditReservation, evidence);
          if (appendFailure) {
            return appendFailure;
          }
          return evidence.toolResult;
        }
      }

      const result = await runSeatbeltSandboxedBash(ctx, {
        ...(typeof input === "object" && input !== null ? input : {}),
        command,
        profilePath,
        sandboxExecutable: DEFAULT_SANDBOX_EXECUTABLE,
        bashExecutable: DEFAULT_SANDBOX_BASH
      });

      if (isLikelySandboxDenialForCommand(command, result, protectedRawPathSignals)) {
        const evidence = buildRawDataDenialEvidence({
          toolId: this.name,
          decision: "denied_by_sandbox",
          reason: "raw data writes are blocked by the OS sandbox profile",
          profile,
          profilePath,
          underlyingOutput: result.output,
          invocationId: readInvocationId(ctx)
        });
        const appendFailure = await this.appendDenialAudit(ctx, auditReservation, evidence);
        if (appendFailure) {
          return appendFailure;
        }
        return evidence.toolResult;
      }

      await this.appendAudit(ctx, auditReservation, {
        event: result.success ? "tool.completed" : "tool.failed",
        decision: result.success ? "allowed" : "failed",
        profile,
        profilePath
      });
      return normalizeSandboxedBashResult(result, command, profilePath);
    } finally {
      await closePolicyGateAuditReservation(auditReservation);
      if (profilePath) {
        await cleanupRawDataSeatbeltProfileFile(profilePath);
      }
    }
  }

  private async appendDenialAudit(
    ctx: ToolContext,
    reservation: PolicyGateAuditReservation,
    evidence: RawDataDenialEvidence,
  ): Promise<ToolResult | undefined> {
    try {
      await appendReservedPolicyGateAuditRow(reservation, evidence.auditRow);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error("policy_gate_audit_append_failed", {
        tool: this.name,
        rule: evidence.payload.rule,
        decision: evidence.payload.decision,
        error: message
      });
      return buildAuditReservationFailureResult({
        toolId: this.name,
        reason: `Policy gate denial audit evidence could not be persisted: ${message}`
      });
    }
  }

  private async appendAudit(
    ctx: ToolContext,
    reservation: PolicyGateAuditReservation,
    input: {
      event: string;
      decision: string;
      profile: RawDataSeatbeltProfile;
      profilePath: string;
    }
  ): Promise<void> {
    try {
      await appendReservedPolicyGateAuditRow(
        reservation,
        {
          event: input.event,
          tool_id: this.name,
          rule: RAW_DATA_WRITE_RULE_ID,
          decision: input.decision,
          ts: new Date().toISOString(),
          profile_id: input.profile.profileId,
          profile_path: input.profilePath
        }
      );
    } catch (error) {
      ctx.logger.warn("policy_gate_audit_append_failed", {
        tool: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: input.decision,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  private async reserveAuditEvidence(
    ctx: ToolContext,
    protectedRawPaths: readonly string[]
  ): Promise<PolicyGateAuditReservation | PolicyGateAuditReservationFailure> {
    try {
      return await ensurePolicyGateAuditReservation(
        resolve(this.options.auditWorkspaceRoot ?? ctx.workDir),
        this.options.auditTaskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID,
        DEFAULT_AUDIT_FILE_NAME,
        protectedRawPaths
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.warn("policy_gate_audit_reserve_failed", {
        tool: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        error: message
      });
      return {
        toolResult: buildAuditReservationFailureResult({
          toolId: this.name,
          reason: `Policy gate audit evidence path is unavailable: ${message}`
        })
      };
    }
  }
}

interface PolicyGateAuditReservation {
  auditDir: string;
  auditPath: string;
  protectedEvidencePath: string;
  handle: FileHandle;
  dev: number;
  ino: number;
}

interface PolicyGateAuditReservationFailure {
  toolResult: ToolResult;
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
  if (hasInterpreterInternalRawWriteSuppressionRisk(command, protectedRawPaths)) {
    return {
      decision: "deny",
      reason: "raw-data write form can hide sandbox denial",
      remediation: rawDataWriteRemediation()
    };
  }

  if (!canHideSandboxFailure(command)) {
    return { decision: "allow" };
  }

  if (!hasKnownRawDataWriteTarget(command, protectedRawPaths)) {
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
  assertProtectedRawPathsProvided(options.protectedRawPaths);
  const taskId = options.taskId ?? DEFAULT_POLICY_GATE_AUDIT_TASK_ID;
  assertSafePathSegment(taskId, "audit task id");

  const fileName = options.fileName ?? DEFAULT_AUDIT_FILE_NAME;
  assertSafePathSegment(fileName, "audit file name");

  const reservation = await ensurePolicyGateAuditReservation(
    resolve(options.workspaceRoot),
    taskId,
    fileName,
    options.protectedRawPaths
  );
  try {
    await appendReservedPolicyGateAuditRow(reservation, options.row);
    return reservation.auditPath;
  } finally {
    await closePolicyGateAuditReservation(reservation);
  }
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

function buildAuditReservationFailureResult(input: {
  toolId: string;
  reason: string;
}): ToolResult {
  const payload = {
    error: "policy_gate_audit_unavailable",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    reason: input.reason,
    remediation: {
      next_action: "fix_and_retry",
      hint: "Repair the policy-gate audit path before running bash so denial evidence can be recorded.",
      ref: RAW_DATA_POLICY_REF
    }
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: "Policy gate audit unavailable before bash execution"
  };
}

interface SandboxedBashInput {
  command: string;
  timeout?: number;
  envSecrets?: Record<string, string>;
  stdinSecretRef?: string;
  stdinAppendNewline?: boolean;
  profilePath: string;
  sandboxExecutable: string;
  bashExecutable: string;
}

interface ResolvedBashSecret {
  ref: string;
  value: string;
  envName?: string;
}

type BashSecretResolution =
  | { success: true; env: Record<string, string>; stdin?: string; secrets: ResolvedBashSecret[] }
  | { success: false; result: ToolResult };

async function runSeatbeltSandboxedBash(
  ctx: ToolContext,
  input: SandboxedBashInput
): Promise<ToolResult> {
  const { command, timeout = 120_000 } = input;
  const resolvedExecutables = await verifySeatbeltExecutables(input);
  if (!resolvedExecutables.success) {
    return resolvedExecutables.result;
  }

  const resolvedSecrets = resolveBashSecretInputs(ctx, input);
  if (!resolvedSecrets.success) {
    return resolvedSecrets.result;
  }

  const usesSecretRefs = resolvedSecrets.secrets.length > 0;
  const summaryCommand = commandLabel(command, usesSecretRefs);
  const leakedSecret = resolvedSecrets.secrets.find(
    (secret) => secret.value.length >= 4 && command.includes(secret.value)
  );
  if (leakedSecret) {
    return {
      success: false,
      output:
        "Command contains a resolved secret value. Use envSecrets variables or stdinSecretRef instead.",
      outputSummary: "Command rejected: secret value in command"
    };
  }

  const toolUseId = ctx.currentToolUseId;
  const runningHandle =
    toolUseId && ctx.runningToolRegistry ? ctx.runningToolRegistry.get(toolUseId) : undefined;

  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn(
      [
        resolvedExecutables.sandboxExecutable,
        "-f",
        input.profilePath,
        resolvedExecutables.bashExecutable,
        "-c",
        command
      ],
      {
        cwd: ctx.workDir,
        stdin: resolvedSecrets.stdin === undefined ? "ignore" : "pipe",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
        env: {
          ...buildSanitizedToolProcessEnv(ctx),
          ...resolvedSecrets.env
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    runningHandle?.markFinished({
      finishedAt: new Date().toISOString(),
      cause: "spawn_error",
      success: false,
      outputSummary: `Spawn failed: ${message.slice(0, 80)}`
    });
    return {
      success: false,
      output: message,
      outputSummary: `Spawn failed: ${message.slice(0, 80)}`
    };
  }

  const stdoutCapture = createStreamCapture(proc.stdout);
  const stderrCapture = createStreamCapture(proc.stderr);
  let stdinWriteError: string | undefined;
  const stdinWrite =
    resolvedSecrets.stdin === undefined
      ? undefined
      : writeProcessStdin(proc, resolvedSecrets.stdin).catch((error) => {
          stdinWriteError = error instanceof Error ? error.message : String(error);
          tryKillProcess(proc, "SIGTERM");
        });
  let terminationCause: RunningToolTerminationCause | undefined;
  let abortMessage: string | undefined;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;

  const markFinished = (
    cause: RunningToolTerminationCause,
    success: boolean,
    outputSummary?: string
  ) => {
    runningHandle?.markFinished({
      finishedAt: new Date().toISOString(),
      cause,
      success,
      outputSummary
    });
  };

  const latchTerminationCause = (cause: RunningToolTerminationCause) => {
    if (terminationCause) {
      return false;
    }
    terminationCause = cause;
    return true;
  };

  const scheduleForceKill = () => {
    forceKillTimer = setTimeout(() => {
      tryKillProcess(proc, "SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  };

  runningHandle?.setAbortHandler((reason) => {
    abortMessage = reason?.trim() || DEFAULT_ABORT_MESSAGE;
    if (!latchTerminationCause("abort")) {
      return;
    }
    tryKillProcess(proc, "SIGTERM");
    scheduleForceKill();
  });

  const timeoutId = setTimeout(() => {
    if (!latchTerminationCause("timeout")) {
      return;
    }
    markFinished("timeout", false, `Command timed out: ${summaryCommand}`);
    tryKillProcess(proc, "SIGTERM");
    scheduleForceKill();
  }, timeout);

  const exitCode = await proc.exited;
  if (stdinWrite) {
    await stdinWrite;
  }
  clearTimeout(timeoutId);
  if (forceKillTimer) {
    clearTimeout(forceKillTimer);
  }
  if (terminationCause === "timeout" || terminationCause === "abort") {
    await forceKillProcessGroup(proc);
  }

  const finalCause = terminationCause ?? "completed";
  if (finalCause === "abort") {
    markFinished("abort", false, `Command aborted: ${summaryCommand}`);
  } else if (finalCause === "completed") {
    markFinished("completed", exitCode === 0, undefined);
  }

  const streamDrain = Promise.allSettled([stdoutCapture.done, stderrCapture.done]);
  const drainResult = await Promise.race([
    streamDrain.then(() => "drained" as const),
    Bun.sleep(PIPE_GRACE_MS).then(() => "timeout" as const)
  ]);
  if (drainResult === "timeout") {
    await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()]);
  }

  const output = buildBashOutput(
    stdoutCapture.getText(),
    stderrCapture.getText(),
    finalCause === "abort" ? abortMessage ?? DEFAULT_ABORT_MESSAGE : undefined
  );

  const result = buildSandboxedBashResult({
    output,
    exitCode,
    finalCause,
    stdinWriteError,
    summaryCommand
  });
  return filterToolResultSecrets(ctx, result);
}

function buildSandboxedBashResult(input: {
  output: string;
  exitCode: number;
  finalCause: RunningToolTerminationCause;
  stdinWriteError?: string;
  summaryCommand: string;
}): ToolResult {
  if (input.finalCause === "abort") {
    return {
      success: false,
      output: input.output,
      outputSummary: `Command aborted: ${input.summaryCommand}`
    };
  }

  if (input.stdinWriteError) {
    return {
      success: false,
      output: `Failed to write stdin secret: ${input.stdinWriteError}\n\n${input.output}`,
      outputSummary: "Failed to write stdin secret"
    };
  }

  if (input.exitCode !== 0 || input.finalCause === "timeout") {
    return {
      success: false,
      output: input.output || formatExitCode(input.exitCode),
      outputSummary: `Command failed (exit ${input.exitCode}): ${input.summaryCommand}`
    };
  }

  return {
    success: true,
    output: input.output,
    outputSummary: `Executed: ${input.summaryCommand}`
  };
}

async function verifySeatbeltExecutables(input: {
  sandboxExecutable: string;
  bashExecutable: string;
}): Promise<
  | { success: true; sandboxExecutable: string; bashExecutable: string }
  | { success: false; result: ToolResult }
> {
  try {
    const sandboxExecutable = await verifyExecutable(input.sandboxExecutable, "sandbox-exec");
    const bashExecutable = await verifyExecutable(input.bashExecutable, "bash");
    return { success: true, sandboxExecutable, bashExecutable };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      success: false,
      result: {
        success: false,
        output: message,
        outputSummary: `Spawn failed: ${message.slice(0, 80)}`
      }
    };
  }
}

async function verifyExecutable(path: string, label: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new Error(`${label} executable must be absolute: ${path}`);
  }
  await access(path, fsConstants.X_OK);
  const canonical = await canonicalizeExistingPath(path);
  await access(canonical, fsConstants.X_OK);
  return canonical;
}

function resolveBashSecretInputs(
  ctx: ToolContext,
  input: Pick<SandboxedBashInput, "envSecrets" | "stdinSecretRef" | "stdinAppendNewline">
): BashSecretResolution {
  if (!hasSecretInput(input)) {
    return { success: true, env: {}, secrets: [] };
  }

  if (!ctx.secretResolver) {
    return {
      success: false,
      result: {
        success: false,
        output: "Secret references require a secretResolver in the tool context",
        outputSummary: "No secret resolver"
      }
    };
  }

  if (!ctx.secretFilter) {
    return {
      success: false,
      result: {
        success: false,
        output: "Secret references require a secretFilter in the tool context",
        outputSummary: "No secret filter"
      }
    };
  }

  const env: Record<string, string> = {};
  const secrets: ResolvedBashSecret[] = [];

  for (const [envName, ref] of Object.entries(input.envSecrets ?? {})) {
    if (!ENV_NAME_PATTERN.test(envName)) {
      return {
        success: false,
        result: {
          success: false,
          output: `Invalid environment variable name for envSecrets: ${envName}`,
          outputSummary: "Invalid secret env name"
        }
      };
    }
    if (isShellPreludeEnvName(envName)) {
      return {
        success: false,
        result: {
          success: false,
          output: `Shell prelude environment variable is not allowed in envSecrets: ${envName}`,
          outputSummary: "Invalid secret env name"
        }
      };
    }
    if (typeof ref !== "string") {
      return {
        success: false,
        result: {
          success: false,
          output: `Secret reference for ${envName} must be a string`,
          outputSummary: "Invalid secret reference"
        }
      };
    }

    const resolved = resolveBashSecret(ctx, ref);
    if (!resolved.success) {
      return resolved;
    }

    env[envName] = resolved.value;
    secrets.push({ ref: ref.trim(), value: resolved.value, envName });
  }

  let stdin: string | undefined;
  if (input.stdinSecretRef) {
    const resolved = resolveBashSecret(ctx, input.stdinSecretRef);
    if (!resolved.success) {
      return resolved;
    }

    stdin = input.stdinAppendNewline === false ? resolved.value : `${resolved.value}\n`;
    secrets.push({ ref: input.stdinSecretRef.trim(), value: resolved.value });
  }

  return { success: true, env, stdin, secrets };
}

function hasSecretInput(
  input: Pick<SandboxedBashInput, "envSecrets" | "stdinSecretRef">
): boolean {
  return (
    (input.envSecrets && Object.keys(input.envSecrets).length > 0) ||
    Boolean(input.stdinSecretRef)
  );
}

function resolveBashSecret(
  ctx: ToolContext,
  ref: string
): { success: true; value: string } | { success: false; result: ToolResult } {
  const trimmedRef = ref.trim();
  if (!trimmedRef) {
    return {
      success: false,
      result: {
        success: false,
        output: "Secret reference cannot be empty",
        outputSummary: "Empty secret reference"
      }
    };
  }

  const value = ctx.secretResolver?.(trimmedRef);
  if (!value) {
    return {
      success: false,
      result: {
        success: false,
        output: `Secret reference "${trimmedRef}" not found in vault`,
        outputSummary: "Secret reference not found"
      }
    };
  }

  ctx.secretFilter?.addSecret(trimmedRef, value);
  return { success: true, value };
}

function buildSanitizedToolProcessEnv(ctx: ToolContext): Record<string, string> {
  const env = Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined)
  );

  for (const key of Object.keys(env)) {
    if (isShellPreludeEnvName(key)) {
      delete env[key];
    }
  }

  env.ZERO_WORKSPACE = ctx.workDir;
  env.ZERO_PROJECT_ROOT = ctx.projectRoot ?? process.cwd();
  env.ZERO_SESSION_ID = ctx.sessionId;

  if (ctx.channelBinding?.channelName) {
    env.ZERO_CHANNEL_NAME = ctx.channelBinding.channelName;
  }

  if (ctx.channelBinding?.channelId) {
    env.ZERO_CHANNEL_ID = ctx.channelBinding.channelId;
  }

  return env;
}

function isShellPreludeEnvName(name: string): boolean {
  return name === "BASH_ENV" || name === "ENV" || name.startsWith("BASH_FUNC_");
}

function commandLabel(command: string, usesSecretRefs: boolean): string {
  return usesSecretRefs ? "command with secret references" : command.slice(0, 80);
}

function formatExitCode(exitCode: number): string {
  return `Exit code: ${exitCode}`;
}

function buildBashOutput(stdout: string, stderr: string, abortMessage?: string): string {
  const trimmedStdout = stdout.trimEnd();
  const trimmedStderr = stderr.trimEnd();

  let output = trimmedStdout;
  if (trimmedStderr) {
    output = output ? `${output}\n[stderr]\n${trimmedStderr}` : `[stderr]\n${trimmedStderr}`;
  }
  if (!output) {
    output = "(no output)";
  }

  if (abortMessage) {
    output = `${output}\n\n[abort]\n${abortMessage}`;
  }

  return output;
}

function createStreamCapture(stream?: ReadableStream<Uint8Array> | number | null) {
  if (!stream || typeof stream === "number") {
    return {
      done: Promise.resolve(),
      cancel: async () => {},
      getText: () => ""
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let flushed = false;

  const flushDecoder = () => {
    if (flushed) {
      return;
    }
    const tail = decoder.decode();
    if (tail) {
      chunks.push(tail);
    }
    flushed = true;
  };

  const done = (async () => {
    try {
      while (true) {
        const { value, done: streamDone } = await reader.read();
        if (streamDone) {
          break;
        }
        if (value) {
          chunks.push(decoder.decode(value, { stream: true }));
        }
      }
    } catch {
      // Best effort: cancellation and subprocess teardown can end the stream abruptly.
    } finally {
      flushDecoder();
    }
  })();

  return {
    done,
    cancel: async () => {
      try {
        await reader.cancel();
      } catch {
        // Ignore cancellation races.
      } finally {
        flushDecoder();
      }
    },
    getText: () => {
      flushDecoder();
      return chunks.join("");
    }
  };
}

function tryKillProcess(proc: ReturnType<typeof Bun.spawn>, signal?: NodeJS.Signals): void {
  const pid = typeof proc.pid === "number" ? proc.pid : undefined;
  if (pid && process.platform !== "win32") {
    try {
      process.kill(-pid, signal ?? "SIGTERM");
      return;
    } catch {
      // Fall back to the direct subprocess handle below.
    }
  }

  try {
    signal ? proc.kill(signal) : proc.kill();
  } catch {
    // Ignore cases where the process already exited.
  }
}

async function forceKillProcessGroup(proc: ReturnType<typeof Bun.spawn>): Promise<void> {
  tryKillProcess(proc, "SIGKILL");
  await Bun.sleep(FORCE_KILL_SETTLE_MS);
}

function isWebWritableStream(stream: unknown): stream is WritableStream<Uint8Array> {
  return (
    typeof stream === "object" &&
    stream !== null &&
    "getWriter" in stream &&
    typeof stream.getWriter === "function"
  );
}

function isFileSinkLike(
  stream: unknown
): stream is { write(data: string): unknown; flush?: () => unknown; end(): unknown } {
  return (
    typeof stream === "object" &&
    stream !== null &&
    "write" in stream &&
    typeof stream.write === "function" &&
    "end" in stream &&
    typeof stream.end === "function"
  );
}

async function writeProcessStdin(proc: ReturnType<typeof Bun.spawn>, text: string): Promise<void> {
  const stdin: unknown = proc.stdin;
  if (!stdin || typeof stdin === "number") {
    throw new Error("Subprocess stdin is unavailable");
  }

  if (isWebWritableStream(stdin)) {
    const writer = stdin.getWriter();
    try {
      await writer.write(new TextEncoder().encode(text));
    } finally {
      await writer.close();
    }
    return;
  }

  if (isFileSinkLike(stdin)) {
    stdin.write(text);
    if (stdin.flush) {
      await Promise.resolve(stdin.flush());
    }
    stdin.end();
    return;
  }

  throw new Error("Subprocess stdin does not support writing");
}

function filterToolResultSecrets(ctx: ToolContext, result: ToolResult): ToolResult {
  if (!ctx.secretFilter) {
    return result;
  }

  return {
    ...result,
    output: ctx.secretFilter.filter(result.output),
    outputSummary: ctx.secretFilter.filter(result.outputSummary),
    contentItems: result.contentItems?.map((item) =>
      item.type === "text" ? { ...item, text: ctx.secretFilter!.filter(item.text) } : item
    )
  };
}

function normalizeSandboxedBashResult(
  result: ToolResult,
  command: string,
  profilePath: string
): ToolResult {
  if (
    !result.outputSummary.includes("sandbox-exec") &&
    !result.outputSummary.includes(profilePath)
  ) {
    return result;
  }

  return {
    ...result,
    outputSummary: result.success
      ? `Executed: ${commandSummary(command)}`
      : `Command failed: ${commandSummary(command)}`
  };
}

function commandSummary(command: string): string {
  return command.slice(0, 80);
}

function hasStaticRawDataWrite(
  command: string,
  protectedRawPaths: readonly string[],
  options: { treatInitialRelativeRawAsProtected?: boolean } = {}
): boolean {
  const staticPathVariables = new Map<string, string>();
  let relativeRawPathsAmbiguous = options.treatInitialRelativeRawAsProtected === false;

  for (const segment of splitStaticShellSegments(command)) {
    const tokens = effectiveShellTokens(tokenizeStaticShellSegment(segment));
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

    if (
      (commandName === "sed" || commandName === "perl") &&
      hasInPlaceMutationFlag(resolvedTokens) &&
      operands.some((operand) =>
        isRawDataPathToken(operand, protectedRawPaths, {
          treatRelativeRawAsProtected
        })
      )
    ) {
      return true;
    }

    if (
      commandName === "awk" &&
      resolvedTokens
        .slice(1)
        .some((token) => hasAwkRawWriteTarget(token, protectedRawPaths, { treatRelativeRawAsProtected }))
    ) {
      return true;
    }

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
  return /^(?:python(?:\d+(?:\.\d+)?)?|perl|ruby|node|bun|R|Rscript)$/.test(commandName);
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

  return hasInterpreterRawWriteTarget(payload, protectedRawPaths, options);
}

function interpreterPayload(tokens: readonly string[]): string | undefined {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "-c" || tokens[index] === "-e") {
      return tokens[index + 1];
    }
  }

  return undefined;
}

function hasInterpreterRawWriteTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  return (
    hasCallWithRawTargetArgument(payload, /\b(?:writeFile|appendFile)(?:Sync)?/, [0], protectedRawPaths, options) ||
    hasCallWithRawTargetArgument(payload, /\bcreateWriteStream/, [0], protectedRawPaths, options) ||
    hasCallWithRawTargetArgument(payload, /\b(?:File|IO)\.write/, [0], protectedRawPaths, options) ||
    hasOpenCallWithRawWriteTarget(payload, protectedRawPaths, options) ||
    hasPathWriteMethodRawTarget(payload, protectedRawPaths, options) ||
    hasRWriteHelperRawTarget(payload, protectedRawPaths, options)
  );
}

function hasCallWithRawTargetArgument(
  payload: string,
  calleePattern: RegExp,
  argumentIndexes: readonly number[],
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  for (const argsText of findCallArgumentLists(payload, calleePattern)) {
    const args = splitTopLevelArguments(argsText);
    if (
      argumentIndexes.some((index) =>
        args[index] ? isRawDataTargetExpression(args[index], protectedRawPaths, options) : false
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasOpenCallWithRawWriteTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  for (const argsText of findCallArgumentLists(payload, /\b(?:File\.)?open(?:Sync)?/)) {
    const args = splitTopLevelArguments(argsText);
    if (
      args[0] &&
      isRawDataTargetExpression(args[0], protectedRawPaths, options) &&
      args[1] &&
      isWriteModeExpression(args[1])
    ) {
      return true;
    }
    if (
      args[2] &&
      isRawDataTargetExpression(args[2], protectedRawPaths, options) &&
      args[1] &&
      isWriteModeExpression(args[1])
    ) {
      return true;
    }
  }
  return false;
}

function hasPathWriteMethodRawTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  const methodPattern = /\.(?:write_text|write_bytes)\s*\(/g;
  let match = methodPattern.exec(payload);
  while (match) {
    const receiver = extractReceiverExpressionBefore(payload, match.index);
    if (receiver && isRawDataTargetExpression(receiver, protectedRawPaths, options)) {
      return true;
    }
    match = methodPattern.exec(payload);
  }
  return false;
}

function hasRWriteHelperRawTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  const helpers: readonly {
    callee: RegExp;
    positionalIndexes: readonly number[];
    namedArguments: readonly string[];
  }[] = [
    { callee: /\bwrite\.(?:csv|table)/, positionalIndexes: [1], namedArguments: ["file"] },
    { callee: /\bwriteLines/, positionalIndexes: [1], namedArguments: ["con", "file"] },
    { callee: /\bsaveRDS/, positionalIndexes: [1], namedArguments: ["file"] },
    { callee: /\bsave/, positionalIndexes: [], namedArguments: ["file"] },
    { callee: /\bsink/, positionalIndexes: [0], namedArguments: ["file"] }
  ];

  for (const helper of helpers) {
    for (const argsText of findCallArgumentLists(payload, helper.callee)) {
      const args = splitTopLevelArguments(argsText);
      if (
        helper.positionalIndexes.some((index) =>
          args[index] ? isRawDataTargetExpression(args[index], protectedRawPaths, options) : false
        )
      ) {
        return true;
      }
      for (const name of helper.namedArguments) {
        const namedValue = findNamedArgument(args, name);
        if (namedValue && isRawDataTargetExpression(namedValue, protectedRawPaths, options)) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasAwkRawWriteTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  const writeTargetPattern = />\s*(["'`][^"'`]+["'`])/g;
  let match = writeTargetPattern.exec(payload);
  while (match) {
    if (isRawDataTargetExpression(match[1], protectedRawPaths, options)) {
      return true;
    }
    match = writeTargetPattern.exec(payload);
  }
  return false;
}

function hasInterpreterInternalRawWriteSuppressionRisk(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  for (const segment of splitStaticShellSegments(command)) {
    const tokens = effectiveShellTokens(tokenizeStaticShellSegment(segment));
    if (tokens.length === 0) {
      continue;
    }

    const commandName = normalizeCommandName(tokens[0]);
    if (!isInterpreterCommand(commandName)) {
      continue;
    }

    const payload = interpreterPayload(tokens);
    if (!payload) {
      continue;
    }

    if (
      hasInterpreterRawWriteTarget(payload, protectedRawPaths) &&
      hasInterpreterExceptionSwallowSignal(payload)
    ) {
      return true;
    }
  }

  return false;
}

function hasInterpreterExceptionSwallowSignal(payload: string): boolean {
  return (
    /try\s*{[\s\S]*}\s*catch(?:\s*\([^)]*\))?\s*{\s*}/.test(payload) ||
    /try\s*{[\s\S]*}\s*catch\b/.test(payload) ||
    /\bexcept\b[\s\S]*(?:\bpass\b|sys\.exit\s*\(\s*0\s*\)|exit\s*\(?\s*0\s*\)?)/.test(payload) ||
    /\brescue\b[\s\S]*(?:nil|true|$)/.test(payload) ||
    /\beval\s*{[\s\S]*}/.test(payload)
  );
}

function findCallArgumentLists(payload: string, calleePattern: RegExp): string[] {
  const flags = calleePattern.flags.includes("g")
    ? calleePattern.flags
    : `${calleePattern.flags}g`;
  const regex = new RegExp(`${calleePattern.source}\\s*\\(`, flags);
  const calls: string[] = [];
  let match = regex.exec(payload);
  while (match) {
    const openIndex = regex.lastIndex - 1;
    const closeIndex = findMatchingRightParen(payload, openIndex);
    const endIndex = closeIndex ?? payload.length;
    calls.push(payload.slice(openIndex + 1, endIndex));
    regex.lastIndex = endIndex + 1;
    match = regex.exec(payload);
  }
  return calls;
}

function findMatchingRightParen(value: string, openIndex: number): number | undefined {
  let depth = 0;
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;

  for (let index = openIndex; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      continue;
    }
    if (char === "(") {
      depth += 1;
      continue;
    }
    if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        return index;
      }
    }
  }

  return undefined;
}

function splitTopLevelArguments(argsText: string): string[] {
  const args: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let depth = 0;

  for (const char of argsText) {
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
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "(" || char === "[" || char === "{") {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "]" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (char === "," && depth === 0) {
      args.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim() || argsText.trim()) {
    args.push(current.trim());
  }

  return args;
}

function findNamedArgument(args: readonly string[], name: string): string | undefined {
  const pattern = new RegExp(`^${escapeRegExp(name)}\\s*=\\s*([\\s\\S]+)$`);
  for (const arg of args) {
    const match = arg.match(pattern);
    if (match) {
      return match[1].trim();
    }
  }
  return undefined;
}

function isRawDataTargetExpression(
  expression: string,
  protectedRawPaths: readonly string[],
  options: { treatRelativeRawAsProtected?: boolean } = {}
): boolean {
  const cleaned = stripOuterParentheses(expression.trim());
  const literal = parseSingleStringLiteral(cleaned);
  if (literal !== undefined) {
    return isRawDataPathToken(literal, protectedRawPaths, options);
  }

  const joinedPath = parseJoinedStringPath(cleaned);
  if (joinedPath !== undefined) {
    return isRawDataPathToken(joinedPath, protectedRawPaths, options);
  }

  return containsFragmentedRawDataPathSignal(cleaned);
}

function stripOuterParentheses(value: string): string {
  let current = value;
  while (current.startsWith("(") && current.endsWith(")")) {
    const closeIndex = findMatchingRightParen(current, 0);
    if (closeIndex !== current.length - 1) {
      break;
    }
    current = current.slice(1, -1).trim();
  }
  return current;
}

function parseSingleStringLiteral(value: string): string | undefined {
  const quote = value[0];
  if ((quote !== "'" && quote !== '"' && quote !== "`") || value.at(-1) !== quote) {
    return undefined;
  }
  const body = value.slice(1, -1);
  let output = "";
  let escaped = false;
  for (const char of body) {
    if (escaped) {
      output += char;
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    output += char;
  }
  return output;
}

function parseJoinedStringPath(expression: string): string | undefined {
  if (!/\b(?:path\.join|os\.path\.join|File\.join|file\.path)\s*\(/.test(expression)) {
    return undefined;
  }
  const argsText = findCallArgumentLists(
    expression,
    /\b(?:path\.join|os\.path\.join|File\.join|file\.path)/
  )[0];
  if (!argsText) {
    return undefined;
  }
  const segments = splitTopLevelArguments(argsText)
    .map((arg) => parseSingleStringLiteral(stripOuterParentheses(arg.trim())))
    .filter((segment): segment is string => segment !== undefined);
  return segments.length > 0 ? segments.join("/") : undefined;
}

function isWriteModeExpression(expression: string): boolean {
  const literal = parseSingleStringLiteral(stripOuterParentheses(expression.trim()));
  if (literal === undefined) {
    return false;
  }
  return /[wax+]|\br\+|>/.test(literal);
}

function extractReceiverExpressionBefore(value: string, dotIndex: number): string | undefined {
  const prefix = value.slice(0, dotIndex).trimEnd();
  const boundary = Math.max(
    prefix.lastIndexOf(";"),
    prefix.lastIndexOf("\n"),
    prefix.lastIndexOf("="),
    prefix.lastIndexOf("{")
  );
  const receiver = prefix.slice(boundary + 1).trim();
  return receiver || undefined;
}

function containsFragmentedRawDataPathSignal(value: string): boolean {
  const quotedData = String.raw`["'\`]data["'\`]`;
  const quotedRaw = String.raw`["'\`]raw["'\`]`;
  const slash = String.raw`["'\`]\/["'\`]`;
  return (
    new RegExp(`\\[\\s*${quotedData}\\s*,\\s*${quotedRaw}[\\s\\S]*?\\]\\s*\\.join\\s*\\(\\s*${slash}\\s*\\)`).test(
      value
    ) ||
    new RegExp(`${slash}\\s*\\.join\\s*\\(\\s*\\[\\s*${quotedData}\\s*,\\s*${quotedRaw}`).test(
      value
    ) ||
    new RegExp(`(?:path|os\\.path|File|Path)\\.join\\s*\\(\\s*${quotedData}\\s*,\\s*${quotedRaw}`).test(
      value
    ) ||
    new RegExp(`file\\.path\\s*\\(\\s*${quotedData}\\s*,\\s*${quotedRaw}`).test(
      value
    ) ||
    new RegExp(`(?:pathlib\\.)?Path\\s*\\(\\s*${quotedData}\\s*\\)\\s*\\.joinpath\\s*\\(\\s*${quotedRaw}`).test(
      value
    ) ||
    new RegExp(`${quotedData}\\s*\\+\\s*${slash}\\s*\\+\\s*${quotedRaw}`).test(value) ||
    new RegExp(`${quotedData}\\s*/\\s*${quotedRaw}`).test(value)
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

function effectiveShellTokens(tokens: readonly string[]): string[] {
  return tokens
    .map((token) => token.replace(/^[({]+/, "").replace(/[)}]+$/, ""))
    .filter((token) => token.length > 0 && token !== "{" && token !== "}");
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
  const dynamicState = collectDynamicRawPathState(command);
  if (
    dynamicState.rawCandidateVariables.size === 0 &&
    (dynamicState.dataVariables.size === 0 || dynamicState.rawVariables.size === 0)
  ) {
    return false;
  }

  let relativeRawPathsAmbiguous = false;
  for (const segment of splitStaticShellSegments(command)) {
    const tokens = effectiveShellTokens(tokenizeStaticShellSegment(segment));
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

    if (hasRawCandidateVariableRedirection(tokens, dynamicState)) {
      return true;
    }

    const operands = extractCommandOperands(tokens.slice(1));
    if (operands.length === 0) {
      continue;
    }

    if (commandName === "cp") {
      const destination = operands.at(-1);
      if (destination && referencesDynamicRawTarget(destination, dynamicState)) {
        return true;
      }
      continue;
    }

    if (commandName === "dd") {
      if (
        operands.some((operand) => {
          const outputMatch = operand.match(/^of=(.+)$/);
          return outputMatch !== null && referencesDynamicRawTarget(outputMatch[1], dynamicState);
        })
      ) {
        return true;
      }
      continue;
    }

    if (commandName === "install" || commandName === "ln") {
      const destination = operands.at(-1);
      if (destination && referencesDynamicRawTarget(destination, dynamicState)) {
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
      if (operands.some((operand) => referencesDynamicRawTarget(operand, dynamicState))) {
        return true;
      }
    }
  }

  return false;
}

function collectDynamicRawPathState(command: string): {
  rawCandidateVariables: Set<string>;
  dataVariables: Set<string>;
  rawVariables: Set<string>;
} {
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
    if (
      isDynamicRawTargetAtPathStart(value, {
        rawCandidateVariables,
        dataVariables,
        rawVariables
      })
    ) {
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
      if (
        isDynamicRawTargetAtPathStart(value, {
          rawCandidateVariables,
          dataVariables,
          rawVariables
        })
      ) {
        rawCandidateVariables.add(name);
        changed = true;
      }
    }
  }

  return {
    rawCandidateVariables,
    dataVariables,
    rawVariables
  };
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
  dynamicState: {
    rawCandidateVariables: ReadonlySet<string>;
    dataVariables: ReadonlySet<string>;
    rawVariables: ReadonlySet<string>;
  }
): boolean {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      isWriteRedirectionToken(tokens[index]) &&
      referencesDynamicRawTarget(tokens[index + 1], dynamicState)
    ) {
      return true;
    }
  }
  return false;
}

function referencesDynamicRawTarget(
  value: string,
  dynamicState: {
    rawCandidateVariables: ReadonlySet<string>;
    dataVariables: ReadonlySet<string>;
    rawVariables: ReadonlySet<string>;
  }
): boolean {
  return isDynamicRawTargetAtPathStart(value, dynamicState);
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

function isDynamicRawTargetAtPathStart(
  value: string,
  dynamicState: {
    rawCandidateVariables: ReadonlySet<string>;
    dataVariables: ReadonlySet<string>;
    rawVariables: ReadonlySet<string>;
  }
): boolean {
  const normalized = value.trim().replace(/^['"]|['"]$/g, "");
  if (/[`*?[\]]/.test(normalized)) {
    return false;
  }
  const withoutDot = normalized.startsWith("./") ? normalized.slice(2) : normalized;

  if (containsRelativeRawLiteral(withoutDot)) {
    return true;
  }

  for (const rawCandidateVariable of dynamicState.rawCandidateVariables) {
    const rest = consumeVariableAtStart(withoutDot, rawCandidateVariable);
    if (rest !== undefined) {
      return true;
    }
  }

  const afterLiteralData = consumeLiteralPathSegment(withoutDot, "data");
  if (afterLiteralData !== undefined) {
    for (const rawVariable of dynamicState.rawVariables) {
      const rest = consumeVariableAtStart(afterLiteralData, rawVariable);
      if (rest !== undefined) {
        return true;
      }
    }
  }

  for (const dataVariable of dynamicState.dataVariables) {
    const afterDataVariable = consumeVariableAtStart(withoutDot, dataVariable);
    if (afterDataVariable === undefined) {
      continue;
    }
    const afterRawLiteral = consumeLiteralPathSegment(afterDataVariable, "raw");
    if (afterRawLiteral !== undefined) {
      return true;
    }
    for (const rawVariable of dynamicState.rawVariables) {
      const rest = consumeVariableAtStart(afterDataVariable, rawVariable);
      if (rest !== undefined) {
        return true;
      }
    }
  }

  return false;
}

function consumeLiteralPathSegment(value: string, segment: string): string | undefined {
  if (value === segment) {
    return "";
  }
  if (value.startsWith(`${segment}/`)) {
    return value.slice(segment.length + 1);
  }
  return undefined;
}

function consumeVariableAtStart(value: string, variable: string): string | undefined {
  const simple = `$${variable}`;
  if (value === simple) {
    return "";
  }
  if (value.startsWith(`${simple}/`)) {
    return value.slice(simple.length + 1);
  }

  const braced = `\${${variable}}`;
  if (value === braced) {
    return "";
  }
  if (value.startsWith(`${braced}/`)) {
    return value.slice(braced.length + 1);
  }
  return undefined;
}

function isCwdChangingCommand(commandName: string): boolean {
  return commandName === "cd" || commandName === "pushd" || commandName === "popd";
}

function canHideSandboxFailure(command: string): boolean {
  return hasShellExitStatusNormalizer(command) || hasShellDenialOutputSuppression(command);
}

function hasShellExitStatusNormalizer(command: string): boolean {
  return /(?:^|[\s;&|])(?:\|\||;|\n|&)\s*(?::|true|exit\s+0)(?=\s|[;|&)]|$)/.test(command);
}

function hasShellDenialOutputSuppression(command: string): boolean {
  return (
    /(?:^|[\s;&|])2\s*>{1,2}\s*\/dev\/null(?=[\s;|&)]|$)/.test(command) ||
    /(?:^|[\s;&|])2\s*>\s*&\s*-(?=[\s;|&)]|$)/.test(command) ||
    /(?:^|[\s;&|])>\s*\/dev\/null\s+2\s*>\s*&\s*1(?=[\s;|&)]|$)/.test(command)
  );
}

function canLoseSandboxDenialEvidence(command: string): boolean {
  return canHideSandboxFailure(command) || hasShellStderrFileRedirection(command);
}

function hasShellStderrFileRedirection(command: string): boolean {
  return (
    /(?:^|[\s;&|])2\s*>{1,2}\s*(?!&[12]\b)(?!\/dev\/stderr\b)(?!\/proc\/self\/fd\/2\b)[^\s;|&)]+/.test(
      command
    ) ||
    /(?:^|[\s;&|])(?:&>|>&)\s*(?!&[12]\b)(?!\/dev\/stderr\b)(?!\/proc\/self\/fd\/2\b)[^\s;|&)]+/.test(
      command
    ) ||
    /(?:^|[\s;&|])>{1,2}\s*(?!&[12]\b)[^\s;|&)]+[\s\S]*2\s*>\s*&\s*1/.test(command)
  );
}

function rawDataGuardClassForRawData(): RawDataGuardClass {
  return "authority";
}

function isLikelySandboxDenialForCommand(
  command: string,
  result: ToolResult,
  protectedRawPaths: readonly string[]
): boolean {
  const output = result.output;
  const denialOutput =
    isLikelySandboxDenial(output) || INTERPRETER_WRITE_DENIAL_PATTERN.test(output);
  if (!denialOutput) {
    return (
      !result.success &&
      hasFailedResultRawWriteSignal(command, protectedRawPaths) &&
      canLoseSandboxDenialEvidence(command)
    );
  }

  if (result.success) {
    return hasPreciseRawWriteTargetSignal(command, protectedRawPaths);
  }

  return (
    hasFailedResultRawWriteSignal(command, protectedRawPaths) ||
    hasVisibleShellRawWriteDenialSignal(command, protectedRawPaths)
  );
}

function hasPreciseRawWriteTargetSignal(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  return hasKnownRawDataWriteTarget(command, protectedRawPaths);
}

function hasKnownRawDataWriteTarget(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  return (
    hasStaticRawDataWrite(command, protectedRawPaths) ||
    hasDynamicRawDataWriteRisk(command) ||
    hasInPlaceRawMutationSignal(command, protectedRawPaths)
  );
}

function hasFailedResultRawWriteSignal(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  return hasPreciseRawWriteTargetSignal(command, protectedRawPaths);
}

function hasVisibleShellRawWriteDenialSignal(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  if (!containsRawDataPathSignal(command, protectedRawPaths)) {
    return false;
  }
  return /(?:^|[\s;&|])(?:awk|cp|mv|tee|touch|mkdir|truncate|chmod|chown|chgrp|xattr|rm|unlink|dd|install|ln|sed|perl|sh|bash)\b|>/.test(
    command
  );
}

function hasInPlaceRawMutationSignal(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  for (const segment of splitStaticShellSegments(command)) {
    const tokens = effectiveShellTokens(tokenizeStaticShellSegment(segment));
    if (tokens.length === 0) {
      continue;
    }
    const commandName = normalizeCommandName(tokens[0]);
    if (commandName !== "sed" && commandName !== "perl") {
      continue;
    }
    if (!hasInPlaceMutationFlag(tokens)) {
      continue;
    }
    const operands = extractCommandOperands(tokens.slice(1));
    if (
      operands.some((operand) =>
        isRawDataPathToken(operand, protectedRawPaths, {
          treatRelativeRawAsProtected: true
        })
      )
    ) {
      return true;
    }
  }
  return false;
}

function hasInPlaceMutationFlag(tokens: readonly string[]): boolean {
  return tokens.some((token) => token === "-i" || /^-[A-Za-z]*i[A-Za-z]*$/.test(token));
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

async function ensurePolicyGateAuditReservation(
  workspaceRoot: string,
  taskId: string,
  fileName: string,
  protectedRawPaths: readonly string[]
): Promise<PolicyGateAuditReservation> {
  assertProtectedRawPathsProvided(protectedRawPaths);
  assertSafePathSegment(taskId, "audit task id");
  assertSafePathSegment(fileName, "audit file name");
  const workspaceRealPath = await ensureDirectoryOutsideProtectedRaw(
    workspaceRoot,
    protectedRawPaths,
    "policy gate audit workspace root"
  );
  let current = workspaceRealPath;

  for (const segment of ["workspace", "tasks", taskId, "audit"]) {
    current = join(current, segment);
    await ensureSafeAuditDirComponent(current, workspaceRealPath, protectedRawPaths);
  }

  const auditPath = join(current, fileName);
  const handle = await openAuditFileForAppendNoFollow(auditPath);
  const metadata = await handle.stat();

  return {
    auditDir: current,
    auditPath,
    protectedEvidencePath: auditPath,
    handle,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

function assertProtectedRawPathsProvided(
  protectedRawPaths: readonly string[] | undefined
): asserts protectedRawPaths is readonly string[] {
  if (!Array.isArray(protectedRawPaths) || protectedRawPaths.length === 0) {
    throw new Error("protectedRawPaths is required for policy gate audit writes.");
  }
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

async function openAuditFileForAppendNoFollow(path: string): Promise<FileHandle> {
  await assertSafeAuditFileTarget(path);
  const flags =
    fsConstants.O_CREAT |
    fsConstants.O_APPEND |
    fsConstants.O_WRONLY |
    (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await open(path, flags, 0o600);
  try {
    await assertSafeAuditHandle(handle, path);
  } catch (error) {
    await handle.close();
    throw error;
  }
  return handle;
}

async function appendReservedPolicyGateAuditRow(
  reservation: PolicyGateAuditReservation,
  row: PolicyGateAuditRow
): Promise<void> {
  await assertAuditPathIdentity(reservation);
  await appendAuditHandle(reservation.handle, reservation.auditPath, `${JSON.stringify(row)}\n`);
}

async function appendAuditHandle(handle: FileHandle, path: string, line: string): Promise<void> {
  await assertSafeAuditHandle(handle, path);
  await handle.writeFile(line, "utf8");
}

async function assertSafeAuditHandle(handle: FileHandle, path: string): Promise<void> {
  const metadata = await handle.stat();
  if (!metadata.isFile()) {
    throw new Error(`Policy gate audit target is not a regular file: ${path}`);
  }
  if (metadata.nlink > 1) {
    throw new Error(`Policy gate audit target must not be a hardlink: ${path}`);
  }
}

async function assertAuditPathIdentity(reservation: PolicyGateAuditReservation): Promise<void> {
  await assertSafeAuditFileTarget(reservation.auditPath);
  const pathMetadata = await lstat(reservation.auditPath);
  const handleMetadata = await reservation.handle.stat();
  if (
    pathMetadata.dev !== reservation.dev ||
    pathMetadata.ino !== reservation.ino ||
    handleMetadata.dev !== reservation.dev ||
    handleMetadata.ino !== reservation.ino
  ) {
    throw new Error(`Policy gate audit target was moved or replaced: ${reservation.auditPath}`);
  }
}

async function closePolicyGateAuditReservation(
  reservation: PolicyGateAuditReservation
): Promise<void> {
  try {
    await reservation.handle.close();
  } catch {
    // Closing a best-effort evidence handle must not mask the tool result.
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
