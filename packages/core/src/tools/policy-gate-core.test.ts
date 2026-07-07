import { describe, expect, test } from "bun:test";
import {
  assertPolicyGateContextGuardClasses,
  evaluatePolicyGate,
  isReservedAuthorityPolicyErrorId,
  isReservedAuthorityPolicyRuleIdPrefixImpersonation,
  isReservedAuthorityPolicyRuleId,
  MAX_CONCURRENT_SUBAGENTS,
  MAX_SPAWN_DEPTH,
  normalizeSpawnAgentInput,
  PolicyGateRemediationSchema,
  RESERVED_AUTHORITY_POLICY_RULE_IDS,
  SPAWN_CONCURRENCY_LIMIT_RULE,
  SPAWN_CONCURRENCY_LIMIT_RULE_ID,
  SPAWN_DEPTH_LIMIT_RULE,
  SPAWN_DEPTH_LIMIT_RULE_ID,
  SPAWN_LIMITS_POLICY_REF,
  SPAWN_PROFILE_ALLOWLIST_MAX_ITEMS,
  SPAWN_PROFILE_ALLOWLIST_MAX_TOTAL_CHARS,
  SPAWN_PROFILE_MAX_EXCESS_TOOL_SAMPLES,
  SPAWN_PROFILE_SUBSET_POLICY_REF,
  SPAWN_PROFILE_SUBSET_RULE,
  SPAWN_PROFILE_SUBSET_RULE_ID,
  SPAWN_PROFILE_TOOL_ID_MAX_CHARS,
  TOOL_PARAMETER_SCHEMA_RULE_ID,
  type PolicyGateToolCall,
  type PolicyRule
} from "./policy-gate-core";
import { DEFAULT_SHUD_POLICY_GATE_CONTEXT } from "./policy-gate-registry";
import { RAW_DATA_WRITE_RULE_ID } from "./raw-data-sandbox";
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

  test("returns trimmed ruleId from padded rule metadata", () => {
    const decision = evaluatePolicyGate(sampleToolCall(), {
      rules: [
        {
          ruleId: " padded ",
          description: "Uses padded source metadata.",
          guardClass: "authority",
          evaluate: () => ({
            decision: "deny",
            reason: "padded rule metadata denied",
            remediation: sampleRemediation()
          })
        }
      ]
    });

    expect(decision).toEqual({
      decision: "deny",
      ruleId: "padded",
      reason: "padded rule metadata denied",
      remediation: sampleRemediation(),
      guardClass: "authority"
    });
  });

  test("uses validated guard metadata when a raw data rule mutates during evaluation", () => {
    const rule: PolicyRule = {
      ruleId: RAW_DATA_WRITE_RULE_ID,
      description: "Mutates guardClass after context validation.",
      guardClass: "authority",
      evaluate: () => {
        rule.guardClass = "capability";
        return {
          decision: "deny",
          reason: "raw data write denied after mutation",
          remediation: sampleRemediation()
        };
      }
    };

    const decision = evaluatePolicyGate(sampleToolCall(), { rules: [rule] });

    expect(rule.guardClass).toBe("capability");
    expect(decision).toEqual({
      decision: "deny",
      ruleId: RAW_DATA_WRITE_RULE_ID,
      reason: "raw data write denied after mutation",
      remediation: sampleRemediation(),
      guardClass: "authority"
    });
  });

  test("guard_class lint rejects spawn profile authority downgrades", () => {
    expect(() =>
      assertPolicyGateContextGuardClasses({
        rules: [
          {
            ruleId: SPAWN_PROFILE_SUBSET_RULE_ID,
            description: "Attempts to downgrade reserved spawn authority.",
            guardClass: "capability",
            evaluate: () => ({ decision: "allow" })
          }
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: spawn-profile-subset: known authority rule cannot be classified as capability/
    );
  });

  test("guard_class lint treats Zod schema validation as reserved authority", () => {
    expect(RESERVED_AUTHORITY_POLICY_RULE_IDS).toContain(TOOL_PARAMETER_SCHEMA_RULE_ID);
    expect(isReservedAuthorityPolicyRuleId(TOOL_PARAMETER_SCHEMA_RULE_ID)).toBe(true);

    expect(() =>
      assertPolicyGateContextGuardClasses({
        rules: [
          {
            ruleId: TOOL_PARAMETER_SCHEMA_RULE_ID,
            description: "Attempts to downgrade built-in Zod parameter schema authority.",
            guardClass: "capability",
            evaluate: () => ({ decision: "allow" })
          }
        ]
      })
    ).toThrow(
      new RegExp(
        `Policy gate guard_class lint failed: ${TOOL_PARAMETER_SCHEMA_RULE_ID}: known authority rule cannot be classified as capability`
      )
    );
  });

  test("ruleId lint rejects reserved authority rule prefix impersonation for every guard class", () => {
    for (const reservedRuleId of RESERVED_AUTHORITY_POLICY_RULE_IDS) {
      for (const guardClass of ["authority", "capability"] as const) {
        const impersonatedRuleId = `${reservedRuleId}:caller-minted`;

        expect(() =>
          assertPolicyGateContextGuardClasses({
            rules: [
              {
                ruleId: impersonatedRuleId,
                description: "Attempts to mint a reserved authority rule prefix.",
                guardClass,
                evaluate: () => ({ decision: "allow" })
              }
            ]
          })
        ).toThrow(
          `Policy gate ruleId lint failed: ${impersonatedRuleId}: reserved authority policy rule prefixes are reserved for error_id`
        );
      }
    }
  });

  test("evaluatePolicyGate rejects reserved authority rule prefix impersonation for every guard class", () => {
    for (const reservedRuleId of RESERVED_AUTHORITY_POLICY_RULE_IDS) {
      for (const guardClass of ["authority", "capability"] as const) {
        const impersonatedRuleId = `${reservedRuleId}:caller-minted`;

        expect(() =>
          evaluatePolicyGate(sampleToolCall(), {
            rules: [
              {
                ruleId: impersonatedRuleId,
                description: "Attempts to mint a reserved authority rule prefix.",
                guardClass,
                evaluate: () => ({ decision: "allow" })
              }
            ]
          })
        ).toThrow(
          `Policy gate ruleId lint failed: ${impersonatedRuleId}: reserved authority policy rule prefixes are reserved for error_id`
        );
      }
    }
  });

  test("reserved authority identity helpers are field-specific", () => {
    for (const ruleId of RESERVED_AUTHORITY_POLICY_RULE_IDS) {
      expect(isReservedAuthorityPolicyRuleId(ruleId)).toBe(true);
      expect(isReservedAuthorityPolicyErrorId(ruleId)).toBe(true);
      expect(isReservedAuthorityPolicyErrorId(`${ruleId}:failed:tool-call-1`)).toBe(true);
      expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation(`${ruleId}:failed`)).toBe(
        true
      );
      expect(isReservedAuthorityPolicyRuleId(`${ruleId}:failed`)).toBe(false);
    }

    expect(isReservedAuthorityPolicyErrorId(undefined)).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation(undefined)).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("spawn-profile-subset-extra")).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation("spawn-profile-subset-extra")).toBe(
      false
    );
    expect(isReservedAuthorityPolicyErrorId("tool-parameter-schema-validation-extra")).toBe(
      false
    );
    expect(
      isReservedAuthorityPolicyRuleIdPrefixImpersonation(
        "tool-parameter-schema-validation-extra"
      )
    ).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("raw-data-writeish")).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation("raw-data-writeish")).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("workspace-quota:raw-data-write")).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation("workspace-quota:raw-data-write")).toBe(
      false
    );
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

  test("guard_class lint rejects invalid deny result classifications", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "invalid-result-guard-class",
            description: "Valid rule metadata with an invalid result-level classification.",
            guardClass: "authority",
            evaluate: () => ({
              decision: "deny",
              reason: "result guard class is invalid",
              remediation: {
                next_action: "adjust_scope",
                hint: "Use a valid guard class.",
                ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md"
              },
              guardClass: "temporary"
            })
          } as never
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-result-guard-class: invalid result guardClass/
    );
  });

  test("guard_class lint rejects deny result classifications that conflict with rule metadata", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "conflicting-result-guard-class",
            description: "Valid rule metadata with a conflicting result-level classification.",
            guardClass: "authority",
            evaluate: () => ({
              decision: "deny",
              reason: "result guard class conflicts with the rule source of truth",
              remediation: {
                next_action: "adjust_scope",
                hint: "Align the result guard class with the owning rule.",
                ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md"
              },
              guardClass: "capability"
            })
          }
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-guard-class: result guardClass capability conflicts with rule guardClass authority/
    );
  });

  test("snake_case deny result guard_class matching rule metadata is accepted", () => {
    const decision = evaluatePolicyGate(sampleToolCall(), {
      rules: [
        {
          ruleId: "result-snake-case-guard",
          description: "Returns a spec-shaped result-level classification.",
          guardClass: "authority",
          evaluate: () => ({
            decision: "deny",
            reason: "snake_case result guard denied",
            remediation: sampleRemediation(),
            guard_class: "authority"
          })
        }
      ]
    });

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: "result-snake-case-guard",
      guardClass: "authority"
    });
  });

  test("guard_class lint rejects invalid snake_case deny result classifications", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "invalid-result-snake-guard-class",
            description: "Valid rule metadata with an invalid snake_case result classification.",
            guardClass: "authority",
            evaluate: () => ({
              decision: "deny",
              reason: "result guard_class is invalid",
              remediation: sampleRemediation(),
              guard_class: "temporary"
            })
          } as never
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-result-snake-guard-class: invalid result guard_class/
    );
  });

  test("guard_class lint rejects snake_case deny result classifications that conflict with rule metadata", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "conflicting-result-snake-guard-class",
            description: "Valid rule metadata with a conflicting snake_case result classification.",
            guardClass: "authority",
            evaluate: () => ({
              decision: "deny",
              reason: "result guard_class conflicts with the rule source of truth",
              remediation: sampleRemediation(),
              guard_class: "capability"
            })
          }
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-snake-guard-class: result guard_class capability conflicts with rule guardClass authority/
    );
  });

  test("matching deny result guard aliases are accepted and normalized", () => {
    const decision = evaluatePolicyGate(sampleToolCall(), {
      rules: [
        {
          ruleId: "matching-result-guard-aliases",
          description: "Returns matching result guard aliases.",
          guardClass: "capability",
          evaluate: () => ({
            decision: "deny",
            reason: "matching result guard aliases denied",
            remediation: sampleRemediation(),
            guardClass: "capability",
            guard_class: "capability"
          })
        }
      ]
    });

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: "matching-result-guard-aliases",
      guardClass: "capability"
    });
  });

  test("guard_class lint rejects conflicting deny result guard aliases", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "conflicting-result-guard-aliases",
            description: "Returns conflicting result guard aliases.",
            guardClass: "authority",
            evaluate: () => ({
              decision: "deny",
              reason: "conflicting result guard aliases denied",
              remediation: sampleRemediation(),
              guardClass: "authority",
              guard_class: "capability"
            })
          }
        ]
      })
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-guard-aliases: conflicting result guardClass, guard_class/
    );
  });

  test("ruleId lint rejects empty and whitespace context rule identities", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: " ",
            description: "Missing stable identity.",
            guardClass: "authority",
            evaluate: () => ({ decision: "allow" })
          }
        ]
      })
    ).toThrow(/Policy gate ruleId lint failed: <rule-0>: ruleId must be a non-empty string/);
  });

  test("ruleId lint rejects duplicate context rule identities after trimming", () => {
    expect(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "duplicate-rule",
            description: "First identity.",
            guardClass: "authority",
            evaluate: () => ({ decision: "allow" })
          },
          {
            ruleId: " duplicate-rule ",
            description: "Duplicate identity.",
            guardClass: "authority",
            evaluate: () => ({ decision: "allow" })
          }
        ]
      })
    ).toThrow(
      /Policy gate ruleId lint failed: duplicate-rule: duplicate ruleId also used by duplicate-rule/
    );
  });

  test("snake_case guard_class metadata propagates into deny decisions", () => {
    const decision = evaluatePolicyGate(sampleToolCall(), {
      rules: [
        {
          ruleId: "snake-case-guard",
          description: "Uses spec-shaped guard_class metadata.",
          guard_class: "authority",
          evaluate: () => ({
            decision: "deny",
            reason: "snake_case guard denied",
            remediation: {
              next_action: "adjust_scope",
              hint: "Use a governed scope.",
              ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md"
            }
          })
        }
      ]
    });

    expect(decision).toEqual({
      decision: "deny",
      ruleId: "snake-case-guard",
      reason: "snake_case guard denied",
      remediation: {
        next_action: "adjust_scope",
        hint: "Use a governed scope.",
        ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md"
      },
      guardClass: "authority"
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

describe("spawn limit policy rules", () => {
  test("default SHUD context includes reserved authority spawn limit rules", () => {
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
        spawnDepth: MAX_SPAWN_DEPTH
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_DEPTH_LIMIT_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_LIMITS_POLICY_REF
      }
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
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT
    );

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: SPAWN_CONCURRENCY_LIMIT_RULE_ID,
      guardClass: "authority",
      remediation: {
        next_action: "adjust_scope",
        ref: SPAWN_LIMITS_POLICY_REF
      }
    });
    if (decision.decision === "deny") {
      expect(decision.reason).toContain(
        `max_concurrent_subagents=${MAX_CONCURRENT_SUBAGENTS}`
      );
      expect(decision.remediation.hint).toContain("M1 denies");
      expect(PolicyGateRemediationSchema.safeParse(decision.remediation).success).toBe(true);
    }
  });

  test("allows spawn_agent below trusted depth and concurrency limits", () => {
    const decision = evaluatePolicyGate(
      {
        ...spawnToolCall({ role: "worker", tools: ["read", "sandbox.exec"] }),
        spawnDepth: MAX_SPAWN_DEPTH - 1,
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS - 1
      },
      DEFAULT_SHUD_POLICY_GATE_CONTEXT
    );

    expect(decision).toEqual({ decision: "allow" });
  });

  test("denies present-invalid trusted spawn depth metadata", () => {
    for (const spawnDepth of [-1, Number.NaN, 1.5]) {
      const decision = evaluatePolicyGate(
        {
          ...spawnToolCall({ role: "worker", tools: ["read"] }),
          spawnDepth
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT
      );

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_DEPTH_LIMIT_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_LIMITS_POLICY_REF
        }
      });
    }
  });

  test("denies present-invalid trusted active subagent count metadata", () => {
    for (const activeSubagentCount of [-1, Number.NaN, 1.5]) {
      const decision = evaluatePolicyGate(
        {
          ...spawnToolCall({ role: "worker", tools: ["read"] }),
          activeSubagentCount
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT
      );

      expect(decision).toMatchObject({
        decision: "deny",
        ruleId: SPAWN_CONCURRENCY_LIMIT_RULE_ID,
        guardClass: "authority",
        remediation: {
          next_action: "adjust_scope",
          ref: SPAWN_LIMITS_POLICY_REF
        }
      });
    }
  });

  test("does not treat model-controlled spawn limit input fields as trusted context", () => {
    const decision = evaluatePolicyGate(
      spawnToolCall({
        role: "worker",
        tools: ["read"],
        spawnDepth: MAX_SPAWN_DEPTH,
        activeSubagentCount: MAX_CONCURRENT_SUBAGENTS
      }),
      DEFAULT_SHUD_POLICY_GATE_CONTEXT
    );

    expect(decision).toEqual({ decision: "allow" });
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

function sampleRemediation() {
  return {
    next_action: "adjust_scope" as const,
    hint: "Use a governed scope.",
    ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md"
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
