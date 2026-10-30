import { DEFAULT_SHUD_POLICY_GATE_CONTEXT, evaluatePolicyGate } from "@shud-harness/dsh-shud-core";
import type * as Core from "@shud-harness/dsh-shud-core";
import { beforeEach, expect, test, vi } from "vitest";
import { POLICY_EVALUATION_FAILURE_REASON } from "./index.ts";
import { createPolicyHarness, REPORT_ID } from "./test-harness.ts";

// Explicitly authorized fault injection at the canonical evaluator module boundary.
// All other suites use the real evaluator without mocking core.
vi.mock("@shud-harness/dsh-shud-core", async (original) => {
  const actual = await original<typeof Core>();
  return { ...actual, evaluatePolicyGate: vi.fn(actual.evaluatePolicyGate) };
});
beforeEach(() => vi.mocked(evaluatePolicyGate).mockClear());

test.each([
  { preset: "coordinator", role: "coordinator" },
  { preset: "worker", role: "worker" },
  { preset: "reviewer", role: "unknown" },
  { preset: undefined, role: "unknown" },
])(
  "canonical rules evaluate current $preset as $role with the original input",
  async ({ preset, role }) => {
    const h = await createPolicyHarness({ preset });
    try {
      const input = Object.freeze({ private: Object.freeze({ text: "do-not-mutate" }) });
      expect(await h.decide("shud_collect", input)).toEqual({ kind: "cancel" });
      expect(evaluatePolicyGate).toHaveBeenCalledTimes(1);
      expect(evaluatePolicyGate).toHaveBeenCalledWith(
        {
          toolId: "shud_collect",
          role,
          input,
          workDir: h.cwd,
        },
        DEFAULT_SHUD_POLICY_GATE_CONTEXT,
      );
      expect(vi.mocked(evaluatePolicyGate).mock.calls[0][0].input).toBe(input);
      expect(h.next).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  },
);

test.each([
  { input: { workdir: "/explicit-workspace" }, expected: "/explicit-workspace" },
  { input: { workdir: "" }, expected: "" },
  { input: { workdir: 7 }, expected: "session" },
  { input: {}, expected: "session" },
  { input: null, expected: "session" },
  { input: [], expected: "session" },
  { input: undefined, expected: "session" },
])("policy workDir honors string input then session cwd: $input", async ({ input, expected }) => {
  const h = await createPolicyHarness({ preset: "worker" });
  try {
    expect(await h.decide("shud_collect", input)).toEqual({ kind: "cancel" });
    expect(evaluatePolicyGate).toHaveBeenCalledTimes(1);
    const [call, context] = vi.mocked(evaluatePolicyGate).mock.calls[0];
    expect(context).toBe(DEFAULT_SHUD_POLICY_GATE_CONTEXT);
    expect(call.input).toBe(input);
    expect(call.workDir).toBe(expected === "session" ? h.cwd : expected);
  } finally {
    await h.dispose();
  }
});

test("missing caller never gives the evaluator a process workspace", async () => {
  const h = await createPolicyHarness();
  try {
    expect(await h.decide("shud_collect", null, null)).toEqual({ kind: "cancel" });
    const [call] = vi.mocked(evaluatePolicyGate).mock.calls[0];
    expect(call).toMatchObject({ toolId: "shud_collect", role: "unknown", input: null });
    expect(call.workDir).toBeUndefined();
  } finally {
    await h.dispose();
  }
});

test.each(["shud_collect", "report_submit", "report_decide"])(
  "evaluator failure denies %s without leaking exception or input",
  async (tool) => {
    const h = await createPolicyHarness();
    try {
      vi.mocked(evaluatePolicyGate).mockImplementationOnce(() => {
        throw new Error("secret-detail-private-evaluator-stack");
      });
      const decision = await h.decide(tool, {
        report_id: REPORT_ID,
        comment: "private-tool-argument",
      });
      expect(decision).toEqual({ kind: "deny", reason: POLICY_EVALUATION_FAILURE_REASON });
      expect(POLICY_EVALUATION_FAILURE_REASON.length).toBeGreaterThan(0);
      expect(JSON.stringify(decision)).not.toContain("secret-detail");
      expect(JSON.stringify(decision)).not.toContain("private-tool-argument");
      expect(JSON.stringify(decision)).not.toContain(REPORT_ID);
      expect(h.next).not.toHaveBeenCalled();
      expect(h.request).not.toHaveBeenCalled();
      expect(h.policyLogs()).toEqual([[`deny ${tool} policy-evaluation-failed`]]);
    } finally {
      await h.dispose();
    }
  },
);

test("actual runtime never dispatches a report tool after evaluator failure", async () => {
  const h = await createPolicyHarness();
  try {
    vi.mocked(evaluatePolicyGate).mockImplementationOnce(() => {
      throw new Error("secret-detail-runtime-evaluator");
    });
    const result = await h.call("report_submit", { report_id: REPORT_ID });
    expect(result).toMatchObject({
      isError: true,
      error: { message: POLICY_EVALUATION_FAILURE_REASON },
    });
    expect(h.executions).toEqual([]);
    expect(h.request).not.toHaveBeenCalled();
    expect(evaluatePolicyGate).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});
