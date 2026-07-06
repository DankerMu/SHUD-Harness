import { describe, expect, test } from "bun:test";
import {
  evaluatePolicyGate,
  normalizeSpawnAgentInput,
  PolicyGateRemediationSchema,
  SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS,
  SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS,
  SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES,
  SPAWN_PROFILE_SUBSET_POLICY_REF,
  SPAWN_PROFILE_SUBSET_RULE,
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_PROFILE_TOOL_ID_MAX_CHARS,
  type PolicyGateToolCall
} from "./policy-gate-core";
import { getRoleToolIds } from "./role-tool-map";

describe("policy gate pure evaluator", () => {
  test("allows by default and returns identical output for identical input", () => {
    const call = sampleToolCall();

    const first = evaluatePolicyGate(call);
    const second = evaluatePolicyGate(call);

    expect(first).toEqual({ decision: "allow" });
    expect(second).toEqual(first);
  });

  test("returns deterministic deny with remediation from the first denying rule", () => {
    const call = sampleToolCall();
    const context = {
      rules: [
        {
          ruleId: "raw-data-write",
          description: "Reject writes to data/raw.",
          evaluate: () => ({
            decision: "deny" as const,
            reason: "data/raw is protected",
            remediation: {
              next_action: "adjust_scope" as const,
              hint: "Write generated files under workspace/tasks instead.",
              ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
            }
          })
        }
      ]
    };

    const first = evaluatePolicyGate(call, context);
    const second = evaluatePolicyGate(call, context);

    expect(first).toEqual(second);
    expect(first).toEqual({
      decision: "deny",
      ruleId: "raw-data-write",
      reason: "data/raw is protected",
      remediation: {
        next_action: "adjust_scope",
        hint: "Write generated files under workspace/tasks instead.",
        ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md"
      }
    });
  });

  test("remediation payload requires legal next_action plus hint and ref", () => {
    const valid = PolicyGateRemediationSchema.safeParse({
      next_action: "fix_and_retry",
      hint: "Fix the path and retry.",
      ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定"
    });
    expect(valid.success).toBe(true);

    const invalid = PolicyGateRemediationSchema.safeParse({
      next_action: "try_anyway",
      hint: "",
      ref: ""
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "next_action",
        "hint",
        "ref"
      ]);
    }
  });

  test("invalid rule remediation fails before a deny result is returned", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "bad-rule",
            description: "Returns invalid remediation.",
            evaluate: () => ({
              decision: "deny",
              reason: "invalid",
              remediation: {
                next_action: "try_anyway",
                hint: "No route.",
                ref: "spec"
              } as never
            })
          }
        ]
      })
    ).toThrow("next_action");
  });
});

describe("spawn profile subset policy rule", () => {
  test("denies worker spawn when tools add an excess tool id", () => {
    expect(SPAWN_PROFILE_SUBSET_RULE.guardClass).toBe("authority");

    const decision = evaluatePolicyGate(
      spawnToolCall({ role: "worker", tools: ["read", "edit"] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_PROFILE_SUBSET_POLICY_REF
      }
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain("edit");
      expect(decision.remediation.hint).toContain("edit");
      expect(decision.remediation.ref).toContain(
        "docs/02_ARCHITECTURE/Roles_and_Boundaries.md#0-canonical-agent-role-registry"
      );
    }
  });

  test("trims canonical spawn roles before applying the profile subset rule", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({ role: " reviewer ", tools: ["read", "bash"] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_PROFILE_SUBSET_POLICY_REF
      }
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain("reviewer");
      expect(decision.reason).toContain("bash");
      expect(decision.remediation.hint).toContain("bash");
    }
  });

  test("accepts the allowed_tools spec alias in pure policy tests", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({ role: "worker", allowed_tools: ["read", "edit"] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      expect(decision.remediation.next_action).toBe("adjust_scope");
      expect(decision.remediation.hint).toContain("edit");
    }
  });

  test("denies array spawn input with own authority fields", () => {
    const input = ["not a spawn record"] as unknown[] & Record<string, unknown>;
    input.instruction = "Run the delegated task.";
    input.role = "worker";
    input.tools = ["edit"];

    const decision = evaluatePolicyGate(spawnToolCallRaw(input), {
      rules: [SPAWN_PROFILE_SUBSET_RULE]
    });

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_PROFILE_SUBSET_POLICY_REF
      }
    });
  });

  test("denies non-primitive spawn roles before role trimming", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({ role: new String("worker"), tools: ["edit"] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_PROFILE_SUBSET_POLICY_REF
      }
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain("primitive string");
    }
  });

  test("denies dual tools and allowed_tools fields as ambiguous", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({ role: "worker", tools: ["read"], allowed_tools: ["edit"] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_PROFILE_SUBSET_POLICY_REF
      }
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain("both tools and allowed_tools");
      expect(decision.remediation.hint).toContain("edit");
    }
  });

  test("allows worker spawn when tools are a canonical subset", () => {
    expect(
      evaluatePolicyGate(spawnToolCall({ role: "worker", tools: ["read", "sandbox.exec"] }), {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      })
    ).toEqual({ decision: "allow" });
  });

  test("allows spawn without an explicit allowlist at pure rule level", () => {
    expect(
      evaluatePolicyGate(spawnToolCall({ role: "worker" }), {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      })
    ).toEqual({ decision: "allow" });
  });

  test("normalizes omitted canonical spawn tools to the role profile", () => {
    const normalized = normalizeSpawnAgentInput(spawnToolCall({ role: "reviewer" }));

    expect(normalized).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalized.decision === "allow") {
      expect(normalized.input).toMatchObject({
        role: "reviewer",
        tools: [...getRoleToolIds("reviewer")]
      });
    }
  });

  test("normalizes padded canonical spawn roles before applying default tools", () => {
    const normalized = normalizeSpawnAgentInput(spawnToolCall({ role: " reviewer " }));

    expect(normalized).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalized.decision === "allow") {
      expect(normalized.input).toMatchObject({
        role: "reviewer",
        tools: [...getRoleToolIds("reviewer")]
      });
    }
  });

  test("normalizes the allowed_tools alias to Zero tools", () => {
    const normalized = normalizeSpawnAgentInput(
      spawnToolCall({ role: "worker", allowed_tools: [" read ", "sandbox.exec", "read"] })
    );

    expect(normalized).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalized.decision === "allow") {
      expect(normalized.input).toMatchObject({
        role: "worker",
        tools: ["read", "sandbox.exec"]
      });
      expect(normalized.input).not.toHaveProperty("allowed_tools");
    }
  });

  test("denies explicit empty and malformed canonical allowlists", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    for (const input of [
      { role: "worker", tools: [] },
      { role: "worker", tools: "edit" },
      { role: "worker", tools: ["read", 1] },
      { role: "worker", allowed_tools: [] },
      { role: "worker", allowed_tools: "read" }
    ]) {
      const decision = evaluatePolicyGate(spawnToolCall(input), context);

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope"
        }
      });
    }
  });

  test("denies no-role malformed and over-budget explicit allowlists", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };
    const tailSentinel = "tail-sentinel-that-must-not-appear";
    const overCountTools = [
      ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
      tailSentinel
    ];
    const overLengthToolId = `${"x".repeat(SPAWN_PROFILE_TOOL_ID_MAX_CHARS + 1)}${tailSentinel}`;

    for (const input of [
      { tools: "read" },
      { tools: ["read", 1] },
      { tools: [] },
      { allowed_tools: "read" }
    ]) {
      const decision = evaluatePolicyGate(spawnToolCall(input), context);

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope"
        }
      });
    }

    expectSpawnBudgetDeny(
      evaluatePolicyGate(spawnToolCall({ tools: overCountTools }), context),
      "tool count",
      tailSentinel
    );
    expectSpawnBudgetDeny(
      evaluatePolicyGate(spawnToolCall({ allowed_tools: [overLengthToolId] }), context),
      "per-tool id length",
      tailSentinel
    );
  });

  test("denies noncanonical role invalid and over-budget explicit allowlists", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };
    const tailSentinel = "tail-sentinel-that-must-not-appear";
    const overCountTools = [
      ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
      tailSentinel
    ];

    for (const input of [
      { role: "not_a_harness_role", tools: "read" },
      { role: "not_a_harness_role", tools: [] },
      { role: "not_a_harness_role", allowed_tools: ["read", 1] }
    ]) {
      const decision = evaluatePolicyGate(spawnToolCall(input), context);

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope"
        }
      });
    }

    expectSpawnBudgetDeny(
      evaluatePolicyGate(
        spawnToolCall({ role: "not_a_harness_role", tools: overCountTools }),
        context
      ),
      "tool count",
      tailSentinel
    );
  });

  test("allows noncanonical role small valid explicit allowlists at this rule level", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    expect(
      evaluatePolicyGate(
        spawnToolCall({ role: "not_a_harness_role", tools: ["read", "edit"] }),
        context
      )
    ).toEqual({ decision: "allow" });

    expect(evaluatePolicyGate(spawnToolCall({ tools: ["read", "edit"] }), context)).toEqual({
      decision: "allow"
    });

    const normalized = normalizeSpawnAgentInput(
      spawnToolCall({
        role: "not_a_harness_role",
        allowed_tools: [" read ", "edit", "read"]
      })
    );

    expect(normalized).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalized.decision === "allow") {
      expect(normalized.input).toMatchObject({
        role: "not_a_harness_role",
        tools: ["read", "edit"]
      });
      expect(normalized.input).not.toHaveProperty("allowed_tools");
    }

    const normalizedNoRole = normalizeSpawnAgentInput(
      spawnToolCall({
        allowed_tools: [" read ", "edit", "read"]
      })
    );

    expect(normalizedNoRole).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalizedNoRole.decision === "allow") {
      expect(normalizedNoRole.input).toMatchObject({
        tools: ["read", "edit"]
      });
      expect(normalizedNoRole.input).not.toHaveProperty("role");
      expect(normalizedNoRole.input).not.toHaveProperty("allowed_tools");
    }
  });

  test("allows unknown target roles at this rule level", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    expect(
      evaluatePolicyGate(spawnToolCall({ role: "not_a_harness_role", tools: ["edit"] }), context)
    ).toEqual({ decision: "allow" });
  });

  test("bounds excess tool id denial output while keeping an edit example", () => {
    const farTailSentinel = "tail-sentinel-that-must-not-appear";
    const excessTools = [
      "extra-0",
      "extra-1",
      "extra-2",
      "extra-3",
      "extra-4",
      "edit",
      "extra-5",
      farTailSentinel
    ];

    const decision = evaluatePolicyGate(
      spawnToolCall({ role: "worker", tools: ["read", ...excessTools] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expect(decision.decision).toBe("deny");
    if (decision.decision === "deny") {
      const combined = `${decision.reason}\n${decision.remediation.hint}`;
      expect(combined).toContain("edit");
      expect(combined).toContain(`${excessTools.length} total`);
      expect(combined).not.toContain(farTailSentinel);
      expect(
        excessTools.filter((toolId) => combined.includes(toolId)).length
      ).toBeLessThanOrEqual(SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES);
      expect(combined.length).toBeLessThan(900);
    }
  });

  test("denies over-count spawn tools before trim and dedup without echoing tail values", () => {
    const tailSentinel = "tail-sentinel-that-must-not-appear";
    const tools = [
      ...Array.from({ length: SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS }, () => "read"),
      tailSentinel
    ];

    const decision = evaluatePolicyGate(spawnToolCall({ role: "worker", tools }), {
      rules: [SPAWN_PROFILE_SUBSET_RULE]
    });

    expectSpawnBudgetDeny(decision, "tool count", tailSentinel);
  });

  test("denies over-length allowed_tools before trim and dedup without echoing the value", () => {
    const tailSentinel = "tail-sentinel-that-must-not-appear";
    const overLengthToolId = `${"x".repeat(SPAWN_PROFILE_TOOL_ID_MAX_CHARS + 1)}${tailSentinel}`;

    const decision = evaluatePolicyGate(
      spawnToolCall({ role: "worker", allowed_tools: ["read", overLengthToolId] }),
      {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      }
    );

    expectSpawnBudgetDeny(decision, "per-tool id length", tailSentinel);
    if (decision.decision === "deny") {
      expect(`${decision.reason}\n${decision.remediation.hint}`).not.toContain(overLengthToolId);
    }
  });

  test("denies over-total-character spawn tools without echoing tail values", () => {
    const tailSentinel = "tail-sentinel-that-must-not-appear";
    const chunkLength = SPAWN_PROFILE_TOOL_ID_MAX_CHARS;
    const toolCount = Math.ceil((SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS + 1) / chunkLength);
    expect(toolCount).toBeLessThanOrEqual(SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS);
    const tools = Array.from({ length: toolCount }, (_, index) =>
      index === toolCount - 1
        ? `${"z".repeat(chunkLength - tailSentinel.length)}${tailSentinel}`
        : "x".repeat(chunkLength)
    );

    const decision = evaluatePolicyGate(spawnToolCall({ role: "worker", tools }), {
      rules: [SPAWN_PROFILE_SUBSET_RULE]
    });

    expectSpawnBudgetDeny(decision, "total tool-id characters", tailSentinel);
  });
});

function expectSpawnBudgetDeny(
  decision: ReturnType<typeof evaluatePolicyGate>,
  budgetLabel: string,
  tailSentinel: string
): void {
  expect(decision).toMatchObject({
    decision: "deny",
    ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
    guardClass: "authority",
    remediation: {
      next_action: "adjust_scope",
      ref: SPAWN_PROFILE_SUBSET_POLICY_REF
    }
  });
  if (decision.decision === "deny") {
    const combined = `${decision.reason}\n${decision.remediation.hint}`;
    expect(combined).toContain(budgetLabel);
    expect(combined).not.toContain(tailSentinel);
    expect(combined.length).toBeLessThan(500);
  }
}

function sampleToolCall(): PolicyGateToolCall {
  return {
    toolId: "bash",
    role: "worker",
    input: {
      command: "printf nope > data/raw/input.csv"
    },
    workDir: "/workspace/tasks/TASK-M1-SPIKE"
  };
}

function spawnToolCall(input: Record<string, unknown>): PolicyGateToolCall {
  return {
    toolId: "spawn_agent",
    role: "coordinator",
    input: {
      instruction: "Run the delegated task.",
      ...input
    },
    workDir: "/workspace/tasks/TASK-M1-SPIKE"
  };
}

function spawnToolCallRaw(input: unknown): PolicyGateToolCall {
  return {
    toolId: "spawn_agent",
    role: "coordinator",
    input,
    workDir: "/workspace/tasks/TASK-M1-SPIKE"
  };
}
