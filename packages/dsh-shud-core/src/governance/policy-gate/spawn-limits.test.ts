import { describe, expect, test } from "vitest";
import {
  evaluatePolicyGate,
  isReservedAuthorityPolicyRuleId,
  RESERVED_AUTHORITY_POLICY_RULE_IDS,
} from "./evaluate.ts";
import { PolicyGateRemediationSchema } from "./parameter-schema.ts";
import {
  DEFAULT_SHUD_POLICY_GATE_CONTEXT,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SPAWN_DEPTH,
  SPAWN_CONCURRENCY_LIMIT_RULE,
  SPAWN_CONCURRENCY_LIMIT_RULE_ID,
  SPAWN_DEPTH_LIMIT_RULE,
  SPAWN_DEPTH_LIMIT_RULE_ID,
  SPAWN_LIMITS_POLICY_REF,
  SPAWN_PROFILE_SUBSET_RULE_ID,
} from "./spawn-rules.ts";
import { spawnToolCall } from "./test-harness.ts";

describe("spawn limit policy rules", () => {
  test("canonical SHUD rule set includes reserved authority spawn limit rules", () => {
    const defaultRuleIds = DEFAULT_SHUD_POLICY_GATE_CONTEXT.rules.map((rule) => rule.ruleId);

    expect(defaultRuleIds).toContain(SPAWN_PROFILE_SUBSET_RULE_ID);
    expect(defaultRuleIds).toContain(SPAWN_DEPTH_LIMIT_RULE_ID);
    expect(defaultRuleIds).toContain(SPAWN_CONCURRENCY_LIMIT_RULE_ID);
    expect(RESERVED_AUTHORITY_POLICY_RULE_IDS).toContain(SPAWN_DEPTH_LIMIT_RULE_ID);
    expect(RESERVED_AUTHORITY_POLICY_RULE_IDS).toContain(SPAWN_CONCURRENCY_LIMIT_RULE_ID);
    expect(isReservedAuthorityPolicyRuleId(SPAWN_DEPTH_LIMIT_RULE_ID)).toBe(true);
    expect(isReservedAuthorityPolicyRuleId(SPAWN_CONCURRENCY_LIMIT_RULE_ID)).toBe(true);

    for (const rule of [SPAWN_DEPTH_LIMIT_RULE, SPAWN_CONCURRENCY_LIMIT_RULE]) {
      expect(rule.guardClass).toBe("authority");
      expect(rule.guard_class).toBeUndefined();
    }
  });

  test("denies spawn_agent when trusted context is already at max spawn depth", () => {
    const decision = evaluatePolicyGate(
      {
        ...spawnToolCall({ role: "worker", tools: ["read"] }),
        spawnDepth: MAX_SPAWN_DEPTH,
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT,
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_DEPTH_LIMIT_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_LIMITS_POLICY_REF,
      },
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain(`max_spawn_depth=${MAX_SPAWN_DEPTH}`);
      expect(decision.reason).toContain("spawn depth 2");
      expect(decision.remediation.hint).toContain("coordinator");
      expect(PolicyGateRemediationSchema.safeParse(decision.remediation).success).toBe(true);
    }
  });

  test("denies spawn_agent when trusted context reaches max concurrent subagents", () => {
    const decision = evaluatePolicyGate(
      {
        ...spawnToolCall({ role: "worker", tools: ["read"] }),
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS,
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT,
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_CONCURRENCY_LIMIT_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_LIMITS_POLICY_REF,
      },
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain(`max_concurrent_subagents=${MAX_CONCURRENT_SUBAGENTS}`);
      expect(decision.remediation.hint).toContain("M1 denies");
      expect(PolicyGateRemediationSchema.safeParse(decision.remediation).success).toBe(true);
    }
  });

  test("allows spawn_agent below trusted depth and concurrency limits", () => {
    const decision = evaluatePolicyGate(
      {
        ...spawnToolCall({ role: "worker", tools: ["read", "sandbox.exec"] }),
        spawnDepth: MAX_SPAWN_DEPTH - 1,
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS - 1,
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT,
    );

    expect(decision).toEqual({ decision: "allow" });
  });

  test("denies present-invalid trusted spawn depth metadata", () => {
    for (const spawnDepth of [-1, Number.NaN, 1.5]) {
      const decision = evaluatePolicyGate(
        {
          ...spawnToolCall({ role: "worker", tools: ["read"] }),
          spawnDepth,
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_DEPTH_LIMIT_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_LIMITS_POLICY_REF,
        },
      });
    }
  });

  test("denies present-invalid trusted active subagent count metadata", () => {
    for (const activeSubagentCount of [-1, Number.NaN, 1.5]) {
      const decision = evaluatePolicyGate(
        {
          ...spawnToolCall({ role: "worker", tools: ["read"] }),
          activeSubagentCount,
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_CONCURRENCY_LIMIT_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_LIMITS_POLICY_REF,
        },
      });
    }
  });

  test("does not treat model-controlled spawn limit input fields as trusted context", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({
        role: "worker",
        tools: ["read"],
        spawnDepth: MAX_SPAWN_DEPTH,
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS,
      }),
      DEFAULT_SHUD_POLICY_GATE_CONTEXT,
    );

    expect(decision).toEqual({ decision: "allow" });
  });
});
