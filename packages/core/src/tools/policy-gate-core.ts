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
export const SPAWN_PROFILE_TEXT_FIELD_MAX_CHARS = 65536;

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

  const parsed = parseSpawnAgentInputSnapshot(call.input);
  if (parsed.decision === "deny") {
    return parsed;
  }

  return evaluateSpawnProfileSubsetSnapshot(parsed.snapshot);
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
  let length: unknown;
  try {
    length = arrayValue.length;
  } catch {
    return { kind: "invalid", field };
  }
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
    guardClass: decision.guardClass ?? SPAWN_PROFILE_SUBSET_RULE.guardClass
  };
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
