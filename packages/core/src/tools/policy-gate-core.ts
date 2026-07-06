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
  if (!allowlist) {
    return { decision: "allow" };
  }

  const requestedToolIds = allowlist.filter(
    (toolId): toolId is string => typeof toolId === "string"
  );
  const excessToolIds = uniqueStrings(
    requestedToolIds.filter((toolId) => !isRoleToolIdAllowed(role, toolId))
  );

  if (excessToolIds.length === 0) {
    return { decision: "allow" };
  }

  const canonicalToolIds = getRoleToolIds(role).join(", ");
  return {
    decision: "deny",
    reason: `spawn_agent requested tools outside the ${role} canonical profile: ${excessToolIds.join(", ")}`,
    remediation: {
      next_action: "adjust_scope",
      hint: `Remove excess spawn tools for ${role}: ${excessToolIds.join(", ")}. Canonical profile: ${canonicalToolIds}.`,
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    },
    guardClass: "authority"
  };
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readSpawnAllowlist(input: Record<string, unknown>): readonly unknown[] | undefined {
  if (Object.prototype.hasOwnProperty.call(input, "tools")) {
    return Array.isArray(input.tools) ? input.tools : undefined;
  }

  return Array.isArray(input.allowed_tools) ? input.allowed_tools : undefined;
}

function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
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
