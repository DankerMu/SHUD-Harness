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

  const role = input.role;
  if (!isCanonicalHarnessRole(role)) {
    return { decision: "allow" };
  }

  const allowlist = readSpawnAllowlist(input);
  if (allowlist.kind === "omitted") {
    return { decision: "allow" };
  }

  if (allowlist.kind === "invalid") {
    return buildSpawnProfileMalformedDeny(role, allowlist.field);
  }

  if (allowlist.kind === "empty") {
    return buildSpawnProfileEmptyDeny(role, allowlist.field);
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

  const role = input.role;
  if (!isCanonicalHarnessRole(role)) {
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

  const allowlist = readSpawnAllowlist(input);
  const toolIds =
    allowlist.kind === "valid" ? allowlist.toolIds : [...getRoleToolIds(role)];

  const normalizedInput: Record<string, unknown> & { tools: string[] } = {
    ...input,
    tools: [...toolIds]
  };
  delete normalizedInput.allowed_tools;

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
      kind: "valid";
      field: "tools" | "allowed_tools";
      toolIds: readonly string[];
    };

function readSpawnAllowlist(input: Record<string, unknown>): SpawnAllowlistRead {
  if (Object.prototype.hasOwnProperty.call(input, "tools")) {
    return readSpawnAllowlistField("tools", input.tools);
  }

  if (Object.prototype.hasOwnProperty.call(input, "allowed_tools")) {
    return readSpawnAllowlistField("allowed_tools", input.allowed_tools);
  }

  return { kind: "omitted" };
}

function readSpawnAllowlistField(
  field: "tools" | "allowed_tools",
  value: unknown
): SpawnAllowlistRead {
  if (!Array.isArray(value)) {
    return { kind: "invalid", field };
  }

  if (value.length === 0) {
    return { kind: "empty", field };
  }

  const toolIds: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return { kind: "invalid", field };
    }
    const toolId = entry.trim();
    if (toolId.length === 0) {
      return { kind: "invalid", field };
    }
    toolIds.push(toolId);
  }

  return { kind: "valid", field, toolIds: uniqueStrings(toolIds) };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function buildSpawnProfileMalformedDeny(
  role: HarnessRole,
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
  role: HarnessRole,
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
