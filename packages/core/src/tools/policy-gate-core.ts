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
export const SPAWN_PROFILE_SUBSET_POLICY_REF =
  "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry";
export const SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS = 64;
export const SPAWN_PROFILE_TOOL_ID_MAX_CHARS = 128;
export const SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS = 4096;
export const SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES = 5;
export const SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS = 64;

export interface PolicyGateToolCall {
  toolId: string;
  role: HarnessRole | "unknown";
  input: unknown;
  workDir?: string;
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
      guardClass?: PolicyGuardClass;
    };

export type PolicyGateInputNormalization =
  | {
      decision: "allow";
      input: unknown;
      changed: boolean;
    }
  | Extract<PolicyGateDecision, { decision: "deny" }>;

export interface PolicyRule {
  ruleId: string;
  description: string;
  guardClass?: PolicyGuardClass;
  evaluate(call: PolicyGateToolCall, context: PolicyGateContext): PolicyRuleDecision;
}

export interface PolicyGateContext {
  rules: readonly PolicyRule[];
}

export const EMPTY_POLICY_GATE_CONTEXT: PolicyGateContext = {
  rules: []
};

export function evaluatePolicyGate(
  call: PolicyGateToolCall,
  context: PolicyGateContext = EMPTY_POLICY_GATE_CONTEXT
): PolicyGateDecision {
  for (const rule of context.rules) {
    const result = rule.evaluate(call, context);
    if (result.decision === "allow") {
      continue;
    }

    validatePolicyGateRemediation(rule.ruleId, result.remediation);
    const guardClass = result.guardClass ?? rule.guardClass;
    return {
      decision: "deny",
      ruleId: rule.ruleId,
      reason: result.reason,
      remediation: result.remediation,
      ...(guardClass ? { guardClass } : {})
    };
  }

  return { decision: "allow" };
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

export function evaluateSpawnProfileSubset(call: PolicyGateToolCall): PolicyRuleDecision {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow" };
  }

  const input = readRecord(call.input);
  if (!input) {
    return { decision: "allow" };
  }

  const roleValue = readOwnDataValue(input, "role");
  const role = roleValue.kind === "present" ? readTrimmedCanonicalRole(roleValue.value) : undefined;
  const roleLabel = formatSpawnRoleLabel(roleValue);
  const allowlist = readSpawnAllowlist(input);
  if (allowlist.kind === "omitted") {
    return { decision: "allow" };
  }

  if (allowlist.kind === "invalid") {
    return buildSpawnProfileMalformedDeny(roleLabel, allowlist.field);
  }

  if (allowlist.kind === "empty") {
    return buildSpawnProfileEmptyDeny(roleLabel, allowlist.field);
  }

  if (allowlist.kind === "budget_exceeded") {
    return buildSpawnProfileBudgetDeny(roleLabel, allowlist);
  }

  if (!role) {
    return { decision: "allow" };
  }

  const requestedToolIds = allowlist.toolIds;
  const excessToolIds = uniqueStrings(
    requestedToolIds.filter((toolId) => !isRoleToolIdAllowed(role, toolId))
  );

  if (excessToolIds.length === 0) {
    return { decision: "allow" };
  }

  return buildSpawnProfileExcessDeny(role, excessToolIds);
}

export function normalizeSpawnAgentInput(
  call: PolicyGateToolCall
): PolicyGateInputNormalization {
  if (call.toolId !== "spawn_agent") {
    return { decision: "allow", input: call.input, changed: false };
  }

  const input = readRecord(call.input);
  if (!input) {
    return { decision: "allow", input: call.input, changed: false };
  }

  const ruleDecision = evaluateSpawnProfileSubset(call);
  if (ruleDecision.decision === "deny") {
    return {
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      reason: ruleDecision.reason,
      remediation: ruleDecision.remediation,
      guardClass: ruleDecision.guardClass ?? SPAWN_PROFILE_SUBSET_RULE.guardClass
    };
  }

  const snapshot = snapshotSpawnInput(input);
  if (snapshot.decision === "deny") {
    return snapshot;
  }

  const roleValue = readOwnDataValue(input, "role");
  const role = roleValue.kind === "present" ? readTrimmedCanonicalRole(roleValue.value) : undefined;
  const allowlist = readSpawnAllowlist(input);
  const hasExplicitAllowlist = allowlist.kind === "valid";
  const toolIds = hasExplicitAllowlist
    ? allowlist.toolIds
    : role
      ? [...getRoleToolIds(role)]
      : undefined;

  const normalizedInput: Record<string, unknown> = {
    ...snapshot.input
  };
  delete normalizedInput.allowed_tools;
  delete normalizedInput.tools;

  if (role) {
    normalizedInput.role = role;
  }
  if (toolIds) {
    normalizedInput.tools = [...toolIds];
  }

  return {
    decision: "allow",
    input: normalizedInput,
    changed: true
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

type OwnDataValueRead =
  | {
      kind: "omitted";
    }
  | {
      kind: "accessor";
    }
  | {
      kind: "present";
      value: unknown;
    };

function readOwnDataValue(input: Record<string, unknown>, key: string): OwnDataValueRead {
  let descriptor: PropertyDescriptor | undefined;
  try {
    descriptor = Object.getOwnPropertyDescriptor(input, key);
  } catch {
    return { kind: "accessor" };
  }

  if (!descriptor) {
    return { kind: "omitted" };
  }

  if (!("value" in descriptor)) {
    return { kind: "accessor" };
  }

  return {
    kind: "present",
    value: descriptor.value
  };
}

function readTrimmedCanonicalRole(value: unknown): HarnessRole | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const role = value.trim();
  return isCanonicalHarnessRole(role) ? role : undefined;
}

type SpawnAllowlistRead =
  | {
      kind: "omitted";
    }
  | {
      kind: "invalid";
      field: "tools" | "allowed_tools";
    }
  | {
      kind: "empty";
      field: "tools" | "allowed_tools";
    }
  | {
      kind: "budget_exceeded";
      field: "tools" | "allowed_tools";
      budget: "item_count" | "tool_id_length" | "total_characters";
      limit: number;
      actual: number;
    }
  | {
      kind: "valid";
      field: "tools" | "allowed_tools";
      toolIds: readonly string[];
    };

function readSpawnAllowlist(input: Record<string, unknown>): SpawnAllowlistRead {
  const tools = readOwnDataValue(input, "tools");
  const allowedTools = readOwnDataValue(input, "allowed_tools");

  if (tools.kind === "omitted" && allowedTools.kind === "omitted") {
    return { kind: "omitted" };
  }

  let toolsAllowlist: SpawnAllowlistRead | undefined;
  if (tools.kind !== "omitted") {
    toolsAllowlist =
      tools.kind === "present"
        ? readSpawnAllowlistField("tools", tools.value)
        : { kind: "invalid", field: "tools" };
    if (toolsAllowlist.kind !== "valid") {
      return toolsAllowlist;
    }
  }

  let allowedToolsAllowlist: SpawnAllowlistRead | undefined;
  if (allowedTools.kind !== "omitted") {
    allowedToolsAllowlist =
      allowedTools.kind === "present"
        ? readSpawnAllowlistField("allowed_tools", allowedTools.value)
        : { kind: "invalid", field: "allowed_tools" };
    if (allowedToolsAllowlist.kind !== "valid") {
      return allowedToolsAllowlist;
    }
  }

  return toolsAllowlist ?? allowedToolsAllowlist ?? { kind: "omitted" };
}

function readSpawnAllowlistField(
  field: "tools" | "allowed_tools",
  value: unknown
): SpawnAllowlistRead {
  if (!Array.isArray(value)) {
    return { kind: "invalid", field };
  }

  let length: number;
  try {
    length = value.length;
  } catch {
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
    let entry: unknown;
    try {
      entry = value[index];
    } catch {
      return { kind: "invalid", field };
    }
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

function snapshotSpawnInput(
  input: Record<string, unknown>
):
  | { decision: "allow"; input: Record<string, unknown> }
  | Extract<PolicyGateDecision, { decision: "deny" }> {
  let descriptors: PropertyDescriptorMap;
  try {
    descriptors = Object.getOwnPropertyDescriptors(input);
  } catch {
    return buildSpawnProfileUnsafeInputDeny("could not inspect own properties");
  }

  const snapshot: Record<string, unknown> = {};
  for (const [key, descriptor] of Object.entries(descriptors)) {
    if (!descriptor.enumerable || key === "tools" || key === "allowed_tools") {
      continue;
    }

    if (!("value" in descriptor)) {
      return buildSpawnProfileUnsafeInputDeny(`contains an accessor field: ${key}`);
    }

    snapshot[key] = descriptor.value;
  }

  try {
    return {
      decision: "allow",
      input: structuredClone(snapshot) as Record<string, unknown>
    };
  } catch {
    return buildSpawnProfileUnsafeInputDeny("contains non-cloneable enumerable data");
  }
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildSpawnProfileMalformedDeny(
  role: string,
  field: "tools" | "allowed_tools"
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
  field: "tools" | "allowed_tools"
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

function buildSpawnProfileUnsafeInputDeny(
  detail: string
): Extract<PolicyGateDecision, { decision: "deny" }> {
  return {
    decision: "deny",
    ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
    reason: `spawn_agent input cannot be safely isolated before policy evaluation: ${detail}.`,
    remediation: {
      next_action: "adjust_scope",
      hint: "Provide spawn_agent input as plain cloneable data with explicit tool ids when constraining sub-agent tools.",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function formatSpawnRoleLabel(role: OwnDataValueRead): string {
  if (role.kind !== "present" || typeof role.value !== "string") {
    return "unspecified role";
  }

  const trimmedRole = role.value.trim();
  if (trimmedRole.length === 0) {
    return "unspecified role";
  }

  if (trimmedRole.length <= SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS) {
    return trimmedRole;
  }

  return `${trimmedRole.slice(0, SPAWN_PROFILE_TOOL_ID_SAMPLE_MAX_CHARS - 3)}...`;
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

function buildSpawnProfileExcessDeny(
  role: HarnessRole,
  excessToolIds: readonly string[]
): Extract<PolicyRuleDecision, { decision: "deny" }> {
  const excessSummary = formatToolIdSummary(excessToolIds);
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

function formatToolIdSummary(toolIds: readonly string[]): string {
  const samples = selectToolIdSamples(toolIds).map(formatToolIdSample);
  const suffix =
    toolIds.length > SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES ? ` (${toolIds.length} total)` : "";
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

function validatePolicyGateRemediation(ruleId: string, remediation: PolicyGateRemediation): void {
  const parsed = PolicyGateRemediationSchema.safeParse(remediation);
  if (parsed.success) {
    return;
  }

  const fieldPaths = parsed.error.issues
    .map((issue) => issue.path.join("."))
    .filter((path) => path.length > 0)
    .join(", ");

  throw new Error(`Invalid policy gate remediation for ${ruleId}: ${fieldPaths || "remediation"}`);
}
