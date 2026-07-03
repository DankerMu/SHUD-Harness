import { describe, expect, test } from "bun:test";
import {
  evaluatePolicyGate,
  PolicyGateRemediationSchema,
  type PolicyGateToolCall
} from "./policy-gate-core";

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
