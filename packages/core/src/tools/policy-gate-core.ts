import { types as nodeUtilTypes } from "node:util";
import { z } from "zod";
import { RemediationNextActionSchema } from "../domain/schemas";
import {
  getRoleToolIds,
  isCanonicalHarnessRole,
  isRoleToolIdAllowed
} from "./role-tool-map";

export type HarnessRole = "coordinator" | "repo_explorer" | "worker" | "coder" | "reviewer";

// Policy-gate denials require a navigable ref, even though generic ErrorRecord.ref is optional.
export const PolicyGateRemediationSchema = z.object({
  next_action: RemediationNextActionSchema,
  hint: z.string().min(1),
  ref: z.string().min(1)
});

export type PolicyGateRemediation = z.infer<typeof PolicyGateRemediationSchema>;
export const PolicyGuardClassSchema = z.enum(["authority", "capability"]);
export type PolicyGuardClass = z.infer<typeof PolicyGuardClassSchema>;

export const SPAWN_PROFILE_SUBSET_RULE_ID = "spawn-profile-subset";
export const SPAWN_DEPTH_LIMIT_RULE_ID = "spawn-depth-limit";
export const SPAWN_CONCURRENCY_LIMIT_RULE_ID = "spawn-concurrency-limit";
export const TOOL_PARAMETER_SCHEMA_RULE_ID = "tool-parameter-schema-validation";
export const SPAWN_PROFILE_SUBSET_POLICY_REF =
  "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry";
export const SPAWN_LIMITS_POLICY_REF =
  "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定";
export const MAX_SPAWN_DEPTH = 1;
export const MAX_CONCURRENT_SUBAGENTS = 3;
export const SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS = 64;
export const SPAWN_PROFILE_TOOL_ID_MAX_CHARS = 128;
export const SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS = 4096;
export const SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES = 5;
export const SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS = 64;
export const SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS = 65536;
export const RESERVED_AUTHORITY_POLICY_RULE_IDS = Object.freeze([
  "raw-data-write",
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_DEPTH_LIMIT_RULE_ID,
  SPAWN_CONCURRENCY_LIMIT_RULE_ID,
  TOOL_PARAMETER_SCHEMA_RULE_ID
] as const);

export interface PolicyGateToolCall {
  toolId: string;
  role: HarnessRole | "unknown";
  input: unknown;
  workDir?: string;
  spawnDepth?: number;
  activeSubagentCount?: number;
}

export type PolicyRuleDecision =
  | {
      decision: "allow";
    }
  | {
      decision: "deny";
      reason: string;
      remediation: PolicyGateRemediation;
      guardClass?: PolicyGuardClass;
      guard_class?: PolicyGuardClass;
    };

export type PolicyGateDecision =
  | {
      decision: "allow";
    }
  | {
      decision: "deny";
      ruleId: string;
      reason: string;
      remediation: PolicyGateRemediation;
      guardClass: PolicyGuardClass;
    };

type PolicyGateDenyGuardClassInput =
  | {
      guardClass: PolicyGuardClass;
      guard_class?: PolicyGuardClass;
    }
  | {
      guardClass?: PolicyGuardClass;
      guard_class: PolicyGuardClass;
    };

export type PolicyGateDecisionInput =
  | {
      decision: "allow";
    }
  | ({
      decision: "deny";
      ruleId: string;
      reason: string;
      remediation: PolicyGateRemediation;
    } & PolicyGateDenyGuardClassInput);

export type PolicyGateInputNormalization =
  | {
      decision: "allow";
      input: unknown;
      changed: boolean;
    }
  | Extract<PolicyGateDecision, { decision: "deny" }>;

type PolicyRuleGuardClassMetadata =
  | {
      guardClass: PolicyGuardClass;
      guard_class?: PolicyGuardClass;
    }
  | {
      guardClass?: PolicyGuardClass;
      guard_class: PolicyGuardClass;
    };

export type PolicyRule = {
  ruleId: string;
  description: string;
  evaluate(call: PolicyGateToolCall, context: PolicyGateContext): PolicyRuleDecision;
} & PolicyRuleGuardClassMetadata;

type PolicyGuardClassAliasRead =
  | { state: "missing" }
  | { state: "invalid"; fields: readonly string[] }
  | { state: "conflicting"; fields: readonly string[] }
  | { state: "valid"; guardClass: PolicyGuardClass; field: string };

type PolicyGuardClassAliasValueRead =
  | { state: "missing" }
  | { state: "invalid" }
  | { state: "valid"; guardClass: PolicyGuardClass };

type ValidatedPolicyRuleMetadata = {
  rule: PolicyRule;
  ruleId: string;
  guardClass: PolicyGuardClass;
};

type PolicyRuleDecisionDataDescriptor = PropertyDescriptor & {
  value: unknown;
};

type PolicyRuleDecisionSnapshot = Record<string, unknown> & {
  decision?: unknown;
  reason?: unknown;
  remediation?: unknown;
  guardClass?: unknown;
  guard_class?: unknown;
};

export interface PolicyGateContext {
  rules: readonly PolicyRule[];
}

export const EMPTY_POLICY_GATE_CONTEXT: PolicyGateContext = {
  rules: []
};

const KNOWN_AUTHORITY_POLICY_RULE_IDS = new Set<string>(RESERVED_AUTHORITY_POLICY_RULE_IDS);

export class PolicyGateDecisionValidationError extends Error {
  constructor(error: unknown) {
    super(formatPolicyGateDecisionValidationErrorMessage(error));
    this.name = "PolicyGateDecisionValidationError";
  }
}

export function isPolicyGateDecisionValidationError(
  error: unknown
): error is PolicyGateDecisionValidationError {
  return error instanceof PolicyGateDecisionValidationError;
}

function policyGateDecisionValidationError(message: string): PolicyGateDecisionValidationError {
  return new PolicyGateDecisionValidationError(message);
}

function formatPolicyGateDecisionValidationErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return String(error);
}

export function isReservedAuthorityPolicyRuleId(ruleId: string): boolean {
  return KNOWN_AUTHORITY_POLICY_RULE_IDS.has(ruleId);
}

export function isReservedAuthorityPolicyErrorId(errorId: string | undefined): boolean {
  return (
    errorId !== undefined &&
    RESERVED_AUTHORITY_POLICY_RULE_IDS.some(
      (ruleId) => errorId === ruleId || errorId.startsWith(`${ruleId}:`)
    )
  );
}

export function isReservedAuthorityPolicyRuleIdPrefixImpersonation(
  ruleId: string | undefined
): boolean {
  return (
    ruleId !== undefined &&
    RESERVED_AUTHORITY_POLICY_RULE_IDS.some(
      (reservedRuleId) => ruleId.startsWith(`${reservedRuleId}:`)
    )
  );
}

export const isReservedAuthorityPolicyEvidenceId = isReservedAuthorityPolicyErrorId;

export function evaluatePolicyGate(
  call: PolicyGateToolCall,
  context: PolicyGateContext = EMPTY_POLICY_GATE_CONTEXT
): PolicyGateDecision {
  const metadata = validatePolicyGateContextMetadata(context);

  for (const { rule, ruleId, guardClass } of metadata) {
    const result = snapshotPolicyRuleDecisionResult(ruleId, rule.evaluate(call, context));
    if (result.decision === "allow") {
      continue;
    }
    if (result.decision !== "deny") {
      throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
    }

    const reason = validatePolicyRuleDenyReason(ruleId, result.reason);
    const remediation = validatePolicyGateRemediation(ruleId, result.remediation);
    const normalizedGuardClass = normalizePolicyRuleDenyGuardClass(
      ruleId,
      guardClass,
      result
    );
    return {
      decision: "deny",
      ruleId,
      reason,
      remediation,
      guardClass: normalizedGuardClass
    };
  }

  return { decision: "allow" };
}

const POLICY_RULE_DENY_DECISION_SNAPSHOT_KEYS = Object.freeze([
  "reason",
  "remediation",
  "guardClass",
  "guard_class"
] as const);
const POLICY_RULE_REMEDIATION_SNAPSHOT_KEYS = Object.freeze([
  "next_action",
  "hint",
  "ref"
] as const);

function snapshotPolicyRuleDecisionResult(
  ruleId: string,
  result: unknown
): PolicyRuleDecisionSnapshot {
  if (result === null || typeof result !== "object") {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
  }

  const objectResult = result as object;
  if (nodeUtilTypes.isProxy(objectResult)) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "decision");
  }

  assertNoEnumerablePolicyRuleDecisionToJson(ruleId, objectResult);

  const snapshot = Object.create(null) as PolicyRuleDecisionSnapshot;
  snapshotPolicyRuleDecisionField(ruleId, objectResult, snapshot, "decision", "decision");
  if (snapshot.decision !== "deny") {
    return snapshot;
  }

  for (const key of POLICY_RULE_DENY_DECISION_SNAPSHOT_KEYS) {
    snapshotPolicyRuleDecisionField(ruleId, objectResult, snapshot, key, key);
  }

  if (Object.prototype.hasOwnProperty.call(snapshot, "remediation")) {
    snapshot.remediation = snapshotPolicyRuleRemediationCandidate(
      ruleId,
      snapshot.remediation
    );
  }

  return snapshot;
}

function assertNoEnumerablePolicyRuleDecisionToJson(ruleId: string, result: object): void {
  const descriptor = readPolicyRuleDecisionOwnDescriptor(ruleId, result, "toJSON", "toJSON");
  if (descriptor?.enumerable) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "toJSON");
  }
}

function snapshotPolicyRuleDecisionField(
  ruleId: string,
  source: object,
  snapshot: PolicyRuleDecisionSnapshot | Record<string, unknown>,
  key: string,
  fieldPath: string
): void {
  const descriptor = readPolicyRuleDecisionOwnDescriptor(ruleId, source, key, fieldPath);
  if (!descriptor) {
    return;
  }
  assertPolicyRuleDecisionDataDescriptor(ruleId, descriptor, fieldPath);
  snapshot[key] = descriptor.value;
}

function snapshotPolicyRuleRemediationCandidate(ruleId: string, remediation: unknown): unknown {
  if (remediation === null || typeof remediation !== "object") {
    return remediation;
  }

  const objectRemediation = remediation as object;
  if (nodeUtilTypes.isProxy(objectRemediation)) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "remediation");
  }

  const snapshot = Object.create(null) as Record<string, unknown>;
  for (const key of POLICY_RULE_REMEDIATION_SNAPSHOT_KEYS) {
    snapshotPolicyRuleDecisionField(
      ruleId,
      objectRemediation,
      snapshot,
      key,
      `remediation.${key}`
    );
  }
  return snapshot;
}

function readPolicyRuleDecisionOwnDescriptor(
  ruleId: string,
  source: object,
  key: string,
  fieldPath: string
): PropertyDescriptor | undefined {
  try {
    return Object.getOwnPropertyDescriptor(source, key);
  } catch {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, fieldPath);
  }
}

function assertPolicyRuleDecisionDataDescriptor(
  ruleId: string,
  descriptor: PropertyDescriptor,
  fieldPath: string
): asserts descriptor is PolicyRuleDecisionDataDescriptor {
  if (
    !("value" in descriptor) ||
    descriptor.get !== undefined ||
    descriptor.set !== undefined
  ) {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, fieldPath);
  }
}

function validatePolicyRuleDenyReason(ruleId: string, reason: unknown): string {
  if (typeof reason !== "string") {
    throw invalidPolicyRuleDecisionSnapshot(ruleId, "reason");
  }
  return reason;
}

function invalidPolicyRuleDecisionSnapshot(
  ruleId: string,
  fieldPath: string
): PolicyGateDecisionValidationError {
  return policyGateDecisionValidationError(
    `Invalid policy gate decision for ${ruleId}: ${fieldPath}`
  );
}

function normalizePolicyRuleDenyGuardClass(
  ruleId: string,
  ruleGuardClass: PolicyGuardClass,
  result: Pick<PolicyRuleDecisionSnapshot, "guardClass" | "guard_class">
): PolicyGuardClass {
  const resultGuardClass = readPolicyGuardClassAliases(result);
  if (resultGuardClass.state === "missing") {
    return ruleGuardClass;
  }
  if (resultGuardClass.state === "invalid") {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: invalid result ${resultGuardClass.fields.join(", ")}.`
    );
  }
  if (resultGuardClass.state === "conflicting") {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: conflicting result ${resultGuardClass.fields.join(", ")}.`
    );
  }
  if (resultGuardClass.guardClass !== ruleGuardClass) {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${ruleId}: result ${resultGuardClass.field} ${resultGuardClass.guardClass} conflicts with rule guardClass ${ruleGuardClass}.`
    );
  }

  return ruleGuardClass;
}

export function assertPolicyGateContextGuardClasses(context: PolicyGateContext): void {
  validatePolicyGateContextMetadata(context);
}

export function snapshotPolicyGateContext(context: PolicyGateContext): PolicyGateContext {
  const metadata = validatePolicyGateContextMetadata(context);
  const rules = metadata.map(({ rule, ruleId, guardClass }) => {
    const evaluate = rule.evaluate.bind(rule);
    return Object.freeze({
      ruleId,
      description: rule.description,
      guardClass,
      evaluate(call: PolicyGateToolCall, snapshotContext: PolicyGateContext): PolicyRuleDecision {
        return evaluate(call, snapshotContext);
      }
    });
  });

  return Object.freeze({
    rules: Object.freeze(rules)
  });
}

function validatePolicyGateContextMetadata(
  context: PolicyGateContext
): ValidatedPolicyRuleMetadata[] {
  const ruleIdFailures: string[] = [];
  const guardClassFailures: string[] = [];
  const metadata: ValidatedPolicyRuleMetadata[] = [];
  const seenRuleIds = new Map<string, string>();

  context.rules.forEach((rule, index) => {
    const ruleLabel = formatPolicyRuleId(rule, index);
    const ruleId = normalizePolicyRuleId(rule.ruleId);
    if (!ruleId) {
      ruleIdFailures.push(`${ruleLabel}: ruleId must be a non-empty string`);
    } else {
      const previousRuleLabel = seenRuleIds.get(ruleId);
      if (previousRuleLabel) {
        ruleIdFailures.push(
          `${ruleId}: duplicate ruleId also used by ${previousRuleLabel}`
        );
      } else {
        seenRuleIds.set(ruleId, ruleLabel);
      }
      if (isReservedAuthorityPolicyRuleIdPrefixImpersonation(ruleId)) {
        ruleIdFailures.push(
          `${ruleId}: reserved authority policy rule prefixes are reserved for error_id`
        );
      }
    }

    const guardClass = readPolicyGuardClassAliases(rule);
    if (guardClass.state === "missing" || guardClass.state === "invalid") {
      guardClassFailures.push(`${ruleLabel}: missing or invalid guardClass/guard_class`);
      return;
    }
    if (guardClass.state === "conflicting") {
      guardClassFailures.push(`${ruleLabel}: conflicting guardClass/guard_class`);
      return;
    }

    if (
      ruleId &&
      isReservedAuthorityPolicyRuleId(ruleId) &&
      guardClass.guardClass !== "authority"
    ) {
      guardClassFailures.push(
        `${ruleId}: known authority rule cannot be classified as ${guardClass.guardClass}`
      );
      return;
    }

    if (ruleId) {
      metadata.push({ rule, ruleId, guardClass: guardClass.guardClass });
    }
  });

  if (ruleIdFailures.length > 0) {
    throw policyGateDecisionValidationError(
      `Policy gate ruleId lint failed: ${ruleIdFailures.join("; ")}.`
    );
  }

  if (guardClassFailures.length > 0) {
    throw policyGateDecisionValidationError(
      `Policy gate guard_class lint failed: ${guardClassFailures.join("; ")}.`
    );
  }

  return metadata;
}

function readPolicyGuardClassAliases(carrier: {
  guardClass?: unknown;
  guard_class?: unknown;
}): PolicyGuardClassAliasRead {
  const camelGuardClass = parsePolicyRuleGuardClassValue(carrier.guardClass);
  const snakeGuardClass = parsePolicyRuleGuardClassValue(carrier.guard_class);
  const invalidFields: string[] = [];
  if (camelGuardClass.state === "invalid") {
    invalidFields.push("guardClass");
  }
  if (snakeGuardClass.state === "invalid") {
    invalidFields.push("guard_class");
  }
  if (invalidFields.length > 0) {
    return { state: "invalid", fields: invalidFields };
  }

  if (camelGuardClass.state === "valid" && snakeGuardClass.state === "valid") {
    if (camelGuardClass.guardClass !== snakeGuardClass.guardClass) {
      return { state: "conflicting", fields: ["guardClass", "guard_class"] };
    }
    return {
      state: "valid",
      guardClass: camelGuardClass.guardClass,
      field: "guardClass/guard_class"
    };
  }
  if (camelGuardClass.state === "valid") {
    return {
      state: "valid",
      guardClass: camelGuardClass.guardClass,
      field: "guardClass"
    };
  }
  if (snakeGuardClass.state === "valid") {
    return {
      state: "valid",
      guardClass: snakeGuardClass.guardClass,
      field: "guard_class"
    };
  }

  return { state: "missing" };
}

function parsePolicyRuleGuardClassValue(value: unknown): PolicyGuardClassAliasValueRead {
  if (value === undefined) {
    return { state: "missing" };
  }
  const parsed = PolicyGuardClassSchema.safeParse(value);
  return parsed.success
    ? { state: "valid", guardClass: parsed.data }
    : { state: "invalid" };
}

function normalizePolicyRuleId(ruleId: unknown): string | undefined {
  if (typeof ruleId !== "string") {
    return undefined;
  }
  const trimmedRuleId = ruleId.trim();
  return trimmedRuleId === "" ? undefined : trimmedRuleId;
}

function formatPolicyRuleId(rule: Pick<PolicyRule, "ruleId">, index: number): string {
  return typeof rule.ruleId === "string" && rule.ruleId.trim() !== ""
    ? rule.ruleId
    : `<rule-${index}>`;
}

export const SPAWN_PROFILE_SUBSET_RULE: PolicyRule = Object.freeze({
  ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
  description:
    "Reject spawn_agent allowlists that add tools outside the target role's canonical profile.",
  guardClass: "authority",
  evaluate(call: PolicyGateToolCall): PolicyRuleDecision {
    return evaluateSpawnProfileSubset(call);
  }
});

export const SPAWN_DEPTH_LIMIT_RULE: PolicyRule = Object.freeze({
  ruleId: SPAWN_DEPTH_LIMIT_RULE_ID,
  description: "Reject spawn_agent calls that would exceed Control_Kernel max_spawn_depth.",
  guardClass: "authority",
  evaluate(call: PolicyGateToolCall): PolicyRuleDecision {
    return evaluateSpawnDepthLimit(call);
  }
});

export const SPAWN_CONCURRENCY_LIMIT_RULE: PolicyRule = Object.freeze({
  ruleId: SPAWN_CONCURRENCY_LIMIT_RULE_ID,
  description:
    "Reject spawn_agent calls when active subagents already meet max_concurrent_subagents.",
  guardClass: "authority",
  evaluate(call: PolicyGateToolCall): PolicyRuleDecision {
    return evaluateSpawnConcurrencyLimit(call);
  }
});

export function evaluateSpawnProfileSubset(call: PolicyGateToolCall): PolicyRuleDecision {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow" };
  }

  const parsed = parseSpawnAgentInputSnapshot(call.input);
  if (parsed.decision === "deny") {
    return parsed;
  }

  return evaluateSpawnProfileSubsetSnapshot(parsed.snapshot);
}

export function evaluateSpawnDepthLimit(call: PolicyGateToolCall): PolicyRuleDecision {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow" };
  }

  const spawnDepth = readTrustedSpawnLimitCount(call.spawnDepth);
  if (spawnDepth.kind === "missing") {
    return { decision: "allow" };
  }
  if (spawnDepth.kind === "invalid") {
    return buildSpawnDepthLimitDeny(MAX_SPAWN_DEPTH);
  }
  if (spawnDepth.value < MAX_SPAWN_DEPTH) {
    return { decision: "allow" };
  }

  return buildSpawnDepthLimitDeny(spawnDepth.value);
}

export function evaluateSpawnConcurrencyLimit(call: PolicyGateToolCall): PolicyRuleDecision {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow" };
  }

  const activeSubagentCount = readTrustedSpawnLimitCount(call.activeSubagentCount);
  if (activeSubagentCount.kind === "missing") {
    return { decision: "allow" };
  }
  if (activeSubagentCount.kind === "invalid") {
    return buildSpawnConcurrencyLimitDeny(MAX_CONCURRENT_SUBAGENTS);
  }
  if (activeSubagentCount.value < MAX_CONCURRENT_SUBAGENTS) {
    return { decision: "allow" };
  }

  return buildSpawnConcurrencyLimitDeny(activeSubagentCount.value);
}

export function normalizeSpawnAgentInput(
  call: PolicyGateToolCall
): PolicyGateInputNormalization {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow", input: call.input, changed: false };
  }

  const parsed = parseSpawnAgentInputSnapshot(call.input);
  if (parsed.decision === "deny") {
    return toSpawnProfileGateDeny(parsed);
  }

  const ruleDecision = evaluateSpawnProfileSubsetSnapshot(parsed.snapshot);
  if (ruleDecision.decision === "deny") {
    return toSpawnProfileGateDeny(ruleDecision);
  }

  return {
    decision: "allow",
    input: buildSpawnExecutionInput(parsed.snapshot),
    changed: true
  };
}

type SpawnAllowlistField = "tools" | "allowed_tools";

const SPAWN_AGENT_STRING_FIELDS = Object.freeze([
  "instruction",
  "label",
  "mode",
  "agentInstruction",
  "model"
] as const);

const SPAWN_AGENT_SNAPSHOT_FIELDS = Object.freeze([
  ...SPAWN_AGENT_STRING_FIELDS,
  "role",
  "tools",
  "allowed_tools"
] as const);

type SpawnAgentStringField = (typeof SPAWN_AGENT_STRING_FIELDS)[number];
type SpawnAgentSnapshotField = (typeof SPAWN_AGENT_SNAPSHOT_FIELDS)[number];

type SpawnProfileRuleDeny = Extract<PolicyRuleDecision, { decision: "deny" }>;

type SpawnFieldSnapshot = {
  values: Partial<Record<SpawnAgentSnapshotField, unknown>>;
  presentFields: ReadonlySet<SpawnAgentSnapshotField>;
};

type SpawnFieldSnapshotResult =
  | {
      decision: "allow";
      values: Partial<Record<SpawnAgentSnapshotField, unknown>>;
      presentFields: ReadonlySet<SpawnAgentSnapshotField>;
    }
  | SpawnProfileRuleDeny;

type SpawnRoleSnapshot =
  | {
      kind: "omitted";
      label: string;
    }
  | {
      kind: "present";
      value: string;
      label: string;
      canonicalRole?: HarnessRole;
    };

type SpawnAllowlistRead =
  | {
      kind: "omitted";
    }
  | {
      kind: "invalid";
      field: SpawnAllowlistField;
    }
  | {
      kind: "empty";
      field: SpawnAllowlistField;
    }
  | {
      kind: "budget_exceeded";
      field: SpawnAllowlistField;
      budget: "item_count" | "tool_id_length" | "total_characters";
      limit: number;
      actual: number;
    }
  | {
      kind: "valid";
      field: SpawnAllowlistField;
      toolIds: readonly string[];
    }
  | {
      kind: "dual";
      toolIds: readonly string[];
      toolsToolIds: readonly string[];
      allowedToolsToolIds: readonly string[];
    };

type SpawnAgentInputSnapshot = {
  fields: ReadonlyMap<SpawnAgentStringField, string>;
  role: SpawnRoleSnapshot;
  allowlist: SpawnAllowlistRead;
};

type SpawnAgentInputSnapshotResult =
  | {
      decision: "allow";
      snapshot: SpawnAgentInputSnapshot;
    }
  | SpawnProfileRuleDeny;

function parseSpawnAgentInputSnapshot(input: unknown): SpawnAgentInputSnapshotResult {
  const fieldSnapshot = snapshotSpawnDataFields(input);
  if (fieldSnapshot.decision === "deny") {
    return fieldSnapshot;
  }

  const instruction = snapshotSpawnInstruction(fieldSnapshot);
  if (instruction.decision === "deny") {
    return instruction;
  }

  const fields = snapshotSpawnStringFields(fieldSnapshot);
  if (fields.decision === "deny") {
    return fields;
  }

  const mode = validateSpawnMode(fields.fields);
  if (mode.decision === "deny") {
    return mode;
  }

  const role = snapshotSpawnRole(fieldSnapshot);
  if (role.decision === "deny") {
    return role;
  }

  const allowlist = readSpawnAllowlist(fieldSnapshot);
  if (allowlist.kind === "invalid") {
    return buildSpawnProfileMalformedDeny(role.role.label, allowlist.field);
  }
  if (allowlist.kind === "empty") {
    return buildSpawnProfileEmptyDeny(role.role.label, allowlist.field);
  }
  if (allowlist.kind === "budget_exceeded") {
    return buildSpawnProfileBudgetDeny(role.role.label, allowlist);
  }

  return {
    decision: "allow",
    snapshot: {
      fields: new Map<SpawnAgentStringField, string>([
        ["instruction", instruction.instruction],
        ...fields.fields
      ]),
      role: role.role,
      allowlist
    }
  };
}

function snapshotSpawnDataFields(input: unknown): SpawnFieldSnapshotResult {
  if (input === null || typeof input !== "object") {
    return buildSpawnProfileUnsafeInputDeny("spawn_agent input must be a plain data record");
  }

  let isArrayInput: boolean;
  try {
    isArrayInput = Array.isArray(input);
  } catch {
    return buildSpawnProfileUnsafeInputDeny("spawn_agent input could not be safely inspected");
  }
  if (isArrayInput) {
    return buildSpawnProfileUnsafeInputDeny("spawn_agent input must be a plain data record");
  }

  let prototype: unknown;
  try {
    prototype = Object.getPrototypeOf(input);
  } catch {
    return buildSpawnProfileUnsafeInputDeny("spawn_agent input could not be safely inspected");
  }

  if (prototype !== Object.prototype && prototype !== null) {
    return buildSpawnProfileUnsafeInputDeny("spawn_agent input must be a plain data record");
  }

  const values: Partial<Record<SpawnAgentSnapshotField, unknown>> = {};
  const presentFields = new Set<SpawnAgentSnapshotField>();
  for (const field of SPAWN_AGENT_SNAPSHOT_FIELDS) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(input, field);
    } catch {
      return buildSpawnProfileUnsafeInputDeny("spawn_agent input could not be safely inspected");
    }
    if (!descriptor) {
      continue;
    }
    if (!("value" in descriptor)) {
      return buildSpawnProfileUnsafeInputDeny("spawn_agent input must contain only data fields");
    }
    values[field] = descriptor.value;
    presentFields.add(field);
  }

  return {
    decision: "allow",
    values,
    presentFields
  };
}

function snapshotSpawnStringFields(
  snapshot: SpawnFieldSnapshot
): { decision: "allow"; fields: ReadonlyMap<SpawnAgentStringField, string> } | SpawnProfileRuleDeny {
  const fields = new Map<SpawnAgentStringField, string>();
  for (const field of SPAWN_AGENT_STRING_FIELDS) {
    if (!snapshot.presentFields.has(field)) {
      continue;
    }

    const value = snapshot.values[field];
    if (value === undefined) {
      continue;
    }

    if (typeof value !== "string") {
      return buildSpawnProfileMalformedInputDeny(`spawn_agent ${field} must be a string`);
    }

    if (value.length > SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS) {
      return buildSpawnProfileMalformedInputDeny(
        `spawn_agent ${field} exceeds the ${SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS} character budget`
      );
    }

    fields.set(field, value);
  }

  return { decision: "allow", fields };
}

function validateSpawnMode(
  fields: ReadonlyMap<SpawnAgentStringField, string>
): PolicyRuleDecision {
  const mode = fields.get("mode");
  if (mode === undefined || mode === "standard" || mode === "interactive") {
    return { decision: "allow" };
  }

  return buildSpawnProfileInvalidModeDeny(mode);
}

function snapshotSpawnInstruction(
  snapshot: SpawnFieldSnapshot
): { decision: "allow"; instruction: string } | SpawnProfileRuleDeny {
  const value = snapshot.values.instruction;
  if (!snapshot.presentFields.has("instruction") || value === undefined) {
    return buildSpawnProfileMissingInstructionDeny();
  }

  if (typeof value !== "string") {
    return buildSpawnProfileMalformedInputDeny("spawn_agent instruction must be a string");
  }

  if (value.length > SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS) {
    return buildSpawnProfileMalformedInputDeny(
      `spawn_agent instruction exceeds the ${SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS} character budget`
    );
  }

  if (value.trim().length === 0) {
    return buildSpawnProfileMissingInstructionDeny();
  }

  return { decision: "allow", instruction: value };
}

function snapshotSpawnRole(
  snapshot: SpawnFieldSnapshot
): { decision: "allow"; role: SpawnRoleSnapshot } | SpawnProfileRuleDeny {
  if (!snapshot.presentFields.has("role") || snapshot.values.role === undefined) {
    return {
      decision: "allow",
      role: {
        kind: "omitted",
        label: "unspecified role"
      }
    };
  }

  const value = snapshot.values.role;
  if (typeof value !== "string") {
    return buildSpawnProfileMalformedInputDeny(
      "spawn_agent role must be a primitive string when provided"
    );
  }

  if (value.length > SPAWN_PROFILE_TOOL_ID_MAX_CHARS) {
    return buildSpawnProfileMalformedInputDeny(
      `spawn_agent role exceeds the ${SPAWN_PROFILE_TOOL_ID_MAX_CHARS} character budget`
    );
  }

  const trimmedRole = value.trim();
  const role: SpawnRoleSnapshot = {
    kind: "present",
    value: trimmedRole,
    label: formatSpawnRoleLabel(trimmedRole)
  };
  if (isCanonicalHarnessRole(trimmedRole)) {
    role.canonicalRole = trimmedRole;
  }

  return {
    decision: "allow",
    role
  };
}

function readSpawnAllowlist(snapshot: SpawnFieldSnapshot): SpawnAllowlistRead {
  const toolsPresent = snapshot.presentFields.has("tools") && snapshot.values.tools !== undefined;
  const allowedToolsPresent =
    snapshot.presentFields.has("allowed_tools") && snapshot.values.allowed_tools !== undefined;

  if (!toolsPresent && !allowedToolsPresent) {
    return { kind: "omitted" };
  }

  let toolsAllowlist: SpawnAllowlistRead | undefined;
  if (toolsPresent) {
    toolsAllowlist = readSpawnAllowlistField("tools", snapshot.values.tools);
    if (toolsAllowlist.kind !== "valid") {
      return toolsAllowlist;
    }
  }

  let allowedToolsAllowlist: SpawnAllowlistRead | undefined;
  if (allowedToolsPresent) {
    allowedToolsAllowlist = readSpawnAllowlistField(
      "allowed_tools",
      snapshot.values.allowed_tools
    );
    if (allowedToolsAllowlist.kind !== "valid") {
      return allowedToolsAllowlist;
    }
  }

  if (toolsAllowlist?.kind === "valid" && allowedToolsAllowlist?.kind === "valid") {
    return {
      kind: "dual",
      toolsToolIds: toolsAllowlist.toolIds,
      allowedToolsToolIds: allowedToolsAllowlist.toolIds,
      toolIds: uniqueStrings([...toolsAllowlist.toolIds, ...allowedToolsAllowlist.toolIds])
    };
  }

  return toolsAllowlist ?? allowedToolsAllowlist ?? { kind: "omitted" };
}

function readSpawnAllowlistField(
  field: SpawnAllowlistField,
  value: unknown
): SpawnAllowlistRead {
  let isArrayValue: boolean;
  try {
    isArrayValue = Array.isArray(value);
  } catch {
    return { kind: "invalid", field };
  }
  if (!isArrayValue) {
    return { kind: "invalid", field };
  }

  const arrayValue = value as readonly unknown[];
  let lengthDescriptor: PropertyDescriptor | undefined;
  try {
    lengthDescriptor = Object.getOwnPropertyDescriptor(arrayValue, "length");
  } catch {
    return { kind: "invalid", field };
  }
  if (!lengthDescriptor || !("value" in lengthDescriptor)) {
    return { kind: "invalid", field };
  }
  const length = lengthDescriptor.value;
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    return { kind: "invalid", field };
  }
  if (length > SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS) {
    return {
      kind: "budget_exceeded",
      field,
      budget: "item_count",
      limit: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS,
      actual: length
    };
  }

  if (length === 0) {
    return { kind: "empty", field };
  }

  const rawToolIds: string[] = [];
  let totalCharacters = 0;
  for (let index = 0; index < length; index += 1) {
    let descriptor: PropertyDescriptor | undefined;
    try {
      descriptor = Object.getOwnPropertyDescriptor(arrayValue, index);
    } catch {
      return { kind: "invalid", field };
    }
    if (!descriptor || !("value" in descriptor)) {
      return { kind: "invalid", field };
    }
    const entry = descriptor.value;
    if (typeof entry !== "string") {
      return { kind: "invalid", field };
    }
    if (entry.length > SPAWN_PROFILE_TOOL_ID_MAX_CHARS) {
      return {
        kind: "budget_exceeded",
        field,
        budget: "tool_id_length",
        limit: SPAWN_PROFILE_TOOL_ID_MAX_CHARS,
        actual: entry.length
      };
    }
    totalCharacters += entry.length;
    if (totalCharacters > SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS) {
      return {
        kind: "budget_exceeded",
        field,
        budget: "total_characters",
        limit: SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS,
        actual: totalCharacters
      };
    }
    rawToolIds.push(entry);
  }

  const toolIds: string[] = [];
  for (const entry of rawToolIds) {
    const toolId = entry.trim();
    if (toolId.length === 0) {
      return { kind: "invalid", field };
    }
    toolIds.push(toolId);
  }

  return { kind: "valid", field, toolIds: uniqueStrings(toolIds) };
}

function evaluateSpawnProfileSubsetSnapshot(
  snapshot: SpawnAgentInputSnapshot
): PolicyRuleDecision {
  const allowlist = snapshot.allowlist;
  if (allowlist.kind === "omitted") {
    const role = snapshot.role.kind === "present" ? snapshot.role.canonicalRole : undefined;
    if (role) {
      return { decision: "allow" };
    }

    return buildSpawnProfileMissingProfileDeny(snapshot.role.label);
  }

  if (allowlist.kind === "dual") {
    return buildSpawnProfileAmbiguousAllowlistDeny(
      snapshot.role.label,
      snapshot.role.kind === "present" ? snapshot.role.canonicalRole : undefined,
      allowlist
    );
  }

  if (allowlist.kind !== "valid") {
    return { decision: "allow" };
  }

  const role = snapshot.role.kind === "present" ? snapshot.role.canonicalRole : undefined;
  if (!role) {
    return buildSpawnProfileMissingProfileDeny(snapshot.role.label);
  }

  const excessToolIds = uniqueStrings(
    allowlist.toolIds.filter((toolId) => !isRoleToolIdAllowed(role, toolId))
  );

  if (excessToolIds.length === 0) {
    return { decision: "allow" };
  }

  return buildSpawnProfileExcessDeny(role, excessToolIds);
}

function buildSpawnExecutionInput(snapshot: SpawnAgentInputSnapshot): Record<string, unknown> {
  const normalizedInput: Record<string, unknown> = {};
  for (const [field, value] of snapshot.fields) {
    normalizedInput[field] = value;
  }

  if (snapshot.role.kind === "present" && snapshot.role.value.length > 0) {
    normalizedInput.role = snapshot.role.value;
  }

  if (snapshot.allowlist.kind === "valid") {
    normalizedInput.tools = [...snapshot.allowlist.toolIds];
  } else if (snapshot.allowlist.kind === "omitted" && snapshot.role.kind === "present") {
    const role = snapshot.role.canonicalRole;
    if (role) {
      normalizedInput.tools = [...getRoleToolIds(role)];
    }
  }

  return normalizedInput;
}

function toSpawnProfileGateDeny(
  decision: SpawnProfileRuleDeny
): Extract<PolicyGateDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
    reason: decision.reason,
    remediation: decision.remediation,
    guardClass: decision.guardClass ?? "authority"
  };
}

function readTrustedSpawnLimitCount(
  value: number | undefined
): { kind: "missing" } | { kind: "invalid" } | { kind: "valid"; value: number } {
  if (value === undefined) {
    return { kind: "missing" };
  }
  if (!Number.isSafeInteger(value) || value < 0) {
    return { kind: "invalid" };
  }
  return { kind: "valid", value };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildSpawnDepthLimitDeny(
  currentDepth: number
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const requestedDepth = currentDepth + 1;
  return {
    decision: "deny",
    reason: `spawn_agent would create spawn depth ${requestedDepth}, exceeding max_spawn_depth=${MAX_SPAWN_DEPTH}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Do not chain spawn_agent from an existing subagent; return the work to the coordinator or handle it within the current delegated scope.",
      ref: SPAWN_LIMITS_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnConcurrencyLimitDeny(
  activeSubagentCount: number
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `spawn_agent requested while ${activeSubagentCount} subagent(s) are already active, meeting max_concurrent_subagents=${MAX_CONCURRENT_SUBAGENTS}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Wait for an active subagent to finish before spawning another one; M1 denies instead of scheduling a queue.",
      ref: SPAWN_LIMITS_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileMalformedDeny(
  role: string,
  field: SpawnAllowlistField
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `spawn_agent ${field} for ${role} must be a non-empty array of tool ids.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Provide ${field} as a non-empty array containing only tool ids from the ${role} canonical profile.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileEmptyDeny(
  role: string,
  field: SpawnAllowlistField
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `spawn_agent ${field} for ${role} is empty and would not express a usable SHUD role profile.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Specify a non-empty subset of the ${role} canonical profile instead of an empty ${field} allowlist.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileBudgetDeny(
  role: string,
  allowlist: Extract<SpawnAllowlistRead, { kind: "budget_exceeded" }>
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const budgetLabel = formatSpawnAllowlistBudget(allowlist);
  return {
    decision: "deny",
    reason: `spawn_agent ${allowlist.field} for ${role} exceeds the ${budgetLabel} budget.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Reduce ${allowlist.field} to fit within the ${budgetLabel} budget before spawning ${role}.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileMissingProfileDeny(
  role: string
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `spawn_agent for ${role} has no canonical SHUD role profile to constrain Zero tools.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Provide a canonical SHUD spawn role and, when constraining tools, a non-empty tools/allowed_tools subset of that role's profile before spawning ${role}.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileUnsafeInputDeny(
  detail: string
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `spawn_agent input cannot be safely isolated before policy evaluation: ${detail}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Provide spawn_agent input as a plain data object with explicit tool ids when constraining sub-agent tools.",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileMalformedInputDeny(
  detail: string
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    reason: `${detail}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Provide spawn_agent input as plain JSON-compatible data matching the Zero spawn_agent schema.",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileMissingInstructionDeny(): Extract<
  PolicyRuleDecision,
  { decision: "deny" }
> {
  return {
    decision: "deny",
    reason: "spawn_agent instruction must be a non-empty string before policy-gated execution.",
    remediation: {
      next_action: "adjust_scope",
      hint: "Provide a non-empty spawn_agent instruction before spawning a SHUD role.",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileInvalidModeDeny(
  mode: string
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const modeLabel = formatToolIdSample(mode);
  return {
    decision: "deny",
    reason: `spawn_agent mode must be omitted, standard, or interactive; received ${modeLabel}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Use spawn_agent mode standard or interactive, or omit mode, before spawning a SHUD role.",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function formatSpawnRoleLabel(role: string): string {
  if (role.length === 0) {
    return "unspecified role";
  }

  if (role.length <= SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS) {
    return role;
  }

  return `${role.slice(0, SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS - 3)}...`;
}

function formatSpawnAllowlistBudget(
  allowlist: Extract<SpawnAllowlistRead, { kind: "budget_exceeded" }>
): string {
  if (allowlist.budget === "item_count") {
    return `tool count (${allowlist.actual}/${allowlist.limit})`;
  }
  if (allowlist.budget === "tool_id_length") {
    return `per-tool id length (${allowlist.actual}/${allowlist.limit} characters)`;
  }
  return `total tool-id characters (${allowlist.actual}/${allowlist.limit})`;
}

function buildSpawnProfileAmbiguousAllowlistDeny(
  roleLabel: string,
  role: HarnessRole | undefined,
  allowlist: Extract<SpawnAllowlistRead, { kind: "dual" }>
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const excessToolIds = role
    ? uniqueStrings(allowlist.toolIds.filter((toolId) => !isRoleToolIdAllowed(role, toolId)))
    : [];
  const excessClause =
    excessToolIds.length > 0
      ? ` Excess examples: ${formatToolIdSummary(excessToolIds, { alwaysIncludeTotal: true })}.`
      : "";

  return {
    decision: "deny",
    reason: `spawn_agent input supplies both tools and allowed_tools for ${roleLabel}; this is ambiguous and cannot be authorized.${excessClause}`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Provide exactly one spawn allowlist field, either tools or allowed_tools, after removing any excess tool ids.${excessClause}`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function buildSpawnProfileExcessDeny(
  role: HarnessRole,
  excessToolIds: readonly string[]
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const excessSummary = formatToolIdSummary(excessToolIds, { alwaysIncludeTotal: true });
  const canonicalSummary = formatToolIdSummary(getRoleToolIds(role));
  return {
    decision: "deny",
    reason: `spawn_agent requested ${excessToolIds.length} tool id(s) outside the ${role} canonical profile; examples: ${excessSummary}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Remove excess spawn tools for ${role}; examples: ${excessSummary}. Use a non-empty subset of canonical profile: ${canonicalSummary}.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function formatToolIdSummary(
  toolIds: readonly string[],
  options: { alwaysIncludeTotal?: boolean } = {}
): string {
  const samples = selectToolIdSamples(toolIds).map(formatToolIdSample);
  const suffix =
    options.alwaysIncludeTotal || toolIds.length > SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES
      ? ` (${toolIds.length} total)`
      : "";
  return `${samples.join(", ")}${suffix}`;
}

function selectToolIdSamples(toolIds: readonly string[]): string[] {
  const samples = [...toolIds.slice(0, SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES)];
  if (
    toolIds.includes("edit") &&
    !samples.includes("edit") &&
    samples.length === SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES
  ) {
    samples[samples.length - 1] = "edit";
  }
  return samples;
}

function formatToolIdSample(toolId: string): string {
  if (toolId.length <= SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS) {
    return toolId;
  }

  return `${toolId.slice(0, SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS - 3)}...`;
}

function validatePolicyGateRemediation(
  ruleId: string,
  remediation: unknown
): PolicyGateRemediation {
  const parsed = PolicyGateRemediationSchema.safeParse(remediation);
  if (parsed.success) {
    return parsed.data;
  }

  const fieldPaths = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .filter((path) => path.length > 0)
    .join(", ");

  throw policyGateDecisionValidationError(
    `Invalid policy gate remediation for ${ruleId}: ${fieldPaths || "remediation"}`
  );
}
