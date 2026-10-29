import { isRoleToolIdAllowed } from "../role-tool-map.ts";
import type { PolicyGateContext, PolicyRule } from "./types.ts";

export const ROLE_TOOL_SURFACE_RULE_ID = "role-tool-surface";

export const ROLE_TOOL_SURFACE_RULE: PolicyRule = Object.freeze({
  ruleId: ROLE_TOOL_SURFACE_RULE_ID,
  description: "Limit coordinator and worker calls to their inherited and local tools.",
  guardClass: "authority",
  evaluate: ({ role, toolId }) => {
    if (role !== "coordinator" && role !== "worker") {
      return { decision: "allow" };
    }
    if (isRoleToolIdAllowed(role, toolId)) {
      return { decision: "allow" };
    }
    return {
      decision: "deny",
      reason: `Role ${role} cannot call tool ${toolId}.`,
      remediation: {
        next_action: "adjust_scope",
        hint: "Choose a tool within the role's inherited or local collection.",
        ref: "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry",
      },
    };
  },
} satisfies PolicyRule);

export const DEFAULT_SHUD_POLICY_GATE_CONTEXT: PolicyGateContext = Object.freeze({
  rules: Object.freeze([ROLE_TOOL_SURFACE_RULE]),
});
