import { describe, expect, test } from "bun:test";
import {
  assertPolicyGateContextGuardClasses,
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
          guardClass: "authority",
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
      },
      guardClass: "authority"
    });
  });

  test("guard_class lint rejects unclassified hard guard rules", () => {
    expect(() =>
      assertPolicyGateContextGuardClasses({
        rules: [
          {
            ruleId: "unclassified-hard-guard",
            description: "Missing guard_class metadata.",
            evaluate: () => ({ decision: "allow" })
          } as never
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: unclassified-hard-guard: missing or invalid guardClass\/guard_class/
    );
  });

  test("guard_class lint rejects invalid hard guard classifications", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "invalid-guard-class",
            description: "Invalid guard_class metadata.",
            guardClass: "temporary",
            evaluate: () => ({ decision: "allow" })
          } as never
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-guard-class: missing or invalid guardClass\/guard_class/
    );
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
            guardClass: "authority",
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
      expect(decision.remediation.hint).toContain("(1 total)");
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

  test("denies invalid spawn mode before normalized input can reach execution", () => {
    const input = {
      instruction: "Run worker",
      role: "worker",
      tools: ["read"],
      mode: "detached"
    };
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    const decision = evaluatePolicyGate(spawnToolCall(input), context);
    const normalized = normalizeSpawnAgentInput(spawnToolCall(input));

    for (const result of [decision, normalized]) {
      expect(result).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_PROFILE_SUBSET_POLICY_REF
        }
      });
      if (result.decision === "deny") {
        expect(result.reason).toContain("mode");
        expect(result.reason).toContain("detached");
        expect(result.remediation.hint).toContain("standard");
        expect(result.remediation.hint).toContain("interactive");
        expect(result.remediation.hint).toContain("omit mode");
      }
    }
  });

  test("denies missing and blank spawn instructions before normalized input can reach execution", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };
    const inputs: unknown[] = [
      { role: "worker", tools: ["read"] },
      { instruction: undefined, role: "worker", tools: ["read"] },
      { instruction: "   ", role: "worker", tools: ["read"] },
      { role: "worker", tools: ["read"], mode: 1 }
    ];

    for (const input of inputs) {
      const decision = evaluatePolicyGate(spawnToolCallRaw(input), context);
      const normalized = normalizeSpawnAgentInput(spawnToolCallRaw(input));

      for (const result of [decision, normalized]) {
        expect(result).toMatchObject({
          decision: "deny",
          ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
          guardClass: "authority",
          remediation: {
            next_action: "adjust_scope",
            ref: SPAWN_PROFILE_SUBSET_POLICY_REF
          }
        });
        if (result.decision === "deny") {
          expect(result.reason).toContain("instruction");
          expect(result.remediation.hint).toContain("instruction");
        }
      }
    }
  });

  test("treats explicit undefined spawn allowlists as omitted", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    const omittedTools = normalizeSpawnAgentInput(
      spawnToolCallRaw({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: undefined
      })
    );
    expect(omittedTools).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (omittedTools.decision === "allow") {
      expect(omittedTools.input).toMatchObject({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: getRoleToolIds("worker")
      });
    }
    expect(
      evaluatePolicyGate(
        spawnToolCallRaw({
          instruction: "Run the delegated task.",
          role: "worker",
          allowed_tools: undefined
        }),
        context
      )
    ).toEqual({ decision: "allow" });

    const alias = normalizeSpawnAgentInput(
      spawnToolCallRaw({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: undefined,
        allowed_tools: ["read"]
      })
    );
    expect(alias).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (alias.decision === "allow") {
      expect(alias.input).toEqual({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: ["read"]
      });
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

  test("ignores hostile unknown spawn siblings without enumerating them", () => {
    const target: Record<string, unknown> = {
      instruction: "Run the delegated task.",
      role: "worker",
      tools: ["read"]
    };
    Object.defineProperty(target, "ignoredHostile", {
      enumerable: true,
      get() {
        throw new Error("ignored sibling getter should not run");
      }
    });
    let enumerated = false;
    const input = new Proxy(target, {
      ownKeys() {
        enumerated = true;
        throw new Error("ignored sibling keys should not be enumerated");
      }
    });

    const normalized = normalizeSpawnAgentInput(spawnToolCallRaw(input));

    expect(normalized).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (normalized.decision === "allow") {
      expect(normalized.input).toEqual({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: ["read"]
      });
      expect(normalized.input).not.toHaveProperty("ignoredHostile");
    }
    expect(enumerated).toBe(false);
  });

  test("denies accessor and proxy-backed spawn allowlist entries without executing them", () => {
    let accessorReads = 0;
    const accessorTools: unknown[] = [];
    Object.defineProperty(accessorTools, "0", {
      configurable: true,
      enumerable: true,
      get() {
        accessorReads += 1;
        return "read";
      }
    });

    const accessorDecision = normalizeSpawnAgentInput(
      spawnToolCallRaw({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: accessorTools
      })
    );

    expect(accessorDecision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
      guardClass: "authority"
    });
    expect(accessorReads).toBe(0);

    let proxyElementReads = 0;
    const proxyTools = new Proxy(["read"], {
      get(target, property, receiver) {
        proxyElementReads += 1;
        return Reflect.get(target, property, receiver);
      },
      getOwnPropertyDescriptor(target, property) {
        return Reflect.getOwnPropertyDescriptor(target, property);
      }
    });

    const proxyDecision = normalizeSpawnAgentInput(
      spawnToolCallRaw({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: proxyTools
      })
    );

    expect(proxyDecision).toMatchObject({
      decision: "allow",
      changed: true
    });
    if (proxyDecision.decision === "allow") {
      expect(proxyDecision.input).toEqual({
        instruction: "Run the delegated task.",
        role: "worker",
        tools: ["read"]
      });
    }
    expect(proxyElementReads).toBe(0);
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

  test("allows canonical-role spawn without an explicit allowlist at pure rule level", () => {
    expect(
      evaluatePolicyGate(spawnToolCall({ role: "worker" }), {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      })
    ).toEqual({ decision: "allow" });
  });

  test("denies spawn without a canonical role profile or explicit allowlist", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    for (const input of [{}, { role: "not_a_harness_role" }, { role: " " }]) {
      const decision = evaluatePolicyGate(spawnToolCall(input), context);
      const normalized = normalizeSpawnAgentInput(spawnToolCall(input));

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_PROFILE_SUBSET_POLICY_REF
        }
      });
      expect(normalized).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_PROFILE_SUBSET_POLICY_REF
        }
      });
      if (decision.decision === "deny") {
        expect(decision.reason).toContain("no canonical SHUD role profile");
        expect(decision.remediation.hint).toContain("canonical SHUD spawn role");
      }
    }
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

  test("snapshots proxy allowlists without executing direct property gets", () => {
    for (const field of ["tools", "allowed_tools"] as const) {
      let propertyGets = 0;
      const allowlist = new Proxy(["read"], {
        get(target, property, receiver) {
          propertyGets += 1;
          return Reflect.get(target, property, receiver);
        },
        getOwnPropertyDescriptor(target, property) {
          return Reflect.getOwnPropertyDescriptor(target, property);
        }
      });
      const input = { role: "worker", [field]: allowlist };

      const decision = evaluatePolicyGate(spawnToolCall(input), {
        rules: [SPAWN_PROFILE_SUBSET_RULE]
      });
      const normalized = normalizeSpawnAgentInput(spawnToolCall(input));

      expect(decision).toEqual({ decision: "allow" });
      expect(normalized).toMatchObject({
        decision: "allow",
        changed: true
      });
      if (normalized.decision === "allow") {
        expect(normalized.input).toEqual({
          instruction: "Run the delegated task.",
          role: "worker",
          tools: ["read"]
        });
      }
      expect(propertyGets).toBe(0);
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

  test("denies roleless and noncanonical explicit allowlists without a comparable profile", () => {
    const context = { rules: [SPAWN_PROFILE_SUBSET_RULE] };

    for (const input of [
      { tools: ["read", "edit"] },
      { allowed_tools: [" read ", "edit", "read"] },
      { role: "not_a_harness_role", tools: ["read", "edit"] },
      { role: "not_a_harness_role", allowed_tools: ["read"] }
    ]) {
      const decision = evaluatePolicyGate(spawnToolCall(input), context);
      const normalized = normalizeSpawnAgentInput(spawnToolCall(input));

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_PROFILE_SUBSET_POLICY_REF
        }
      });
      expect(normalized).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_PROFILE_SUBSET_POLICY_REF
        }
      });
      if (decision.decision === "deny") {
        expect(decision.reason).toContain("no canonical SHUD role profile");
        expect(decision.remediation.hint).toContain("canonical SHUD spawn role");
      }
    }
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
