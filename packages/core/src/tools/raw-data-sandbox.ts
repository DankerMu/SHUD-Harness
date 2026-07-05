import { createHash, randomBytes } from "node:crypto";
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
const PIPE_GRACE_MS = 1000;
const FORCE_KILL_SETTLE_MS = 75;
const DESCENDANT_SAMPLE_INTERVAL_MS = 100;
const DESCENDANT_KILL_SETTLE_MS = 120;
const COMMAND_ANALYSIS_MAX_LENGTH = 128_000;
const INTERPRETER_PAYLOAD_ANALYSIS_MAX_LENGTH = 32_000;
const COMMAND_ANALYSIS_MAX_SEGMENTS = 512;
const COMMAND_ANALYSIS_MAX_CALLS = 512;
const PROCESS_PREFLIGHT_ANALYSIS_MAX_LENGTH = 32_000;
const STREAM_CAPTURE_MAX_CHARS = 64_000;
const DEFAULT_ABORT_MESSAGE = "Command aborted by user from Session Detail.";
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
const RESERVED_RAW_DATA_DENIAL_ERROR_ID_PREFIXES = [
  `${RAW_DATA_WRITE_RULE_ID}:denied_by_advisory`,
  `${RAW_DATA_WRITE_RULE_ID}:denied_by_sandbox`
] as const;
const RAW_DATA_TOOL_FAILED_EVENT_INPUT_PROOF_SECRET = randomBytes(32).toString("hex");
const trustedRawDataToolFailedEventInputProofs = new WeakMap<
  RawDataToolFailedEventInput,
  string
>();
const trustedRawDataToolFailedEventInputsByResult = new WeakMap<
  ToolResult,
  RawDataToolFailedEventInput
>();
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
  protectedRawAncestorLiteralPaths: readonly string[];
  protectedEvidencePaths: readonly string[];
  protectedEvidenceAncestorLiteralPaths: readonly string[];
  allowedWriteRoots: readonly string[];
  tempRoot: string;
  profileRoot?: string;
}

export interface RawDataSeatbeltProfile {
  profileId: string;
  profileText: string;
  metadata: RawDataSeatbeltProfileMetadata;
}

interface RawDataSeatbeltProfileFile {
  profilePath: string;
  runRoot: string;
  runRootRealPath: string;
  runRootDev: number;
  runRootIno: number;
}

export type RawDataSandboxedBashToolOptions = RawDataSeatbeltProfileOptions & {
  toolId?: string;
  enableAdvisory?: boolean;
  pathResolutionRoot?: string;
  auditWorkspaceRoot?: string;
  auditTaskId?: string;
  fuseRules: readonly FuseRule[];
};

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

export type RawDataAdvisoryDenialPayload = RawDataDenialPayload & {
  decision: "denied_by_advisory";
};

export type RawDataGuardClass = "authority" | "capability";

export interface RawDataDenialEvidence {
  payload: RawDataAdvisoryDenialPayload;
  toolResult: ToolResult;
  auditRow: PolicyGateAuditRow;
  toolFailedEventInput: RawDataToolFailedEventInput;
}

export interface RawDataToolFailedEventInput {
  toolId: string;
  rule: typeof RAW_DATA_WRITE_RULE_ID;
  decision: RawDataAdvisoryDenialPayload["decision"];
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
  assertAbsoluteRoots(options.protectedRawPaths, "protectedRawPaths");
  assertAbsoluteRoots(options.allowedWriteRoots, "allowedWriteRoots");
  if (options.protectedEvidencePaths) {
    assertAbsoluteRoots(options.protectedEvidencePaths, "protectedEvidencePaths");
  }
  if (options.tempRoot !== undefined) {
    assertAbsoluteRoot(options.tempRoot, "tempRoot");
  }
  if (options.profileRoot !== undefined) {
    assertAbsoluteRoot(options.profileRoot, "profileRoot");
  }

  const protectedRawPaths = await canonicalizePathSet(options.protectedRawPaths);
  const protectedEvidencePaths = options.protectedEvidencePaths
    ? await canonicalizePathSet(options.protectedEvidencePaths)
    : [];
  const allowedWriteRoots = await canonicalizePathSet(options.allowedWriteRoots);
  const protectedWriteDenyPaths = sortedUnique([
    ...protectedRawPaths,
    ...protectedEvidencePaths
  ]);
  const tempRoot = await ensureDirectoryOutsideProtectedRaw(
    options.tempRoot ?? tmpdir(),
    protectedWriteDenyPaths,
    "seatbelt temp root"
  );
  const writeAllowRoots = sortedUnique([tempRoot, ...allowedWriteRoots]);
  const protectedRawAncestorLiteralPaths = protectedRawAncestorLiterals(
    protectedRawPaths,
    writeAllowRoots
  );
  const protectedEvidenceAncestorLiteralPaths =
    protectedEvidenceAncestorLiterals(protectedEvidencePaths, writeAllowRoots);
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
    protectedRawAncestorLiteralPaths,
    protectedEvidencePaths,
    protectedEvidenceAncestorLiteralPaths,
    allowedWriteRoots,
    tempRoot
  });
  const profileId = `shud-raw-seatbelt-${createHash("sha256")
    .update(idInput)
    .digest("hex")
    .slice(0, 16)}`;

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
    ]),
    ...protectedRawAncestorLiteralPaths.map(
      (protectedPath) => `(deny file-write* (literal ${quoteSeatbeltString(protectedPath)}))`
    ),
    ...protectedEvidenceAncestorLiteralPaths.map(
      (protectedPath) => `(deny file-write* (literal ${quoteSeatbeltString(protectedPath)}))`
    )
  ].join("\n");

  return {
    profileId,
    profileText,
    metadata: {
      profileVersion: RAW_DATA_SANDBOX_PROFILE_VERSION,
      profileId,
      protectedRawPaths,
      protectedRawAncestorLiteralPaths,
      protectedEvidencePaths,
      protectedEvidenceAncestorLiteralPaths,
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
  const profileFile = await createRawDataSeatbeltProfileFile(profile, profileRoot);
  return profileFile.profilePath;
}

async function createRawDataSeatbeltProfileFile(
  profile: RawDataSeatbeltProfile,
  profileRoot?: string
): Promise<RawDataSeatbeltProfileFile> {
  const root = profileRoot ?? profile.metadata.profileRoot ?? profile.metadata.tempRoot;
  assertAbsoluteRoot(
    root,
    profileRoot !== undefined
      ? "profileRoot"
      : profile.metadata.profileRoot !== undefined
        ? "profile.metadata.profileRoot"
        : "profile.metadata.tempRoot"
  );
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
  const runRootMetadata = await lstat(runRoot);
  if (runRootMetadata.isSymbolicLink() || !runRootMetadata.isDirectory()) {
    throw new Error(`Seatbelt profile run directory is unsafe: ${runRoot}`);
  }
  return {
    profilePath: await canonicalizeExistingPath(profilePath),
    runRoot,
    runRootRealPath: await canonicalizeExistingPath(runRoot),
    runRootDev: runRootMetadata.dev,
    runRootIno: runRootMetadata.ino
  };
}

interface ResolvedRawDataSandboxRuntimeRoots {
  profileOptions: RawDataSeatbeltProfileOptions;
  auditWorkspaceRoot?: string;
}

function resolveRawDataSandboxRuntimeRoots(
  options: RawDataSandboxedBashToolOptions
): ResolvedRawDataSandboxRuntimeRoots {
  return {
    profileOptions: {
      protectedRawPaths: options.protectedRawPaths.map((path) =>
        resolveRuntimeRoot(path, "protectedRawPaths", options.pathResolutionRoot)
      ),
      allowedWriteRoots: options.allowedWriteRoots.map((path) =>
        resolveRuntimeRoot(path, "allowedWriteRoots", options.pathResolutionRoot)
      ),
      ...(options.protectedEvidencePaths
        ? {
            protectedEvidencePaths: options.protectedEvidencePaths.map((path) =>
              resolveRuntimeRoot(path, "protectedEvidencePaths", options.pathResolutionRoot)
            )
          }
        : {}),
      ...(options.tempRoot !== undefined
        ? {
            tempRoot: resolveRuntimeRoot(
              options.tempRoot,
              "tempRoot",
              options.pathResolutionRoot
            )
          }
        : {}),
      ...(options.profileRoot !== undefined
        ? {
            profileRoot: resolveRuntimeRoot(
              options.profileRoot,
              "profileRoot",
              options.pathResolutionRoot
            )
          }
        : {})
    },
    ...resolveAuditWorkspaceRootOption(options)
  };
}

function resolveAuditWorkspaceRootOption(
  options: RawDataSandboxedBashToolOptions
): Pick<ResolvedRawDataSandboxRuntimeRoots, "auditWorkspaceRoot"> {
  if (options.auditWorkspaceRoot !== undefined) {
    return {
      auditWorkspaceRoot: resolveRuntimeRoot(
        options.auditWorkspaceRoot,
        "auditWorkspaceRoot",
        options.pathResolutionRoot
      )
    };
  }

  if (options.pathResolutionRoot !== undefined) {
    return {
      auditWorkspaceRoot: resolveRuntimeRoot(
        "workspace",
        "auditWorkspaceRoot",
        options.pathResolutionRoot
      )
    };
  }

  return {};
}

function resolveRuntimeRoot(
  path: string,
  label: string,
  pathResolutionRoot: string | undefined
): string {
  if (isAbsolute(path)) {
    return path;
  }
  if (!pathResolutionRoot) {
    throw new Error(`Relative ${label} requires pathResolutionRoot: ${path}`);
  }
  if (!isAbsolute(pathResolutionRoot)) {
    throw new Error(`pathResolutionRoot must be absolute to resolve relative ${label}.`);
  }
  return resolve(pathResolutionRoot, path);
}

function protectedRawAncestorLiterals(
  protectedRawPaths: readonly string[],
  allowedWriteRoots: readonly string[]
): string[] {
  return protectedPathAncestorLiterals(protectedRawPaths, allowedWriteRoots);
}

function protectedEvidenceAncestorLiterals(
  protectedEvidencePaths: readonly string[],
  allowedWriteRoots: readonly string[]
): string[] {
  return protectedPathAncestorLiterals(protectedEvidencePaths, allowedWriteRoots);
}

function protectedPathAncestorLiterals(
  protectedPaths: readonly string[],
  allowedWriteRoots: readonly string[]
): string[] {
  const ancestors: string[] = [];
  for (const protectedPath of protectedPaths) {
    let current = dirname(protectedPath);
    while (current !== dirname(current)) {
      const isAllowedWriteRoot = allowedWriteRoots.some(
        (root) => normalize(resolve(current)) === normalize(resolve(root))
      );
      if (isAllowedWriteRoot) {
        break;
      }
      if (allowedWriteRoots.some((root) => isPathInsideOrEqual(current, root))) {
        ancestors.push(current);
      }
      current = dirname(current);
    }
  }
  return sortedUnique(ancestors);
}

export class RawDataSandboxedBashTool extends BaseTool {
  readonly name: string;
  readonly description: string;
  readonly parameters: Record<string, unknown>;

  private readonly fuseChecker: FuseListChecker;

  constructor(private readonly options: RawDataSandboxedBashToolOptions) {
    super();
    if ("innerTool" in (options as unknown as Record<string, unknown>)) {
      throw new Error(
        "RawDataSandboxedBashTool does not accept innerTool; pass explicit fuseRules."
      );
    }
    if (!Array.isArray(options.fuseRules)) {
      throw new Error("RawDataSandboxedBashTool requires explicit fuseRules.");
    }
    const metadataTool = new BashTool([...options.fuseRules]);
    this.fuseChecker = new FuseListChecker([...options.fuseRules]);
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
      return this.finalizeToolResult(ctx, {
        success: false,
        output: "Sandboxed bash requires a string command.",
        outputSummary: "Sandboxed bash missing command"
      });
    }

    let runtimeRoots: ResolvedRawDataSandboxRuntimeRoots;
    try {
      runtimeRoots = resolveRawDataSandboxRuntimeRoots(this.options);
    } catch (error) {
      return this.finalizeToolResult(
        ctx,
        buildPathResolutionFailureResult({
          toolId: this.name,
          reason: errorMessage(error)
        })
      );
    }

    const profileOptions = runtimeRoots.profileOptions;
    const protectedRawPaths = await canonicalizePathSet(profileOptions.protectedRawPaths);
    const auditReservation = await this.reserveAuditEvidence(
      ctx,
      protectedRawPaths,
      runtimeRoots.auditWorkspaceRoot
    );
    if ("toolResult" in auditReservation) {
      return this.finalizeToolResult(ctx, auditReservation.toolResult);
    }

    let profileFile: RawDataSeatbeltProfileFile | undefined;
    let profilePath: string | undefined;
    try {
      const profile = await buildRawDataSeatbeltProfile({
        protectedRawPaths,
        allowedWriteRoots: profileOptions.allowedWriteRoots,
        tempRoot: profileOptions.tempRoot,
        profileRoot: profileOptions.profileRoot,
        protectedEvidencePaths: [
          ...(profileOptions.protectedEvidencePaths ?? []),
          auditReservation.protectedEvidencePath
        ]
      });
      profileFile = await createRawDataSeatbeltProfileFile(profile, profileOptions.profileRoot);
      profilePath = profileFile.profilePath;
      const protectedRawPathSignals = rawDataSignalPaths(
        profileOptions.protectedRawPaths,
        profile.metadata.protectedRawPaths
      );

      if (this.options.enableAdvisory !== false) {
        const advisory = evaluateRawDataWriteAdvisory(command, protectedRawPathSignals);
        if (advisory.decision === "deny") {
          const evidence = buildRawDataDenialEvidence({
            toolId: this.name,
            reason: advisory.reason,
            profile,
            profilePath,
            invocationId: readInvocationId(ctx)
          });
          const appendFailure = await this.appendDenialAudit(ctx, auditReservation, evidence);
          if (appendFailure) {
            return this.finalizeToolResult(ctx, appendFailure);
          }
          trustRawDataDenialEvidence(evidence);
          return this.finalizeToolResult(ctx, evidence.toolResult);
        }
      }

      const containmentPreflight = evaluateProcessContainmentPreflight(command);
      if (containmentPreflight.decision === "deny") {
        const result = buildProcessContainmentFailureResult({
          toolId: this.name,
          reason: containmentPreflight.reason
        });
        const appendFailure = await this.appendAudit(ctx, auditReservation, {
          event: "tool.failed",
          decision: "policy_gate_process_containment_unavailable",
          profile,
          profilePath
        });
        if (appendFailure) {
          return this.finalizeToolResult(ctx, appendFailure);
        }
        return this.finalizeToolResult(ctx, result);
      }

      const run = await runSeatbeltSandboxedBash(ctx, {
        ...(typeof input === "object" && input !== null ? input : {}),
        toolId: this.name,
        command,
        profilePath,
        sandboxExecutable: DEFAULT_SANDBOX_EXECUTABLE,
        bashExecutable: DEFAULT_SANDBOX_BASH
      });
      const result = run.result;

      if (isProcessContainmentFailureResult(result)) {
        const appendFailure = await this.appendAudit(ctx, auditReservation, {
          event: "tool.failed",
          decision: "policy_gate_process_containment_unavailable",
          profile,
          profilePath
        });
        if (appendFailure) {
          return this.finalizeToolResult(ctx, appendFailure, run.cause);
        }
        return this.finalizeToolResult(ctx, result, run.cause);
      }

      const appendFailure = await this.appendAudit(ctx, auditReservation, {
        event: result.success ? "tool.completed" : "tool.failed",
        decision: result.success ? "allowed" : "failed",
        profile,
        profilePath
      });
      if (appendFailure) {
        return this.finalizeToolResult(ctx, appendFailure, run.cause);
      }
      return this.finalizeToolResult(
        ctx,
        normalizeSandboxedBashResult(result, command, profilePath),
        run.cause
      );
    } finally {
      await closePolicyGateAuditReservation(auditReservation);
      if (profileFile) {
        await cleanupRawDataSeatbeltProfileFile(ctx, profileFile);
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
  ): Promise<ToolResult | undefined> {
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
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ctx.logger.error("policy_gate_audit_append_failed", {
        tool: this.name,
        rule: RAW_DATA_WRITE_RULE_ID,
        decision: input.decision,
        error: message
      });
      return buildAuditReservationFailureResult({
        toolId: this.name,
        reason: `Policy gate lifecycle audit evidence could not be persisted: ${message}`
      });
    }
  }

  private async reserveAuditEvidence(
    ctx: ToolContext,
    protectedRawPaths: readonly string[],
    auditWorkspaceRoot: string | undefined
  ): Promise<PolicyGateAuditReservation | PolicyGateAuditReservationFailure> {
    try {
      return await ensurePolicyGateAuditReservation(
        resolve(auditWorkspaceRoot ?? ctx.workDir),
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

  private finalizeToolResult(
    ctx: ToolContext,
    result: ToolResult,
    cause: RunningToolTerminationCause = "completed"
  ): ToolResult {
    markRunningToolFinished(ctx, result, cause);
    return result;
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
  const analysis = analyzeRawDataCommand(command, protectedRawPaths);
  if (analysis.hasStaticRawWrite) {
    return {
      decision: "deny",
      reason: "obvious static raw-data write target",
      remediation: rawDataWriteRemediation()
    };
  }

  return { decision: "allow" };
}

interface RawDataCommandAnalysis {
  budgetExceeded: boolean;
  budgetReason?: string;
  hasStaticRawWrite: boolean;
  hasKnownRawWriteTarget: boolean;
}

function analyzeRawDataCommand(
  command: string,
  protectedRawPaths: readonly string[]
): RawDataCommandAnalysis {
  const budget = evaluateCommandAnalysisBudget(command);
  if (!budget.ok) {
    return {
      budgetExceeded: true,
      budgetReason: budget.reason,
      hasStaticRawWrite: false,
      hasKnownRawWriteTarget: false
    };
  }

  const hasStaticRawWrite = hasStaticRawDataWrite(command, protectedRawPaths);
  const hasKnownRawWriteTarget = hasKnownRawDataWriteTarget(command, protectedRawPaths, {
    staticRawWrite: hasStaticRawWrite
  });

  return {
    budgetExceeded: false,
    hasStaticRawWrite,
    hasKnownRawWriteTarget
  };
}

function evaluateCommandAnalysisBudget(
  command: string
): { ok: true } | { ok: false; reason: string } {
  if (command.length > COMMAND_ANALYSIS_MAX_LENGTH) {
    return {
      ok: false,
      reason: `command length exceeds policy gate analysis budget: ${COMMAND_ANALYSIS_MAX_LENGTH}`
    };
  }

  const segments = splitStaticShellSegments(command);
  if (segments.length > COMMAND_ANALYSIS_MAX_SEGMENTS) {
    return {
      ok: false,
      reason: `command segment count exceeds policy gate analysis budget: ${COMMAND_ANALYSIS_MAX_SEGMENTS}`
    };
  }

  for (const segment of segments) {
    const payload = interpreterPayload(commandTokensFromSegment(segment));
    if (payload && payload.length > INTERPRETER_PAYLOAD_ANALYSIS_MAX_LENGTH) {
      return {
        ok: false,
        reason: `interpreter payload length exceeds policy gate analysis budget: ${INTERPRETER_PAYLOAD_ANALYSIS_MAX_LENGTH}`
      };
    }
  }

  return { ok: true };
}

export async function appendPolicyGateAuditRow(
  options: AppendPolicyGateAuditRowOptions
): Promise<string> {
  assertProtectedRawPathsProvided(options.protectedRawPaths);
  assertAbsoluteRoot(options.workspaceRoot, "workspaceRoot");
  assertAbsoluteRoots(options.protectedRawPaths, "protectedRawPaths");
  assertPublicPolicyGateAuditRow(options.row);
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

function assertPublicPolicyGateAuditRow(row: PolicyGateAuditRow): void {
  if (row.rule === RAW_DATA_WRITE_RULE_ID && isRawDataDenialDecision(row.decision)) {
    throw new Error(
      "Raw-data denial audit rows require RawDataSandboxedBashTool trusted evidence."
    );
  }
  if (isReservedRawDataDenialErrorId(row.error_id)) {
    throw new Error(
      "Reserved raw-data denial error_id values require RawDataSandboxedBashTool trusted evidence."
    );
  }
}

export function buildRawDataDeniedPayload(input: {
  toolId: string;
  reason: string;
  profile: RawDataSeatbeltProfile;
  profilePath?: string;
  underlyingOutput?: string;
  invocationId?: string;
  ts?: string;
}): RawDataAdvisoryDenialPayload {
  const ts = input.ts ?? new Date().toISOString();
  const remediation = rawDataWriteRemediation();
  const guardClass = rawDataGuardClassForRawData();
  const errorId = [
    RAW_DATA_WRITE_RULE_ID,
    "denied_by_advisory",
    input.profile.profileId,
    ...(input.invocationId ? [input.invocationId] : [])
  ].join(":");
  const message = "Raw data write denied by advisory policy gate.";

  return {
    error: "raw_data_write_denied",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    decision: "denied_by_advisory",
    guard_class: guardClass,
    reason: input.reason,
    remediation,
    profile_id: input.profile.profileId,
    ...(input.profilePath ? { profile_path: input.profilePath } : {}),
    ...(input.invocationId ? { invocation_id: input.invocationId } : {}),
    error_record: {
      error_id: errorId,
      category: "permission_error",
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

function trustRawDataDenialEvidence(evidence: RawDataDenialEvidence): void {
  const trustedInput = frozenTrustedRawDataToolFailedEventInput(
    evidence.toolFailedEventInput
  );
  proveRawDataToolFailedEventInput(trustedInput);
  trustedRawDataToolFailedEventInputsByResult.set(
    evidence.toolResult,
    trustedInput
  );
}

export function buildRawDataDeniedToolResult(input: {
  toolId: string;
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
  payload: RawDataAdvisoryDenialPayload,
  ts = payload.error_record.created_at
): PolicyGateAuditRow {
  assertAdvisoryRawDataDenialPayload(payload);
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
  payload: RawDataAdvisoryDenialPayload
): RawDataToolFailedEventInput {
  assertAdvisoryRawDataDenialPayload(payload);
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

export function rawDataDeniedToolResultToToolFailedEventInput(
  result: ToolResult
): RawDataToolFailedEventInput | undefined {
  const trustedInput = trustedRawDataToolFailedEventInputsByResult.get(result);
  if (!trustedInput) {
    return undefined;
  }
  const copiedInput = cloneRawDataToolFailedEventInput(trustedInput);
  proveRawDataToolFailedEventInput(copiedInput);
  return copiedInput;
}

export function assertTrustedRawDataToolFailedEventInput(
  input: RawDataToolFailedEventInput
): void {
  if (input.rule !== RAW_DATA_WRITE_RULE_ID || input.decision !== "denied_by_advisory") {
    throw new Error("Only trusted raw-data advisory denial events are supported.");
  }

  const proof = trustedRawDataToolFailedEventInputProofs.get(input);
  if (proof !== rawDataToolFailedEventInputProof(input)) {
    throw new Error(
      "Raw-data advisory tool.failed events require RawDataSandboxedBashTool trusted evidence."
    );
  }
}

export function isReservedRawDataDenialErrorId(errorId: string | undefined): boolean {
  return RESERVED_RAW_DATA_DENIAL_ERROR_ID_PREFIXES.some(
    (prefix) => errorId === prefix || errorId?.startsWith(`${prefix}:`) === true
  );
}

function proveRawDataToolFailedEventInput(input: RawDataToolFailedEventInput): void {
  trustedRawDataToolFailedEventInputProofs.set(
    input,
    rawDataToolFailedEventInputProof(input)
  );
}

function frozenTrustedRawDataToolFailedEventInput(
  input: RawDataToolFailedEventInput
): RawDataToolFailedEventInput {
  const trustedInput = cloneRawDataToolFailedEventInput(input);
  Object.freeze(trustedInput.error.evidence_refs);
  Object.freeze(trustedInput.error.recommended_next_actions);
  if (trustedInput.error.remediation) {
    Object.freeze(trustedInput.error.remediation);
  }
  Object.freeze(trustedInput.error);
  Object.freeze(trustedInput);
  return trustedInput;
}

function cloneRawDataToolFailedEventInput(
  input: RawDataToolFailedEventInput
): RawDataToolFailedEventInput {
  return {
    toolId: input.toolId,
    rule: input.rule,
    decision: input.decision,
    guardClass: input.guardClass,
    profileId: input.profileId,
    ...(input.invocationId !== undefined ? { invocationId: input.invocationId } : {}),
    error: cloneErrorRecord(input.error)
  };
}

function cloneErrorRecord(error: ErrorRecord): ErrorRecord {
  return {
    error_id: error.error_id,
    category: error.category,
    severity: error.severity,
    ...(error.task_id !== undefined ? { task_id: error.task_id } : {}),
    ...(error.job_id !== undefined ? { job_id: error.job_id } : {}),
    ...(error.run_id !== undefined ? { run_id: error.run_id } : {}),
    ...(error.report_id !== undefined ? { report_id: error.report_id } : {}),
    message: error.message,
    user_message: error.user_message,
    evidence_refs: [...error.evidence_refs],
    retryable: error.retryable,
    recommended_next_actions: [...error.recommended_next_actions],
    ...(error.remediation !== undefined ? { remediation: { ...error.remediation } } : {}),
    created_at: error.created_at
  };
}

function rawDataToolFailedEventInputProof(input: RawDataToolFailedEventInput): string {
  return createHash("sha256")
    .update(RAW_DATA_TOOL_FAILED_EVENT_INPUT_PROOF_SECRET)
    .update(JSON.stringify(rawDataToolFailedEventInputProofMaterial(input)))
    .digest("hex");
}

function rawDataToolFailedEventInputProofMaterial(input: RawDataToolFailedEventInput): unknown {
  return {
    toolId: input.toolId,
    rule: input.rule,
    decision: input.decision,
    guardClass: input.guardClass,
    profileId: input.profileId,
    invocationId: input.invocationId ?? null,
    error: errorRecordProofMaterial(input.error)
  };
}

function errorRecordProofMaterial(error: ErrorRecord): unknown {
  return {
    error_id: error.error_id,
    category: error.category,
    severity: error.severity,
    task_id: error.task_id ?? null,
    job_id: error.job_id ?? null,
    run_id: error.run_id ?? null,
    report_id: error.report_id ?? null,
    message: error.message,
    user_message: error.user_message,
    evidence_refs: [...error.evidence_refs],
    retryable: error.retryable,
    recommended_next_actions: [...error.recommended_next_actions],
    remediation: error.remediation
      ? {
          next_action: error.remediation.next_action,
          hint: error.remediation.hint,
          ref: error.remediation.ref ?? null
        }
      : null,
    created_at: error.created_at
  };
}

function assertAdvisoryRawDataDenialPayload(
  payload: RawDataDenialPayload
): asserts payload is RawDataAdvisoryDenialPayload {
  if (payload.decision !== "denied_by_advisory") {
    throw new Error("Reserved sandbox raw-denial payloads require a trusted OS event source.");
  }
}

export async function scanProtectedHardlinks(input: {
  protectedRoots: readonly string[];
  maxScannedPathCount?: number;
}): Promise<HardlinkScanResult> {
  assertAbsoluteRoots(input.protectedRoots, "protectedRoots");
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
    outputSummary: "Policy gate audit unavailable"
  };
}

function buildPathResolutionFailureResult(input: {
  toolId: string;
  reason: string;
}): ToolResult {
  const payload = {
    error: "raw_data_sandbox_path_resolution_failed",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    reason: input.reason,
    remediation: {
      next_action: "fix_and_retry",
      hint: "Provide an absolute pathResolutionRoot when configuring relative raw sandbox roots.",
      ref: RAW_DATA_POLICY_REF
    }
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: "Raw data sandbox path resolution failed"
  };
}

function buildProcessContainmentFailureResult(input: {
  toolId: string;
  reason: string;
}): ToolResult {
  const payload = {
    error: "policy_gate_process_containment_unavailable",
    tool_id: input.toolId,
    rule: RAW_DATA_WRITE_RULE_ID,
    reason: input.reason,
    remediation: {
      next_action: "fix_and_retry",
      hint: "Run bash commands in the foreground without daemonizing or untracked background mutation.",
      ref: RAW_DATA_POLICY_REF
    }
  };

  return {
    success: false,
    output: JSON.stringify(payload),
    outputSummary: "Policy gate process containment unavailable"
  };
}

function isProcessContainmentFailureResult(result: ToolResult): boolean {
  try {
    const payload = JSON.parse(result.output) as { error?: unknown };
    return payload.error === "policy_gate_process_containment_unavailable";
  } catch {
    return false;
  }
}

function markRunningToolFinished(
  ctx: ToolContext,
  result: ToolResult,
  cause: RunningToolTerminationCause
): void {
  const toolUseId = ctx.currentToolUseId;
  const runningHandle =
    toolUseId && ctx.runningToolRegistry ? ctx.runningToolRegistry.get(toolUseId) : undefined;
  runningHandle?.markFinished({
    finishedAt: new Date().toISOString(),
    cause,
    success: result.success,
    outputSummary: result.outputSummary
  });
}

interface SandboxedBashInput {
  toolId: string;
  command: string;
  timeout?: number;
  envSecrets?: Record<string, string>;
  stdinSecretRef?: string;
  stdinAppendNewline?: boolean;
  profilePath: string;
  sandboxExecutable: string;
  bashExecutable: string;
}

interface SandboxedBashExecution {
  result: ToolResult;
  cause: RunningToolTerminationCause;
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
): Promise<SandboxedBashExecution> {
  const { command, timeout = 120_000 } = input;
  const resolvedExecutables = await verifySeatbeltExecutables(input);
  if (!resolvedExecutables.success) {
    return { result: resolvedExecutables.result, cause: "spawn_error" };
  }

  const resolvedSecrets = resolveBashSecretInputs(ctx, input);
  if (!resolvedSecrets.success) {
    return { result: resolvedSecrets.result, cause: "completed" };
  }

  const usesSecretRefs = resolvedSecrets.secrets.length > 0;
  const summaryCommand = commandLabel(command, usesSecretRefs);
  const leakedSecret = resolvedSecrets.secrets.find(
    (secret) => secret.value.length >= 4 && command.includes(secret.value)
  );
  if (leakedSecret) {
    return {
      result: {
        success: false,
        output:
          "Command contains a resolved secret value. Use envSecrets variables or stdinSecretRef instead.",
        outputSummary: "Command rejected: secret value in command"
      },
      cause: "completed"
    };
  }

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
    return {
      result: {
        success: false,
        output: message,
        outputSummary: `Spawn failed: ${message.slice(0, 80)}`
      },
      cause: "spawn_error"
    };
  }

  const toolUseId = ctx.currentToolUseId;
  const runningHandle =
    toolUseId && ctx.runningToolRegistry ? ctx.runningToolRegistry.get(toolUseId) : undefined;
  const descendantTracker = createInvocationDescendantTracker(proc);
  descendantTracker.start();
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

  const latchTerminationCause = (cause: RunningToolTerminationCause) => {
    if (terminationCause) {
      return false;
    }
    terminationCause = cause;
    return true;
  };

  runningHandle?.setAbortHandler((reason) => {
    abortMessage = reason?.trim() || DEFAULT_ABORT_MESSAGE;
    if (!latchTerminationCause("abort")) {
      return;
    }
    void terminateInvocationProcesses(proc, descendantTracker);
  });

  const timeoutId = setTimeout(() => {
    if (!latchTerminationCause("timeout")) {
      return;
    }
    void terminateInvocationProcesses(proc, descendantTracker);
  }, timeout);

  const exitCode = await proc.exited;
  if (stdinWrite) {
    await stdinWrite;
  }
  clearTimeout(timeoutId);

  const finalCause = terminationCause ?? "completed";
  const containment = await terminateInvocationProcesses(proc, descendantTracker);
  descendantTracker.stop();
  if (!containment.success) {
    await Promise.allSettled([stdoutCapture.cancel(), stderrCapture.cancel()]);
    return {
      result: buildProcessContainmentFailureResult({
        toolId: input.toolId,
        reason: containment.reason
      }),
      cause: finalCause
    };
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
    stdoutCapture.getText("stdout"),
    stderrCapture.getText("stderr"),
    finalCause === "abort" ? abortMessage ?? DEFAULT_ABORT_MESSAGE : undefined
  );

  const result = buildSandboxedBashResult({
    output,
    exitCode,
    finalCause,
    stdinWriteError,
    summaryCommand
  });
  return { result: filterToolResultSecrets(ctx, result), cause: finalCause };
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
      getText: () => "",
      isTruncated: () => false
    };
  }

  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let capturedChars = 0;
  let truncated = false;
  let flushed = false;

  const appendChunk = (chunk: string) => {
    if (!chunk || truncated) {
      return;
    }
    const remaining = STREAM_CAPTURE_MAX_CHARS - capturedChars;
    if (remaining <= 0) {
      truncated = true;
      return;
    }
    if (chunk.length > remaining) {
      chunks.push(chunk.slice(0, remaining));
      capturedChars += remaining;
      truncated = true;
      return;
    }
    chunks.push(chunk);
    capturedChars += chunk.length;
  };

  const flushDecoder = () => {
    if (flushed) {
      return;
    }
    const tail = decoder.decode();
    if (tail) {
      appendChunk(tail);
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
          appendChunk(decoder.decode(value, { stream: true }));
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
    getText: (label = "stream") => {
      flushDecoder();
      const text = chunks.join("");
      return truncated
        ? `${text}\n[${label} truncated after ${STREAM_CAPTURE_MAX_CHARS} chars]`
        : text;
    },
    isTruncated: () => truncated
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

interface InvocationDescendantTracker {
  readonly knownPids: Set<number>;
  start(): void;
  stop(): void;
  sample(): Promise<void>;
}

function createInvocationDescendantTracker(
  proc: ReturnType<typeof Bun.spawn>
): InvocationDescendantTracker {
  const rootPid = typeof proc.pid === "number" ? proc.pid : undefined;
  const knownPids = new Set<number>();
  if (rootPid) {
    knownPids.add(rootPid);
  }
  let interval: ReturnType<typeof setInterval> | undefined;
  let sampling = false;

  const sample = async () => {
    if (!rootPid || process.platform === "win32" || sampling) {
      return;
    }
    sampling = true;
    try {
      const descendants = await listDescendantPids(knownPids);
      for (const pid of descendants) {
        knownPids.add(pid);
      }
    } finally {
      sampling = false;
    }
  };

  return {
    knownPids,
    start() {
      if (!rootPid || interval) {
        return;
      }
      void sample();
      interval = setInterval(() => {
        void sample();
      }, DESCENDANT_SAMPLE_INTERVAL_MS);
    },
    stop() {
      if (!interval) {
        return;
      }
      clearInterval(interval);
      interval = undefined;
    },
    sample
  };
}

async function terminateInvocationProcesses(
  proc: ReturnType<typeof Bun.spawn>,
  tracker: InvocationDescendantTracker
): Promise<{ success: true } | { success: false; reason: string }> {
  tracker.stop();
  try {
    await tracker.sample();
  } catch (error) {
    return {
      success: false,
      reason: `Could not enumerate invocation descendants before teardown: ${errorMessage(error)}`
    };
  }

  tryKillProcess(proc, "SIGKILL");
  killKnownInvocationPids(tracker.knownPids);
  await Bun.sleep(FORCE_KILL_SETTLE_MS);

  try {
    await tracker.sample();
  } catch (error) {
    return {
      success: false,
      reason: `Could not verify invocation descendants after teardown: ${errorMessage(error)}`
    };
  }

  killKnownInvocationPids(tracker.knownPids);
  await Bun.sleep(DESCENDANT_KILL_SETTLE_MS);

  const survivors = await livePids([...tracker.knownPids]);
  const rootPid = typeof proc.pid === "number" ? proc.pid : undefined;
  const escapedSurvivors = survivors.filter((pid) => pid !== rootPid);
  if (escapedSurvivors.length > 0) {
    return {
      success: false,
      reason: `Invocation descendants survived containment: ${escapedSurvivors.join(", ")}`
    };
  }

  return { success: true };
}

function killKnownInvocationPids(pids: ReadonlySet<number>): void {
  const sortedPids = [...pids].sort((a, b) => b - a);
  for (const pid of sortedPids) {
    if (pid <= 0) {
      continue;
    }
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, "SIGKILL");
      } catch {
        // The pid may not be a process-group leader; direct kill follows.
      }
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Ignore processes that have already exited.
    }
  }
}

async function listDescendantPids(rootPids: ReadonlySet<number>): Promise<Set<number>> {
  if (rootPids.size === 0 || process.platform === "win32") {
    return new Set();
  }
  const table = await readProcessParentTable();
  const descendants = new Set<number>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [pid, ppid] of table) {
      if (rootPids.has(pid) || descendants.has(pid)) {
        continue;
      }
      if (rootPids.has(ppid) || descendants.has(ppid)) {
        descendants.add(pid);
        changed = true;
      }
    }
  }
  return descendants;
}

async function readProcessParentTable(): Promise<Map<number, number>> {
  const proc = Bun.spawn(["/bin/ps", "-axo", "pid=,ppid="], {
    stdout: "pipe",
    stderr: "pipe"
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited
  ]);
  if (exitCode !== 0) {
    throw new Error(stderr.trim() || `ps exited with ${exitCode}`);
  }
  const table = new Map<number, number>();
  for (const line of stdout.split("\n")) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) {
      continue;
    }
    table.set(Number(match[1]), Number(match[2]));
  }
  return table;
}

async function livePids(pids: readonly number[]): Promise<number[]> {
  const live: number[] = [];
  for (const pid of pids) {
    if (pid <= 0) {
      continue;
    }
    try {
      process.kill(pid, 0);
      live.push(pid);
    } catch {
      // Not live or not visible.
    }
  }
  return live;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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

interface RawPathResolutionOptions {
  treatRelativeRawAsProtected?: boolean;
  cwdCandidates?: readonly string[];
}

function hasStaticRawDataWrite(
  command: string,
  protectedRawPaths: readonly string[],
  options: { treatInitialRelativeRawAsProtected?: boolean; initialCwdCandidates?: readonly string[] } = {}
): boolean {
  const staticPathVariables = new Map<string, string>();
  let cwdCandidates =
    options.initialCwdCandidates ?? inferredProtectedRawProjectRoots(protectedRawPaths);
  let relativeRawPathsAmbiguous =
    options.treatInitialRelativeRawAsProtected === false || cwdCandidates.length === 0;

  for (const segment of splitStaticShellSegments(command)) {
    const tokens = effectiveShellTokens(tokenizeStaticShellSegment(segment));
    if (tokens.length === 0) {
      continue;
    }

    collectStaticPathAssignments(tokens, staticPathVariables);
    const resolvedTokens = tokens.map((token) => resolveStaticPathToken(token, staticPathVariables));
    const commandTokens = stripShellCommandPrefixes(resolvedTokens);
    const commandName = commandTokens[0] ? normalizeCommandName(commandTokens[0]) : "";

    if (isCwdChangingCommand(commandName)) {
      if ((commandName === "cd" || commandName === "pushd") && commandTokens[1]) {
        const nextCwdCandidates = resolveStaticCwdCandidates(cwdCandidates, commandTokens[1]);
        if (nextCwdCandidates) {
          cwdCandidates = nextCwdCandidates;
          relativeRawPathsAmbiguous = false;
        } else {
          cwdCandidates = [];
          relativeRawPathsAmbiguous = true;
        }
      } else {
        cwdCandidates = [];
        relativeRawPathsAmbiguous = true;
      }
      continue;
    }

    const pathOptions = rawPathResolutionOptions(cwdCandidates, !relativeRawPathsAmbiguous);
    if (
      hasRawDataWriteRedirection(resolvedTokens, protectedRawPaths, {
        ...pathOptions
      })
    ) {
      return true;
    }

    if (
      (commandName === "bash" || commandName === "sh") &&
      hasChildShellRawDataWrite(commandTokens, protectedRawPaths, {
        ...pathOptions
      })
    ) {
      return true;
    }

    if (
      isInterpreterCommand(commandName) &&
      hasInterpreterRawDataWrite(commandTokens, protectedRawPaths, {
        ...pathOptions
      })
    ) {
      return true;
    }

    const operands = extractCommandOperands(commandTokens.slice(1));

    if (
      (commandName === "sed" || commandName === "perl") &&
      hasInPlaceMutationFlag(resolvedTokens) &&
      operands.some((operand) =>
        isRawDataPathToken(operand, protectedRawPaths, {
          ...pathOptions
        })
      )
    ) {
      return true;
    }

    if (
      commandName === "awk" &&
      commandTokens
        .slice(1)
        .some((token) => hasAwkRawWriteTarget(token, protectedRawPaths, { ...pathOptions }))
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
          ...pathOptions
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
              ...pathOptions
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
          ...pathOptions
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
            ...pathOptions
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
            ...pathOptions
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

function commandTokensFromSegment(segment: string): string[] {
  return stripShellCommandPrefixes(effectiveShellTokens(tokenizeStaticShellSegment(segment)));
}

function stripShellCommandPrefixes(tokens: readonly string[]): string[] {
  let index = 0;
  while (index < tokens.length && isShellAssignmentToken(tokens[index])) {
    index += 1;
  }

  if (normalizeCommandName(tokens[index] ?? "") !== "env") {
    return tokens.slice(index);
  }

  index += 1;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token === "--") {
      index += 1;
      break;
    }
    if (token === "-i" || token === "-0" || token === "--ignore-environment" || token === "--null") {
      index += 1;
      continue;
    }
    if (token === "-u" || token === "--unset") {
      index += 2;
      continue;
    }
    if (token.startsWith("-u") && token.length > 2) {
      index += 1;
      continue;
    }
    if (token.startsWith("--unset=")) {
      index += 1;
      continue;
    }
    if (isShellAssignmentToken(token)) {
      index += 1;
      continue;
    }
    break;
  }

  return tokens.slice(index);
}

function isShellAssignmentToken(token: string): boolean {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(token);
}

function rawPathResolutionOptions(
  cwdCandidates: readonly string[],
  treatRelativeRawAsProtected: boolean
): RawPathResolutionOptions {
  return {
    treatRelativeRawAsProtected,
    ...(cwdCandidates.length > 0 ? { cwdCandidates } : {})
  };
}

function resolveStaticCwdCandidates(
  cwdCandidates: readonly string[],
  nextCwd: string
): string[] | undefined {
  if (!isSimpleStaticPathToken(nextCwd) || nextCwd === "-") {
    return undefined;
  }
  if (nextCwd === "~" || nextCwd.startsWith("~/")) {
    return undefined;
  }

  return sortedUnique(
    cwdCandidates.map((cwd) => normalize(resolve(cwd, nextCwd)).replace(/\/+$/, ""))
  );
}

function hasRawDataWriteRedirection(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
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
  options: RawPathResolutionOptions = {}
): boolean {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "-c") {
      return hasStaticRawDataWrite(tokens[index + 1], protectedRawPaths, {
        treatInitialRelativeRawAsProtected: options.treatRelativeRawAsProtected !== false,
        initialCwdCandidates: options.cwdCandidates
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
  options: RawPathResolutionOptions = {}
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
  options: RawPathResolutionOptions = {}
): boolean {
  return (
    hasCallWithRawTargetArgument(payload, /\b(?:writeFile|appendFile)(?:Sync)?/, [0], protectedRawPaths, options) ||
    hasCallWithRawTargetArgument(payload, /\bcreateWriteStream/, [0], protectedRawPaths, options) ||
    hasCallWithRawTargetArgument(payload, /\b(?:File|IO)\.write/, [0], protectedRawPaths, options) ||
    hasOpenCallWithRawWriteTarget(payload, protectedRawPaths, options) ||
    hasPathWriteMethodRawTarget(payload, protectedRawPaths, options) ||
    hasInterpreterDeleteRawTarget(payload, protectedRawPaths, options) ||
    hasInterpreterMoveRawEndpoint(payload, protectedRawPaths, options) ||
    hasInterpreterCopyRawDestination(payload, protectedRawPaths, options) ||
    hasRWriteHelperRawTarget(payload, protectedRawPaths, options)
  );
}

function hasCallWithRawTargetArgument(
  payload: string,
  calleePattern: RegExp,
  argumentIndexes: readonly number[],
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
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
  options: RawPathResolutionOptions = {}
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
    const namedMode = findNamedArgument(args, "mode");
    if (
      args[0] &&
      isRawDataTargetExpression(args[0], protectedRawPaths, options) &&
      namedMode &&
      isWriteModeExpression(namedMode)
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
  options: RawPathResolutionOptions = {}
): boolean {
  const methodPattern = /\.(?:write_text|write_bytes|unlink|rename|replace|open)\s*\(/g;
  let match = methodPattern.exec(payload);
  while (match) {
    const method = match[0].match(/\.([A-Za-z_][A-Za-z0-9_]*)\s*\(/)?.[1];
    const receiver = extractReceiverExpressionBefore(payload, match.index);
    if (!receiver) {
      match = methodPattern.exec(payload);
      continue;
    }
    const receiverIsRaw = isRawDataTargetExpression(receiver, protectedRawPaths, options);
    if (method === "open") {
      const argsText = extractCallArgumentsAtOpenParen(payload, methodPattern.lastIndex - 1);
      const args = argsText ? splitTopLevelArguments(argsText) : [];
      const namedMode = findNamedArgument(args, "mode");
      const mode = namedMode ?? args[0];
      if (receiverIsRaw && mode && isWriteModeExpression(mode)) {
        return true;
      }
    } else if (method === "rename" || method === "replace") {
      const argsText = extractCallArgumentsAtOpenParen(payload, methodPattern.lastIndex - 1);
      const args = argsText ? splitTopLevelArguments(argsText) : [];
      if (
        receiverIsRaw ||
        (args[0] && isRawDataTargetExpression(args[0], protectedRawPaths, options)) ||
        (findNamedArgument(args, "target") &&
          isRawDataTargetExpression(findNamedArgument(args, "target")!, protectedRawPaths, options))
      ) {
        return true;
      }
    } else if (receiverIsRaw) {
      return true;
    }
    match = methodPattern.exec(payload);
  }
  return false;
}

function hasInterpreterDeleteRawTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
): boolean {
  const helpers: readonly {
    callee: RegExp;
    positionalIndexes: readonly number[];
    namedArguments?: readonly string[];
  }[] = [
    {
      callee: /\b(?:os\.)?(?:unlink|remove)\b/,
      positionalIndexes: [0],
      namedArguments: ["path"]
    },
    {
      callee: /\b(?:(?:fs\.)?(?:unlink|unlinkSync|rmSync)|fs\.rm)\b/,
      positionalIndexes: [0],
      namedArguments: ["path"]
    },
    {
      callee: /\bFile\.(?:delete|unlink)\b/,
      positionalIndexes: [0]
    },
    {
      callee: /\bFileUtils\.(?:rm|rm_f|rm_rf)\b/,
      positionalIndexes: [0]
    },
    {
      callee: /\bunlink\b/,
      positionalIndexes: [0],
      namedArguments: ["x"]
    }
  ];

  return hasAnyCallRawTarget(payload, helpers, protectedRawPaths, options);
}

function hasInterpreterMoveRawEndpoint(
  payload: string,
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
): boolean {
  const helpers: readonly {
    callee: RegExp;
    positionalIndexes: readonly number[];
    namedArguments?: readonly string[];
  }[] = [
    {
      callee: /\b(?:os\.|fs\.|File\.)?(?:rename|renameSync|replace|move|mv)\b/,
      positionalIndexes: [0, 1],
      namedArguments: ["src", "dst", "from", "to"]
    },
    {
      callee: /\b(?:shutil\.move|FileUtils\.mv|file\.rename)\b/,
      positionalIndexes: [0, 1],
      namedArguments: ["from", "to"]
    }
  ];

  return hasAnyCallRawTarget(payload, helpers, protectedRawPaths, options);
}

function hasInterpreterCopyRawDestination(
  payload: string,
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
): boolean {
  const helpers: readonly {
    callee: RegExp;
    positionalIndexes: readonly number[];
    namedArguments?: readonly string[];
  }[] = [
    {
      callee: /\b(?:copyFile|copyFileSync)\b/,
      positionalIndexes: [1]
    },
    {
      callee: /\b(?:shutil\.)?(?:copyfile|copy|copy2)\b/,
      positionalIndexes: [1],
      namedArguments: ["dst", "to"]
    },
    {
      callee: /\bFileUtils\.(?:cp|copy|cp_r)\b/,
      positionalIndexes: [1]
    },
    {
      callee: /\bfile\.copy\b/,
      positionalIndexes: [1],
      namedArguments: ["to"]
    }
  ];

  return hasAnyCallRawTarget(payload, helpers, protectedRawPaths, options);
}

function hasAnyCallRawTarget(
  payload: string,
  helpers: readonly {
    callee: RegExp;
    positionalIndexes: readonly number[];
    namedArguments?: readonly string[];
  }[],
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
): boolean {
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
      for (const name of helper.namedArguments ?? []) {
        const namedValue = findNamedArgument(args, name);
        if (namedValue && isRawDataTargetExpression(namedValue, protectedRawPaths, options)) {
          return true;
        }
      }
    }
  }

  return false;
}

function hasRWriteHelperRawTarget(
  payload: string,
  protectedRawPaths: readonly string[],
  options: RawPathResolutionOptions = {}
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
  options: RawPathResolutionOptions = {}
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

function findCallArgumentLists(payload: string, calleePattern: RegExp): string[] {
  return scanCallArgumentLists(payload, calleePattern).calls;
}

interface CallArgumentListScan {
  calls: string[];
  truncated: boolean;
}

function scanCallArgumentLists(
  payload: string,
  calleePattern: RegExp
): CallArgumentListScan {
  const flags = calleePattern.flags.includes("g")
    ? calleePattern.flags
    : `${calleePattern.flags}g`;
  const regex = new RegExp(`${calleePattern.source}\\s*\\(`, flags);
  const calls: string[] = [];
  let match = regex.exec(payload);
  while (match) {
    if (calls.length >= COMMAND_ANALYSIS_MAX_CALLS) {
      return { calls, truncated: true };
    }
    const openIndex = regex.lastIndex - 1;
    const argsText = extractCallArgumentsAtOpenParen(payload, openIndex);
    const endIndex =
      argsText === undefined ? payload.length : openIndex + argsText.length + 1;
    calls.push(argsText ?? payload.slice(openIndex + 1, endIndex));
    regex.lastIndex = endIndex + 1;
    match = regex.exec(payload);
  }
  return { calls, truncated: false };
}

function extractCallArgumentsAtOpenParen(value: string, openIndex: number): string | undefined {
  const closeIndex = findMatchingRightParen(value, openIndex);
  return closeIndex === undefined ? undefined : value.slice(openIndex + 1, closeIndex);
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
  options: RawPathResolutionOptions = {}
): boolean {
  const cleaned = stripOuterParentheses(expression.trim());
  const literal = parseSingleStringLiteral(cleaned);
  if (literal !== undefined) {
    return isRawDataPathToken(literal, protectedRawPaths, options);
  }

  const concatenatedLiteral = parseSimpleConcatenatedStringExpression(cleaned);
  if (
    concatenatedLiteral !== undefined &&
    isRawDataPathToken(concatenatedLiteral, protectedRawPaths, options)
  ) {
    return true;
  }

  const pathConstructor = parsePathConstructorExpression(cleaned);
  if (
    pathConstructor !== undefined &&
    isRawDataPathToken(pathConstructor, protectedRawPaths, options)
  ) {
    return true;
  }

  const joinedPath = parseJoinedStringPath(cleaned);
  if (joinedPath !== undefined) {
    return isRawDataPathToken(joinedPath, protectedRawPaths, options);
  }

  return (
    containsFragmentedRawDataPathSignal(cleaned) &&
    isRawDataPathToken("data/raw", protectedRawPaths, options)
  );
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

function parseSimpleConcatenatedStringExpression(expression: string): string | undefined {
  if (!expression.includes("+")) {
    return undefined;
  }

  const parts = splitTopLevelPlus(expression);
  if (parts.length < 2) {
    return undefined;
  }

  let output = "";
  for (const part of parts) {
    const cleaned = stripOuterParentheses(part.trim());
    const literal = parseSingleStringLiteral(cleaned);
    if (literal !== undefined) {
      output += literal;
      continue;
    }

    const char = parseChrCall(cleaned);
    if (char !== undefined) {
      output += char;
      continue;
    }

    return undefined;
  }

  return output;
}

function splitTopLevelPlus(expression: string): string[] {
  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let depth = 0;

  for (const char of expression) {
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
    if (char === "+" && depth === 0) {
      parts.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }

  if (current.trim() || expression.trim()) {
    parts.push(current.trim());
  }
  return parts;
}

function parseChrCall(expression: string): string | undefined {
  const match = expression.match(/^chr\s*\(\s*(\d{1,7})\s*\)$/);
  if (!match) {
    return undefined;
  }

  const codePoint = Number(match[1]);
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff) {
    return undefined;
  }
  return String.fromCodePoint(codePoint);
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

function parsePathConstructorExpression(expression: string): string | undefined {
  if (!/\b(?:pathlib\.)?Path\s*\(/.test(expression)) {
    return undefined;
  }
  const argsText = findCallArgumentLists(expression, /\b(?:pathlib\.)?Path/)[0];
  if (!argsText) {
    return undefined;
  }
  const firstArg = splitTopLevelArguments(argsText)[0];
  return firstArg ? parseSingleStringLiteral(stripOuterParentheses(firstArg.trim())) : undefined;
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
  options: RawPathResolutionOptions = {}
): boolean {
  if (/[`$*?[\]]/.test(token)) {
    return false;
  }

  const cleaned = token.replace(/\/+$/, "");
  if (!cleaned) {
    return false;
  }

  const normalizedToken = normalize(cleaned);
  if (!isAbsolute(cleaned)) {
    const cwdCandidates = options.cwdCandidates ?? [];
    if (cwdCandidates.length > 0) {
      return cwdCandidates.some((cwd) =>
        isAbsolutePathInsideProtectedRaw(resolve(cwd, cleaned), protectedRawPaths)
      );
    }

    return (
      options.treatRelativeRawAsProtected !== false &&
      isRelativeRawDataPathToken(normalizedToken)
    );
  }

  return isAbsolutePathInsideProtectedRaw(cleaned, protectedRawPaths);
}

function isRelativeRawDataPathToken(normalizedToken: string): boolean {
  return (
    normalizedToken === "data/raw" ||
    normalizedToken.startsWith("data/raw/") ||
    normalizedToken === "./data/raw" ||
    normalizedToken.startsWith("./data/raw/") ||
    /^(?:\.\.\/)+data\/raw(?:\/|$)/.test(normalizedToken)
  );
}

function isAbsolutePathInsideProtectedRaw(
  path: string,
  protectedRawPaths: readonly string[]
): boolean {
  const absoluteToken = normalize(resolve(path)).replace(/\/+$/, "");
  return protectedRawPaths.some((protectedPath) => {
    const root = normalize(resolve(protectedPath)).replace(/\/+$/, "");
    return absoluteToken === root || absoluteToken.startsWith(`${root}/`);
  });
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

function evaluateProcessContainmentPreflight(
  command: string
): { decision: "allow" } | { decision: "deny"; reason: string } {
  const boundedCommand = command.slice(0, PROCESS_PREFLIGHT_ANALYSIS_MAX_LENGTH);
  if (hasSessionEscapeSignal(boundedCommand)) {
    return {
      decision: "deny",
      reason: "command attempts to create an invocation descendant outside the tracked process group"
    };
  }

  if (hasUnwaitedBackgroundExecution(boundedCommand)) {
    return {
      decision: "deny",
      reason: "command starts background work without a static wait before returning"
    };
  }

  return { decision: "allow" };
}

function hasSessionEscapeSignal(command: string): boolean {
  for (const segment of splitStaticShellSegments(command)) {
    const tokens = commandTokensFromSegment(segment);
    if (tokens.length === 0) {
      continue;
    }

    const commandName = normalizeCommandName(tokens[0]);
    if (
      commandName === "setsid" ||
      commandName === "setpgrp" ||
      commandName === "daemonize"
    ) {
      return true;
    }

    if (isInterpreterCommand(commandName)) {
      const payload = interpreterPayload(tokens);
      if (payload && hasInterpreterProcessContainmentRisk(payload, commandName)) {
        return true;
      }
    }
  }

  return false;
}

function hasInterpreterProcessContainmentRisk(payload: string, commandName: string): boolean {
  const code = stripInterpreterLiteralAndCommentText(payload, {
    slashLineComments: hasSlashLineCommentSyntax(commandName)
  });
  return hasInterpreterSessionEscapeSignal(code, commandName);
}

function hasInterpreterSessionEscapeSignal(code: string, commandName: string): boolean {
  return (
    /\b(?:os\.)?(?:setsid|setpgrp)\s*\(/.test(code) ||
    /\bProcess\.(?:daemon|setpgrp)(?:\s*\(|\b)/.test(code) ||
    /\bdaemonize\s*\(/.test(code) ||
    (isPythonCommand(commandName) && hasPythonProcessCreationSessionEscapeSignal(code)) ||
    /\b(?:spawn|exec|execFile|fork)\s*\([\s\S]*\bdetached\s*:\s*true\b/.test(code) ||
    /\bsystem(?:2)?\s*\([\s\S]*\bwait\s*=\s*FALSE\b/.test(code)
  );
}

function hasPythonProcessCreationSessionEscapeSignal(code: string): boolean {
  const pythonProcessCreation = /\b(?:(?:subprocess|asyncio\.subprocess)\.)?(?:Popen|run|call|check_call|check_output|create_subprocess_exec|create_subprocess_shell)\b/;
  for (const argsText of findCallArgumentLists(code, pythonProcessCreation)) {
    if (
      /\bstart_new_session\s*=\s*True\b/.test(argsText) ||
      /\bpreexec_fn\s*=\s*(?:os\.)?(?:setsid|setpgrp)\b/.test(argsText)
    ) {
      return true;
    }
  }
  return false;
}

function isPythonCommand(commandName: string): boolean {
  return /^python(?:\d+(?:\.\d+)?)?$/.test(commandName);
}

function hasSlashLineCommentSyntax(commandName: string): boolean {
  return commandName === "node" || commandName === "bun";
}

function stripInterpreterLiteralAndCommentText(
  payload: string,
  options: { slashLineComments?: boolean } = {}
): string {
  let output = "";
  let quote: "'" | '"' | "`" | undefined;
  let escaped = false;
  let lineComment: "#" | "//" | undefined;

  for (let index = 0; index < payload.length; index += 1) {
    const char = payload[index];
    const next = payload[index + 1];

    if (lineComment) {
      if (char === "\n") {
        lineComment = undefined;
        output += "\n";
      } else {
        output += " ";
      }
      continue;
    }

    if (escaped) {
      output += " ";
      escaped = false;
      continue;
    }

    if (quote) {
      if (char === "\\") {
        escaped = true;
      } else if (char === quote) {
        quote = undefined;
      }
      output += " ";
      continue;
    }

    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      output += " ";
      continue;
    }

    if (char === "#") {
      lineComment = "#";
      output += " ";
      continue;
    }

    if (options.slashLineComments && char === "/" && next === "/") {
      lineComment = "//";
      output += "  ";
      index += 1;
      continue;
    }

    output += char;
  }

  return output;
}

function hasUnwaitedBackgroundExecution(command: string): boolean {
  let current = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let depth = 0;
  let hasPendingBackground = false;
  let sawBackground = false;
  let previousSeparator: ShellSegmentSeparator = "start";

  const consumeSegment = (nextSeparator: ShellSegmentSeparator) => {
    const segment = current.trim();
    if (!segment) {
      current = "";
      previousSeparator = nextSeparator;
      return;
    }
    if (
      hasPendingBackground &&
      isParentShellWaitSegment(segment, previousSeparator, nextSeparator)
    ) {
      hasPendingBackground = false;
    }
    current = "";
    previousSeparator = nextSeparator;
  };

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
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
    if (char === "(" || (char === "{" && command[index - 1] !== "$")) {
      depth += 1;
      current += char;
      continue;
    }
    if (char === ")" || char === "}") {
      depth = Math.max(0, depth - 1);
      current += char;
      continue;
    }
    if (depth === 0 && (char === ";" || char === "\n" || char === "|")) {
      consumeSegment(char);
      continue;
    }
    if (char !== "&") {
      current += char;
      continue;
    }

    const previous = command[index - 1];
    const next = command[index + 1];
    if (
      next === "&" ||
      previous === "&" ||
      previous === "<" ||
      previous === ">" ||
      next === ">" ||
      /\d/.test(next ?? "")
    ) {
      current += char;
      continue;
    }

    if (depth > 0) {
      current += char;
      continue;
    }

    consumeSegment("&");
    hasPendingBackground = true;
    sawBackground = true;
  }

  consumeSegment("end");
  return sawBackground && hasPendingBackground;
}

type ShellSegmentSeparator = "start" | "end" | ";" | "\n" | "|" | "&";

function isParentShellWaitSegment(
  segment: string,
  previousSeparator: ShellSegmentSeparator,
  nextSeparator: ShellSegmentSeparator
): boolean {
  if (previousSeparator === "|" || nextSeparator === "|") {
    return false;
  }
  const tokens = stripShellCommandPrefixes(tokenizeStaticShellSegment(segment));
  return tokens.length > 0 && normalizeCommandName(tokens[0]) === "wait";
}

function rawDataGuardClassForRawData(): RawDataGuardClass {
  return "authority";
}

function hasKnownRawDataWriteTarget(
  command: string,
  protectedRawPaths: readonly string[],
  known?: { staticRawWrite?: boolean }
): boolean {
  return (
    (known?.staticRawWrite ?? hasStaticRawDataWrite(command, protectedRawPaths)) ||
    hasParentRelativeRawDataWriteAlias(command, protectedRawPaths) ||
    hasDynamicRawDataWriteRisk(command)
  );
}

function pathSegmentsFromAbsolute(path: string): string[] {
  const root = resolveRoot(path);
  return path.slice(root.length).split("/").filter(Boolean);
}

function hasParentRelativeRawDataWriteAlias(
  command: string,
  protectedRawPaths: readonly string[]
): boolean {
  if (!/(?:^|[\s"'`(])(?:\.\.\/)+data\/raw(?:\/|[\s"'`),:]|$)/.test(command)) {
    return false;
  }

  return inferredProtectedRawProjectRoots(protectedRawPaths).some((initialCwd) =>
    hasParentRelativeRawDataWriteAliasFromCwd(command, protectedRawPaths, initialCwd)
  );
}

function inferredProtectedRawProjectRoots(protectedRawPaths: readonly string[]): string[] {
  return sortedUnique(
    protectedRawPaths.map((protectedRawPath) => {
      const normalizedRawPath = normalize(resolve(protectedRawPath)).replace(/\/+$/, "");
      if (basename(normalizedRawPath) === "raw" && basename(dirname(normalizedRawPath)) === "data") {
        return dirname(dirname(normalizedRawPath));
      }
      return dirname(normalizedRawPath);
    })
  );
}

function hasParentRelativeRawDataWriteAliasFromCwd(
  command: string,
  protectedRawPaths: readonly string[],
  initialCwd: string
): boolean {
  let cwd = initialCwd;

  for (const segment of splitStaticShellSegments(command)) {
    const tokens = commandTokensFromSegment(segment);
    if (tokens.length === 0) {
      continue;
    }

    const commandName = normalizeCommandName(tokens[0]);
    if (commandName === "cd" || commandName === "pushd") {
      const nextCwd = tokens[1];
      if (nextCwd && isSimpleStaticPathToken(nextCwd)) {
        cwd = normalize(resolve(cwd, nextCwd));
      }
      continue;
    }

    if (
      (commandName === "bash" || commandName === "sh") &&
      hasChildShellParentRelativeRawDataWrite(tokens, protectedRawPaths, cwd)
    ) {
      return true;
    }

    if (hasParentRelativeRawDataWriteRedirection(tokens, protectedRawPaths, cwd)) {
      return true;
    }

    const operands = extractCommandOperands(tokens.slice(1));
    if (operands.length === 0) {
      continue;
    }

    if (commandName === "cp") {
      const destination = operands.at(-1);
      if (
        destination &&
        isParentRelativeRawDataPathResolvedToProtected(destination, cwd, protectedRawPaths)
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
            isParentRelativeRawDataPathResolvedToProtected(
              outputMatch[1],
              cwd,
              protectedRawPaths
            )
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
        isParentRelativeRawDataPathResolvedToProtected(destination, cwd, protectedRawPaths)
      ) {
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
      if (
        operands.some((operand) =>
          isParentRelativeRawDataPathResolvedToProtected(operand, cwd, protectedRawPaths)
        )
      ) {
        return true;
      }
    }
  }

  return false;
}

function hasChildShellParentRelativeRawDataWrite(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  cwd: string
): boolean {
  for (let index = 1; index < tokens.length - 1; index += 1) {
    if (tokens[index] === "-c") {
      return hasParentRelativeRawDataWriteAliasFromCwd(
        tokens[index + 1],
        protectedRawPaths,
        cwd
      );
    }
  }

  return false;
}

function hasParentRelativeRawDataWriteRedirection(
  tokens: readonly string[],
  protectedRawPaths: readonly string[],
  cwd: string
): boolean {
  for (let index = 0; index < tokens.length - 1; index += 1) {
    if (
      isWriteRedirectionToken(tokens[index]) &&
      isParentRelativeRawDataPathResolvedToProtected(tokens[index + 1], cwd, protectedRawPaths)
    ) {
      return true;
    }
  }

  return false;
}

function isParentRelativeRawDataPathResolvedToProtected(
  token: string,
  cwd: string,
  protectedRawPaths: readonly string[]
): boolean {
  if (!isParentRelativeRawDataPathToken(token)) {
    return false;
  }

  const resolvedPath = normalize(resolve(cwd, token)).replace(/\/+$/, "");
  return protectedRawPaths.some((protectedRawPath) => {
    const root = normalize(resolve(protectedRawPath)).replace(/\/+$/, "");
    return resolvedPath === root || resolvedPath.startsWith(`${root}/`);
  });
}

function isParentRelativeRawDataPathToken(token: string): boolean {
  if (/[`$*?[\]]/.test(token)) {
    return false;
  }

  const normalizedToken = normalize(token.replace(/\/+$/, ""));
  return /^(?:\.\.\/)+data\/raw(?:\/|$)/.test(normalizedToken);
}

function isSimpleStaticPathToken(token: string): boolean {
  return !/[`$*?[\]]/.test(token);
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
  const protectedRawRealPaths = await canonicalizePathSet(protectedRawPaths);
  const workspaceRealPath = await resolvePolicyGateAuditWorkspaceRoot(
    workspaceRoot,
    protectedRawRealPaths
  );
  let current = workspaceRealPath;

  for (const segment of ["tasks", taskId, "audit"]) {
    current = join(current, segment);
    await ensureSafeAuditDirComponent(current, workspaceRealPath, protectedRawRealPaths);
  }

  const auditPath = join(current, fileName);
  const handle = await openAuditFileForAppendNoFollow(auditPath);
  const metadata = await handle.stat();

  return {
    auditDir: current,
    auditPath,
    protectedEvidencePath: current,
    handle,
    dev: metadata.dev,
    ino: metadata.ino
  };
}

async function resolvePolicyGateAuditWorkspaceRoot(
  workspaceRoot: string,
  protectedRawPaths: readonly string[]
): Promise<string> {
  const rootRealPath = await ensureDirectoryOutsideProtectedRaw(
    workspaceRoot,
    protectedRawPaths,
    "policy gate audit workspace root"
  );

  if (await hasProjectRootWorkspaceLayout(rootRealPath, protectedRawPaths)) {
    return ensureDirectoryOutsideProtectedRaw(
      join(rootRealPath, "workspace"),
      protectedRawPaths,
      "policy gate audit workspace root"
    );
  }

  return rootRealPath;
}

async function hasProjectRootWorkspaceLayout(
  rootRealPath: string,
  protectedRawPaths: readonly string[]
): Promise<boolean> {
  const projectRawRoot = normalize(resolve(rootRealPath, "data", "raw")).replace(/\/+$/, "");
  return protectedRawPaths.some((protectedRawPath) => {
    const normalizedProtectedPath = normalize(resolve(protectedRawPath)).replace(/\/+$/, "");
    return (
      normalizedProtectedPath === projectRawRoot ||
      normalizedProtectedPath.startsWith(`${projectRawRoot}/`)
    );
  });
}

function assertProtectedRawPathsProvided(
  protectedRawPaths: readonly string[] | undefined
): asserts protectedRawPaths is readonly string[] {
  if (!Array.isArray(protectedRawPaths) || protectedRawPaths.length === 0) {
    throw new Error("protectedRawPaths is required for policy gate audit writes.");
  }
}

function assertAbsoluteRoots(paths: readonly string[], label: string): void {
  for (const path of paths) {
    assertAbsoluteRoot(path, label);
  }
}

function assertAbsoluteRoot(path: string, label: string): void {
  if (!isAbsolute(path)) {
    throw new Error(`${label} must be absolute: ${path}`);
  }
}

function isRawDataDenialDecision(decision: string): boolean {
  return decision === "denied_by_advisory" || decision === "denied_by_sandbox";
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

async function cleanupRawDataSeatbeltProfileFile(
  ctx: ToolContext,
  profileFile: RawDataSeatbeltProfileFile
): Promise<void> {
  const check = await verifyProfileRunRootForCleanup(profileFile);
  if (!check.ok) {
    ctx.logger.warn("raw_data_sandbox_profile_cleanup_skipped", {
      profile_path: profileFile.profilePath,
      run_root: profileFile.runRoot,
      original_run_root: profileFile.runRootRealPath,
      reason: check.reason
    });
    return;
  }

  try {
    await rm(profileFile.runRoot, { recursive: true, force: true });
  } catch (error) {
    ctx.logger.warn("raw_data_sandbox_profile_cleanup_failed", {
      profile_path: profileFile.profilePath,
      run_root: profileFile.runRoot,
      error: errorMessage(error)
    });
  }
}

async function verifyProfileRunRootForCleanup(
  profileFile: RawDataSeatbeltProfileFile
): Promise<{ ok: true } | { ok: false; reason: string }> {
  let metadata: Awaited<ReturnType<typeof lstat>>;
  try {
    metadata = await lstat(profileFile.runRoot);
  } catch (error) {
    return {
      ok: false,
      reason: `profile run directory cannot be inspected: ${errorMessage(error)}`
    };
  }

  if (metadata.isSymbolicLink()) {
    return {
      ok: false,
      reason: "profile run directory path is now a symlink"
    };
  }
  if (!metadata.isDirectory()) {
    return {
      ok: false,
      reason: "profile run directory path is no longer a directory"
    };
  }

  let currentRealPath: string;
  try {
    currentRealPath = await canonicalizeExistingPath(profileFile.runRoot);
  } catch (error) {
    return {
      ok: false,
      reason: `profile run directory realpath cannot be proven: ${errorMessage(error)}`
    };
  }

  if (currentRealPath !== profileFile.runRootRealPath) {
    return {
      ok: false,
      reason: "profile run directory realpath drifted"
    };
  }
  if (metadata.dev !== profileFile.runRootDev || metadata.ino !== profileFile.runRootIno) {
    return {
      ok: false,
      reason: "profile run directory identity drifted"
    };
  }

  return { ok: true };
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
