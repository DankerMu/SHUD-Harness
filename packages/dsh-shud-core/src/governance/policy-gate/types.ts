import type { z } from "zod";
import type { PolicyGateRemediationSchema, PolicyGuardClassSchema } from "./parameter-schema.ts";

export type HarnessRole = "coordinator" | "repo_explorer" | "worker" | "coder" | "reviewer";

export type PolicyGateRemediation = z.infer<typeof PolicyGateRemediationSchema>;
export type PolicyGuardClass = z.infer<typeof PolicyGuardClassSchema>;

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

export interface PolicyGateContext {
  rules: readonly PolicyRule[];
}
