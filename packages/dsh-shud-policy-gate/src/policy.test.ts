import type { Context } from "@deepseek-ai/cordis";
import type { PreToolDecision } from "@deepseek-ai/dsh-tools";
import { expect, test, vi } from "vitest";
import { apply } from "./index.ts";
import { createPolicyHarness, expectAsk, REPORT_ID } from "./test-harness.ts";

test("apply registers exactly one pre-execute listener and no approval invocation", () => {
  const on = vi.fn();
  const effect = vi.fn();
  const request = vi.fn();
  const ctx = { on, effect, logger: () => ({ info: vi.fn() }), approval: { request } };
  // The registration-only boundary double does not replace the real waterfall suites below.
  apply(ctx as unknown as Context);
  expect(on).toHaveBeenCalledTimes(1);
  expect(on).toHaveBeenCalledWith("tools/pre-execute", expect.any(Function));
  expect(request).not.toHaveBeenCalled();
});

test.each([
  { role: "worker", tool: "task_create", reason: "Role worker cannot call tool task_create." },
  {
    role: "worker",
    tool: "report_generate",
    reason: "Role worker cannot call tool report_generate.",
  },
  { role: "worker", tool: "subagent", reason: "Role worker cannot call tool subagent." },
  { role: "coordinator", tool: "shud_run", reason: "Role coordinator cannot call tool shud_run." },
  { role: "coordinator", tool: "read", reason: "Role coordinator cannot call tool read." },
  { role: "worker", tool: "read", reason: "Role worker cannot call tool read." },
])("$role calling $tool receives the canonical deny", async ({ role, tool, reason }) => {
  const h = await createPolicyHarness({ preset: role });
  try {
    const args = Object.freeze({ private: "secret-policy-input" });
    expect(await h.decide(tool, args)).toEqual({ kind: "deny", reason });
    expect(h.next).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
    expect(h.policyLogs()).toEqual([[`deny ${tool} role-tool-surface`]]);
    expect(args).toEqual({ private: "secret-policy-input" });
  } finally {
    await h.dispose();
  }
});

test.each(["report_submit", "report_decide"])("worker deny precedes %s approval", async (tool) => {
  const h = await createPolicyHarness({ preset: "worker" });
  try {
    expect(h.session.header.agentPreset).toBe("coordinator");
    expect(await h.decide(tool, { report_id: REPORT_ID })).toEqual({
      kind: "deny",
      reason: `Role worker cannot call tool ${tool}.`,
    });
    expect(h.next).not.toHaveBeenCalled();
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

test.each([
  { role: "worker", tool: "shud_run" },
  { role: "worker", tool: "shud_collect" },
  { role: "worker", tool: "job_output" },
  { role: "coordinator", tool: "task_create" },
  { role: "coordinator", tool: "subagent" },
  { role: "coordinator", tool: "shud_collect" },
])("$role delegates $tool exactly once without terminating allow", async ({ role, tool }) => {
  const h = await createPolicyHarness({ preset: role });
  try {
    const downstream: PreToolDecision = { kind: "deny", reason: "later guard owns this result" };
    h.next.mockResolvedValue(downstream);
    expect(await h.decide(tool)).toBe(downstream);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.policyLogs()).toEqual([]);
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

test("delegation propagates a downstream rejection without reclassifying or retrying", async () => {
  const h = await createPolicyHarness({ preset: "worker" });
  try {
    const error = new Error("downstream failure");
    h.next.mockRejectedValue(error);
    await expect(h.decide("shud_collect")).rejects.toBe(error);
    expect(h.next).toHaveBeenCalledTimes(1);
    expect(h.policyLogs()).toEqual([]);
  } finally {
    await h.dispose();
  }
});

test.each([
  undefined,
  null,
  "",
  "unknown",
  "standard",
  "repo_explorer",
  "coder",
  "reviewer",
  " custom ",
])(
  "unmapped current identity %j delegates ordinary tools but still asks for reports",
  async (preset) => {
    const h = await createPolicyHarness({ preset });
    try {
      expect(await h.decide("bash", { command: "true" })).toEqual({ kind: "cancel" });
      expectAsk(await h.decide("report_submit", { report_id: REPORT_ID }));
      expect(h.next).toHaveBeenCalledTimes(1);
      expect(h.request).not.toHaveBeenCalled();
    } finally {
      await h.dispose();
    }
  },
);

test("missing current projection service never grants the frozen header role", async () => {
  const h = await createPolicyHarness({ projections: false });
  try {
    expect(await h.decide("shud_run")).toEqual({ kind: "cancel" });
    expectAsk(await h.decide("report_submit"));
    expect(h.next).toHaveBeenCalledTimes(1);
  } finally {
    await h.dispose();
  }
});

test("agent-less calls remain unknown rather than inheriting a caller role", async () => {
  const h = await createPolicyHarness({ preset: "coordinator" });
  try {
    expect(await h.decide("shud_run", {}, null)).toEqual({ kind: "cancel" });
    expectAsk(await h.decide("report_decide", {}, null));
    expect(h.request).not.toHaveBeenCalled();
  } finally {
    await h.dispose();
  }
});

test.each([
  {
    header: "coordinator",
    first: "worker",
    second: "coordinator",
    firstKind: "deny",
    secondKind: "cancel",
  },
  {
    header: "worker",
    first: "coordinator",
    second: "worker",
    firstKind: "cancel",
    secondKind: "deny",
  },
])(
  "same-session switches override frozen $header identity in both directions",
  async ({ header, first, second, firstKind, secondKind }) => {
    const h = await createPolicyHarness({ preset: first });
    try {
      h.session.header.agentPreset = header;
      expect((await h.decide("task_create")).kind).toBe(firstKind);
      h.current.preset = second;
      expect((await h.decide("task_create")).kind).toBe(secondKind);
      expect(h.session.header.agentPreset).toBe(header);
      expect(h.stateOf).toHaveBeenCalledTimes(2);
      expect(h.stateOf).toHaveBeenNthCalledWith(1, h.session, "agentPreset");
      expect(h.stateOf).toHaveBeenNthCalledWith(2, h.session, "agentPreset");
    } finally {
      await h.dispose();
    }
  },
);

test.each([undefined, null, [], 7, false, "odd-input"])(
  "ordinary arguments %j pass through untouched",
  async (input) => {
    const h = await createPolicyHarness({ preset: "worker" });
    try {
      expect(await h.decide("shud_collect", input)).toEqual({ kind: "cancel" });
      expect(h.next).toHaveBeenCalledTimes(1);
    } finally {
      await h.dispose();
    }
  },
);
