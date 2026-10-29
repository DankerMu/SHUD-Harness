import { describe, expect, test } from "vitest";
import {
  assertPolicyGateContextGuardClasses,
  evaluatePolicyGate,
  isReservedAuthorityPolicyErrorId,
  isReservedAuthorityPolicyRuleIdPrefixImpersonation,
  isReservedAuthorityPolicyRuleId,
  RESERVED_AUTHORITY_POLICY_RULE_IDS,
} from "./evaluate.ts";
import {
  PolicyGateDecisionValidationError,
  PolicyGateRemediationSchema,
  TOOL_PARAMETER_SCHEMA_RULE_ID,
} from "./parameter-schema.ts";
import type {
  PolicyGateContext,
  PolicyGateRemediation,
  PolicyGateToolCall,
  PolicyRule,
} from "./types.ts";

// Rule id owned by the raw-data guard plugin (dsh-shud-raw-guard, M1); the gate core only needs the string.
const RAW_DATA_WRITE_RULE_ID = "raw-data-write";

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
    const context: PolicyGateContext = {
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
              ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md",
            },
          }),
        },
      ],
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
        ref: "openspec/changes/m1-foundation/specs/policy-gate-spike/spec.md",
      },
      guardClass: "authority",
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
            remediation: sampleRemediation(),
          }),
        },
      ],
    });

    expect(decision).toEqual({
      decision: "deny",
      ruleId: "padded",
      reason: "padded rule metadata denied",
      remediation: sampleRemediation(),
      guardClass: "authority",
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
          remediation: sampleRemediation(),
        };
      },
    };

    const decision = evaluatePolicyGate(sampleToolCall(), { rules: [rule] });

    expect(rule.guardClass).toBe("capability");
    expect(decision).toEqual({
      decision: "deny",
      ruleId: RAW_DATA_WRITE_RULE_ID,
      reason: "raw data write denied after mutation",
      remediation: sampleRemediation(),
      guardClass: "authority",
    });
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
            evaluate: () => ({ decision: "allow" }),
          },
        ],
      }),
    ).toThrow(
      new RegExp(
        `Policy gate guard_class lint failed: ${TOOL_PARAMETER_SCHEMA_RULE_ID}: known authority rule cannot be classified as capability`,
      ),
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
                evaluate: () => ({ decision: "allow" }),
              },
            ],
          }),
        ).toThrow(
          `Policy gate ruleId lint failed: ${impersonatedRuleId}: reserved authority policy rule prefixes are reserved for error_id`,
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
                evaluate: () => ({ decision: "allow" }),
              },
            ],
          }),
        ).toThrow(
          `Policy gate ruleId lint failed: ${impersonatedRuleId}: reserved authority policy rule prefixes are reserved for error_id`,
        );
      }
    }
  });

  test("reserved authority identity helpers are field-specific", () => {
    for (const ruleId of RESERVED_AUTHORITY_POLICY_RULE_IDS) {
      expect(isReservedAuthorityPolicyRuleId(ruleId)).toBe(true);
      expect(isReservedAuthorityPolicyErrorId(ruleId)).toBe(true);
      expect(isReservedAuthorityPolicyErrorId(`${ruleId}:failed:tool-call-1`)).toBe(true);
      expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation(`${ruleId}:failed`)).toBe(true);
      expect(isReservedAuthorityPolicyRuleId(`${ruleId}:failed`)).toBe(false);
    }

    expect(isReservedAuthorityPolicyErrorId(undefined)).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation(undefined)).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("spawn-profile-subset-extra")).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation("spawn-profile-subset-extra")).toBe(
      false,
    );
    expect(isReservedAuthorityPolicyErrorId("tool-parameter-schema-validation-extra")).toBe(false);
    expect(
      isReservedAuthorityPolicyRuleIdPrefixImpersonation("tool-parameter-schema-validation-extra"),
    ).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("raw-data-writeish")).toBe(false);
    expect(isReservedAuthorityPolicyRuleIdPrefixImpersonation("raw-data-writeish")).toBe(false);
    expect(isReservedAuthorityPolicyErrorId("workspace-quota:raw-data-write")).toBe(false);
    expect(
      isReservedAuthorityPolicyRuleIdPrefixImpersonation("workspace-quota:raw-data-write"),
    ).toBe(false);
  });

  test("guard_class lint rejects unclassified hard guard rules", () => {
    expect(() =>
      assertPolicyGateContextGuardClasses({
        rules: [
          {
            ruleId: "unclassified-hard-guard",
            description: "Missing guard_class metadata.",
            evaluate: () => ({ decision: "allow" }),
          } as never,
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: unclassified-hard-guard: missing or invalid guardClass\/guard_class/,
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
            evaluate: () => ({ decision: "allow" }),
          } as never,
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-guard-class: missing or invalid guardClass\/guard_class/,
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
                ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
              },
              guardClass: "temporary",
            }),
          } as never,
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-result-guard-class: invalid result guardClass/,
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
                ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
              },
              guardClass: "capability",
            }),
          },
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-guard-class: result guardClass capability conflicts with rule guardClass authority/,
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
            guard_class: "authority",
          }),
        },
      ],
    });

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: "result-snake-case-guard",
      guardClass: "authority",
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
              guard_class: "temporary",
            }),
          } as never,
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: invalid-result-snake-guard-class: invalid result guard_class/,
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
              guard_class: "capability",
            }),
          },
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-snake-guard-class: result guard_class capability conflicts with rule guardClass authority/,
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
            guard_class: "capability",
          }),
        },
      ],
    });

    expect(decision).toMatchObject({
      decision: "deny",
      ruleId: "matching-result-guard-aliases",
      guardClass: "capability",
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
              guard_class: "capability",
            }),
          },
        ],
      }),
    ).toThrow(
      /Policy gate guard_class lint failed: conflicting-result-guard-aliases: conflicting result guardClass, guard_class/,
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
            evaluate: () => ({ decision: "allow" }),
          },
        ],
      }),
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
            evaluate: () => ({ decision: "allow" }),
          },
          {
            ruleId: " duplicate-rule ",
            description: "Duplicate identity.",
            guardClass: "authority",
            evaluate: () => ({ decision: "allow" }),
          },
        ],
      }),
    ).toThrow(
      /Policy gate ruleId lint failed: duplicate-rule: duplicate ruleId also used by duplicate-rule/,
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
              ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
            },
          }),
        },
      ],
    });

    expect(decision).toEqual({
      decision: "deny",
      ruleId: "snake-case-guard",
      reason: "snake_case guard denied",
      remediation: {
        next_action: "adjust_scope",
        hint: "Use a governed scope.",
        ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
      },
      guardClass: "authority",
    });
  });

  test("remediation payload requires legal next_action plus hint and ref", () => {
    const valid = PolicyGateRemediationSchema.safeParse({
      next_action: "fix_and_retry",
      hint: "Fix the path and retry.",
      ref: "docs/02_ARCHITECTURE/Control_Kernel.md#5-stop-conditions-与策略门校验约定",
    });
    expect(valid.success).toBe(true);

    const invalid = PolicyGateRemediationSchema.safeParse({
      next_action: "try_anyway",
      hint: "",
      ref: "",
    });
    expect(invalid.success).toBe(false);
    if (!invalid.success) {
      expect(invalid.error.issues.map((issue) => issue.path.join("."))).toEqual([
        "next_action",
        "hint",
        "ref",
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
                ref: "spec",
              } as never,
            }),
          },
        ],
      }),
    ).toThrow("next_action");
  });

  test("rule decision snapshot rejects proxy results without reading traps", () => {
    const sentinel = "RULE_DECISION_PROXY_SECRET";
    let getCalls = 0;
    let descriptorCalls = 0;
    const proxyDecision = new Proxy(
      {
        decision: "deny" as const,
        reason: "proxy-backed rule decisions should be rejected",
        remediation: sampleRemediation(),
      },
      {
        get() {
          getCalls += 1;
          throw new Error(sentinel);
        },
        getOwnPropertyDescriptor() {
          descriptorCalls += 1;
          throw new Error(sentinel);
        },
      },
    );

    const error = capturePolicyGateError(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "proxy-rule-decision",
            description: "Returns a proxy-backed decision.",
            guardClass: "capability",
            evaluate: () => proxyDecision,
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(PolicyGateDecisionValidationError);
    expect((error as Error).message).toBe(
      "Invalid policy gate decision for proxy-rule-decision: decision",
    );
    expect((error as Error).message).not.toContain(sentinel);
    expect(getCalls).toBe(0);
    expect(descriptorCalls).toBe(0);
  });

  test("rule decision snapshot rejects accessor result fields without invoking getters", () => {
    const sentinel = "RULE_DECISION_ACCESSOR_SECRET";
    let decisionReads = 0;
    const accessorDecision: Record<string, unknown> = {
      reason: "accessor-backed decision fields should be rejected",
      remediation: sampleRemediation(),
    };
    Object.defineProperty(accessorDecision, "decision", {
      enumerable: true,
      get() {
        decisionReads += 1;
        throw new Error(sentinel);
      },
    });

    const error = capturePolicyGateError(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "accessor-rule-decision",
            description: "Returns an accessor-backed decision.",
            guardClass: "capability",
            evaluate: () => accessorDecision as never,
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(PolicyGateDecisionValidationError);
    expect((error as Error).message).toBe(
      "Invalid policy gate decision for accessor-rule-decision: decision",
    );
    expect((error as Error).message).not.toContain(sentinel);
    expect(decisionReads).toBe(0);
  });

  test("rule decision snapshot rejects enumerable toJSON without invoking it", () => {
    const sentinel = "RULE_DECISION_TO_JSON_SECRET";
    let toJsonCalls = 0;
    const decision = {
      decision: "deny" as const,
      reason: "enumerable toJSON should be rejected",
      remediation: sampleRemediation(),
      toJSON() {
        toJsonCalls += 1;
        throw new Error(sentinel);
      },
    };

    const error = capturePolicyGateError(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "tojson-rule-decision",
            description: "Returns a decision with enumerable toJSON.",
            guardClass: "capability",
            evaluate: () => decision,
          },
        ],
      }),
    );

    expect(error).toBeInstanceOf(PolicyGateDecisionValidationError);
    expect((error as Error).message).toBe(
      "Invalid policy gate decision for tojson-rule-decision: toJSON",
    );
    expect((error as Error).message).not.toContain(sentinel);
    expect(toJsonCalls).toBe(0);
  });

  test("rule decision snapshot rejects hostile remediation fields before schema parsing", () => {
    const proxySentinel = "RULE_REMEDIATION_PROXY_SECRET";
    let proxyGetCalls = 0;
    let proxyDescriptorCalls = 0;
    const proxyRemediation = new Proxy(sampleRemediation(), {
      get() {
        proxyGetCalls += 1;
        throw new Error(proxySentinel);
      },
      getOwnPropertyDescriptor() {
        proxyDescriptorCalls += 1;
        throw new Error(proxySentinel);
      },
    });

    const proxyError = capturePolicyGateError(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "proxy-remediation-rule-decision",
            description: "Returns proxy-backed remediation.",
            guardClass: "capability",
            evaluate: () => ({
              decision: "deny",
              reason: "proxy remediation should be rejected",
              remediation: proxyRemediation,
            }),
          },
        ],
      }),
    );

    expect(proxyError).toBeInstanceOf(PolicyGateDecisionValidationError);
    expect((proxyError as Error).message).toBe(
      "Invalid policy gate decision for proxy-remediation-rule-decision: remediation",
    );
    expect((proxyError as Error).message).not.toContain(proxySentinel);
    expect(proxyGetCalls).toBe(0);
    expect(proxyDescriptorCalls).toBe(0);

    const accessorSentinel = "RULE_REMEDIATION_ACCESSOR_SECRET";
    let nextActionReads = 0;
    const accessorRemediation: Record<string, unknown> = {
      hint: "Use data descriptors for remediation fields.",
      ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
    };
    Object.defineProperty(accessorRemediation, "next_action", {
      enumerable: true,
      get() {
        nextActionReads += 1;
        throw new Error(accessorSentinel);
      },
    });

    const accessorError = capturePolicyGateError(() =>
      evaluatePolicyGate(sampleToolCall(), {
        rules: [
          {
            ruleId: "accessor-remediation-rule-decision",
            description: "Returns accessor-backed remediation.",
            guardClass: "capability",
            evaluate: () => ({
              decision: "deny",
              reason: "accessor remediation should be rejected",
              // Deliberately invalid accessor fixture must reach runtime rejection without invoking the getter.
              remediation: accessorRemediation as PolicyGateRemediation,
            }),
          },
        ],
      }),
    );

    expect(accessorError).toBeInstanceOf(PolicyGateDecisionValidationError);
    expect((accessorError as Error).message).toBe(
      "Invalid policy gate decision for accessor-remediation-rule-decision: remediation.next_action",
    );
    expect((accessorError as Error).message).not.toContain(accessorSentinel);
    expect(nextActionReads).toBe(0);
  });
});

function capturePolicyGateError(action: () => void): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error("Expected policy gate evaluation to throw.");
}

function sampleToolCall(): PolicyGateToolCall {
  return {
    toolId: "bash",
    role: "worker",
    input: {
      command: "printf nope > data/raw/input.csv",
    },
    workDir: "/workspace/tasks/TASK-M1-SPIKE",
  };
}

function sampleRemediation() {
  return {
    next_action: "adjust_scope" as const,
    hint: "Use a governed scope.",
    ref: "openspec/changes/m1-foundation/specs/tool-registry-governance/spec.md",
  };
}
