import { z } from "zod";
import { RemediationNextActionSchema } from "../domain/schemas";

export type HarnessRole = "coordinator" | "repo_explorer" | "worker" | "coder" | "reviewer";

export const GuardClassSchema = z.enum(["authority", "capability"]);
export type GuardClass = z.infer<typeof GuardClassSchema>;

// Policy-gate denials require a navigable ref, even though generic ErrorRecord.ref is optional.
export const PolicyGateRemediationSchema = z.object({
  next_action: RemediationNextActionSchema,
  hint: z.string().min(1),
  ref: z.string().min(1)
});

export type PolicyGateRemediation = z.infer<typeof PolicyGateRemediationSchema>;

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
    };

export type PolicyGateDecision =
  | {
      decision: "allow";
    }
  | {
      decision: "deny";
      ruleId: string;
      guard_class?: GuardClass;
      reason: string;
      remediation: PolicyGateRemediation;
    };

export type PolicyGateDenyDecision = Extract<PolicyGateDecision, { decision: "deny" }>;

export interface PolicyRule {
  ruleId: string;
  guard_class?: GuardClass;
  description: string;
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
    validateGuardClassMarker(rule.ruleId, rule.guard_class);
    return {
      decision: "deny",
      ruleId: rule.ruleId,
      ...(rule.guard_class ? { guard_class: rule.guard_class } : {}),
      reason: result.reason,
      remediation: result.remediation
    };
  }

  return { decision: "allow" };
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

function validateGuardClassMarker(ruleId: string, guardClass: GuardClass | undefined): void {
  if (guardClass === undefined) {
    return;
  }

  const parsed = GuardClassSchema.safeParse(guardClass);
  if (parsed.success) {
    return;
  }

  throw new Error(`Invalid policy gate guard_class for ${ruleId}: ${guardClass}`);
}
