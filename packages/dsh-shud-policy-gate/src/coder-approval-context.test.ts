import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountCoderHarness, policyEvents } from "./approval/coder/test-harness.ts";
import type { CoderOptions } from "./approval/coder/test-harness.ts";

// Independent host contribution: non-coder and inactive routing preserve this text exactly.
const HOST_DELEGATION =
  "Host delegation fixture: permission scope is fixed; operations requiring approval are rejected automatically. Return the limitation to the parent.";
const SANDBOX = "Captured sandbox: read-only. This sandbox cannot be widened inside the child.";
const UNRELATED = "Unrelated runtime fact: retain this exact text and interpolation setting.";
const SHUD_CONTEXT = "shud-coder-approval:delegation";
const fixtures: Array<{ dispose(): Promise<void> }> = [];
beforeEach(() => vi.stubEnv("DSH_PERMISSION_MODE", "workspace-write"));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of fixtures.splice(0)) await h.dispose();
  vi.unstubAllEnvs();
});
async function fixture(options: CoderOptions = {}) {
  const h = await mountCoderHarness(options);
  fixtures.push(h);
  h.child.ctx.systemPrompt.context({
    name: "subagent:delegation",
    order: 1,
    text: HOST_DELEGATION,
  });
  h.child.ctx.systemPrompt.context({
    name: "sandbox:fixture",
    order: 2,
    text: SANDBOX,
    required: true,
  });
  h.child.ctx.systemPrompt.context({
    name: "unrelated:fixture",
    order: 3,
    text: UNRELATED,
    interpolate: false,
  });
  return h;
}

test.each(["ask", "never"] as const)(
  "real admission refresh follows %s to its opposite without stale delegation text",
  async (initial) => {
    const h = await fixture();
    await h.announce();
    if (initial === "never") h.ctx.approval.setPolicy(h.child, "never");
    const context = { agent: h.child, scope: h.child };
    const assembled = await h.child.ctx.systemPrompt.assemble(context);
    expect(assembled.contexts.filter((entry) => entry.name === SHUD_CONTEXT)).toHaveLength(1);
    expect(assembled.contexts.some((entry) => entry.name === "subagent:delegation")).toBe(false);
    const initialText = assembled.contexts.find((entry) => entry.name === SHUD_CONTEXT)?.text;
    expect(initialText).toContain("allowed-once");
    expect(initialText).toContain("When the host approval policy permits asking");
    expect(initialText).not.toContain("rejected automatically");
    expect(initialText).not.toMatch(/\bpolicy(?:\s+is|\s*:)\s*(?:ask|never)\b/i);
    expect(assembled.contexts.find((value) => value.name === "approval:policy")?.text).toContain(
      initial === "ask" ? "Approval policy: ask" : "Approval prompts are disabled",
    );
    const next = initial === "ask" ? "never" : "ask";
    h.ctx.approval.setPolicy(h.child, next);
    const refreshed = h.child.ctx.systemPrompt.refreshContext(assembled, context);
    const entry = refreshed.contexts.find((value) => value.name === SHUD_CONTEXT);
    expect(refreshed.contexts.filter((value) => value.name === SHUD_CONTEXT)).toHaveLength(1);
    expect(refreshed.contexts.some((value) => value.name === "subagent:delegation")).toBe(false);
    expect(entry?.text).toBe(initialText);
    expect(entry?.text).toContain("available answerer");
    expect(entry?.text).toContain("only allowed-once");
    expect(entry?.text).toContain("sandbox");
    expect(entry?.text).toContain("cannot be widened");
    expect(entry?.text).not.toContain("rejected automatically");
    expect(refreshed.contexts.find((value) => value.name === "approval:policy")?.text).toContain(
      next === "ask" ? "Approval policy: ask" : "Approval prompts are disabled",
    );
    expect(refreshed.contexts.find((value) => value.name === "sandbox:fixture")?.text).toBe(
      SANDBOX,
    );
    expect(refreshed.contexts.find((value) => value.name === "unrelated:fixture")).toEqual({
      name: "unrelated:fixture",
      text: UNRELATED,
      interpolate: false,
    });
    expect(refreshed.sections).toEqual(assembled.sections);
    expect(refreshed.tools).toEqual(assembled.tools);
    expect(refreshed.variables).toEqual(assembled.variables);
    const repeated = await h.child.ctx.systemPrompt.assemble(context);
    expect(repeated.contexts.filter((value) => value.name === SHUD_CONTEXT)).toHaveLength(1);
    expect(h.child.ctx.systemPrompt.refreshContext(repeated, context).contexts).toEqual(
      refreshed.contexts,
    );
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each(["worker", "reviewer", "custom-role"])(
  "%s keeps exact host and unrelated context",
  async (role) => {
    const h = await fixture({ childMeta: { agentPreset: role } });
    await h.announce();
    const context = { agent: h.child, scope: h.child };
    const assembled = await h.child.ctx.systemPrompt.assemble(context);
    const refreshed = h.child.ctx.systemPrompt.refreshContext(assembled, context);
    expect(refreshed.contexts).toEqual(assembled.contexts);
    expect(refreshed.contexts.some((entry) => entry.name === SHUD_CONTEXT)).toBe(false);
    expect(refreshed.contexts.find((entry) => entry.name === "subagent:delegation")?.text).toBe(
      HOST_DELEGATION,
    );
    expect(refreshed.contexts.find((entry) => entry.name === "sandbox:fixture")?.text).toBe(
      SANDBOX,
    );
    expect(refreshed.contexts.find((entry) => entry.name === "unrelated:fixture")?.text).toBe(
      UNRELATED,
    );
    expect(h.notices).toEqual([]);
  },
);

test("role changed after assembly retains neutral scope without a stale role claim at admission", async () => {
  const h = await fixture();
  await h.announce();
  const context = { agent: h.child, scope: h.child };
  const assembled = await h.child.ctx.systemPrompt.assemble(context);
  h.session.append("agent-preset/selected", { agentPreset: "worker" });
  const refreshed = h.child.ctx.systemPrompt.refreshContext(assembled, context);
  const text = refreshed.contexts.find((entry) => entry.name === SHUD_CONTEXT)?.text;
  expect(text).toBe(assembled.contexts.find((entry) => entry.name === SHUD_CONTEXT)?.text);
  expect(text).toContain("only allowed-once");
  expect(text).not.toMatch(/\byou are (?:a )?delegated coder\b|\bcurrent role\b/i);
  expect(refreshed.contexts.find((entry) => entry.name === "approval:policy")?.text).toContain(
    "Approval policy: ask",
  );
  expect(refreshed.contexts.find((entry) => entry.name === "sandbox:fixture")?.text).toBe(SANDBOX);
});

test("disposal removes new assembly routing while reload restores neutral scope without another policy write", async () => {
  const h = await fixture();
  await h.announce();
  const context = { agent: h.child, scope: h.child };
  const before = h.session.snapshotEvents();
  const notices = [...h.notices];
  await h.unmount();
  const unmounted = await h.child.ctx.systemPrompt.assemble(context);
  expect(unmounted.contexts.some((entry) => entry.name === SHUD_CONTEXT)).toBe(false);
  expect(unmounted.contexts.find((entry) => entry.name === "subagent:delegation")?.text).toBe(
    HOST_DELEGATION,
  );
  await h.remount();
  const remounted = await h.child.ctx.systemPrompt.assemble(context);
  const refreshed = h.child.ctx.systemPrompt.refreshContext(remounted, context);
  expect(refreshed.contexts.find((entry) => entry.name === SHUD_CONTEXT)?.text).toContain(
    "only allowed-once",
  );
  expect(refreshed.contexts.find((entry) => entry.name === "sandbox:fixture")?.text).toBe(SANDBOX);
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.notices).toEqual(notices);
});

test("disposing during held assembly cannot reintroduce the coder route at admission", async () => {
  const h = await fixture();
  await h.announce();
  const context = { agent: h.child, scope: h.child };
  let enter!: () => void;
  let release!: () => void;
  const entered = new Promise<void>((resolve) => {
    enter = resolve;
  });
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Registered after the plugin so its awaited next() is genuinely in flight.
  const stop = h.ctx.on("system-prompt/assemble", async (_assembly, _context, next) => {
    enter();
    await barrier;
    return next();
  });
  const assembly = h.child.ctx.systemPrompt.assemble(context);
  try {
    expect(
      await Promise.race([
        entered.then(() => ({ kind: "entered" })),
        assembly.then(() => ({ kind: "premature-assembly" })),
        h.watchdog,
      ]),
    ).toEqual({ kind: "entered" });
    expect(
      await Promise.race([h.unmount().then(() => ({ kind: "disposed" })), h.watchdog]),
    ).toEqual({ kind: "disposed" });
    h.ctx.approval.setPolicy(h.child, "never");
    const policyBeforeRefresh = h.session.snapshotEvents();
    release();
    const result = await Promise.race([
      assembly.then((accepted) => ({ kind: "assembled" as const, accepted })),
      h.watchdog,
    ]);
    expect(result.kind).toBe("assembled");
    if (result.kind !== "assembled") throw new Error("Held assembly did not settle");
    const refreshed = h.child.ctx.systemPrompt.refreshContext(result.accepted, context);
    expect(refreshed.contexts.some((entry) => entry.name === SHUD_CONTEXT)).toBe(false);
    expect(refreshed.contexts.find((entry) => entry.name === "subagent:delegation")?.text).toBe(
      HOST_DELEGATION,
    );
    expect(refreshed.contexts.find((entry) => entry.name === "sandbox:fixture")?.text).toBe(
      SANDBOX,
    );
    expect(refreshed.contexts.find((entry) => entry.name === "unrelated:fixture")).toEqual({
      name: "unrelated:fixture",
      text: UNRELATED,
      interpolate: false,
    });
    expect(refreshed.contexts.some((entry) => entry.text.includes("only allowed-once"))).toBe(
      false,
    );
    expect(h.ctx.approval.overrideOf(h.session)).toBe("never");
    expect(h.session.snapshotEvents()).toEqual(policyBeforeRefresh);
    expect(h.ctx.sessionProjections.stateOf(h.session, "shudCoderApproval")).toBeUndefined();
    expect(await h.snapshot()).toEqual(h.before);
  } finally {
    release();
    stop();
    // Drain the owned in-flight call even when an assertion fails before release.
    await Promise.race([
      assembly.then(
        () => undefined,
        () => undefined,
      ),
      h.watchdog,
    ]);
  }
});

test.each([
  { lifecycle: "dispose", initial: "ask", current: "never" },
  { lifecycle: "dispose", initial: "never", current: "ask" },
  { lifecycle: "dispose/reapply", initial: "ask", current: "never" },
  { lifecycle: "dispose/reapply", initial: "never", current: "ask" },
] as const)(
  "same accepted assembly across $lifecycle and $initial→$current retains neutral scope and live host policy",
  async ({ lifecycle, initial, current }) => {
    const h = await fixture();
    await h.announce();
    if (initial === "never") h.ctx.approval.setPolicy(h.child, "never");
    const context = { agent: h.child, scope: h.child };
    // Complete assembly once. The held consumer below retains this exact accepted object.
    const accepted = await h.child.ctx.systemPrompt.assemble(context);
    const acceptedContexts = structuredClone(accepted.contexts);
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const admission = (async () => {
      const retained = accepted;
      enter();
      await barrier;
      expect(retained).toBe(accepted);
      return h.child.ctx.systemPrompt.refreshContext(retained, context);
    })();
    try {
      expect(
        await Promise.race([
          entered.then(() => ({ kind: "held" })),
          admission.then(() => ({ kind: "premature-admission" })),
          h.watchdog,
        ]),
      ).toEqual({ kind: "held" });
      const beforeDisposal = h.session.snapshotEvents();
      const noticesBeforeDisposal = [...h.notices];
      await h.unmount();
      if (lifecycle === "dispose/reapply") await h.remount();
      expect(h.session.snapshotEvents()).toEqual(beforeDisposal);
      expect(h.notices).toEqual(noticesBeforeDisposal);
      h.ctx.approval.setPolicy(h.child, current);
      const policies = policyEvents(h.session);
      expect(policies.map((event) => event.data)).toEqual([
        { policy: "never", source: "delegation" },
        { policy: "ask" },
        ...(initial === "never" ? [{ policy: "never" }] : []),
        { policy: current },
      ]);
      const notices = [...h.notices];
      const beforeAdmission = h.session.snapshotEvents();
      release();
      const result = await Promise.race([
        admission.then((refreshed) => ({ kind: "admitted" as const, refreshed })),
        h.watchdog,
      ]);
      expect(result.kind).toBe("admitted");
      if (result.kind !== "admitted") throw new Error("Retained assembly admission did not settle");
      expect(h.session.snapshotEvents()).toEqual(beforeAdmission);
      expect(h.notices).toEqual(notices);
      expect(h.ctx.approval.overrideOf(h.session)).toBe(current);
      expect(accepted.contexts).toEqual(acceptedContexts);

      // Obtain genuine never-policy business evidence before any expected context RED assertion.
      if (current === "never") {
        const held = h.hold();
        h.session.append("turn/start", { turn: 1 });
        const operation = h.call("change_submit", h.session, h.child);
        expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toMatchObject({
          kind: "settled",
          result: { isError: true },
        });
        expect(held.requests).toEqual([]);
        const asked = h.session.snapshotEvents().find((event) => event.type === "approval/asked");
        expect(asked?.data).toMatchObject({
          toolName: "change_submit",
          callId: operation.callId,
        });
        expect(
          h.session.snapshotEvents().filter((event) => event.type === "approval/decided"),
        ).toMatchObject([{ data: { id: asked?.data.id, outcome: "rejected" } }]);
      }
      expect(h.executions).toEqual([]);
      expect(policyEvents(h.session)).toEqual(policies);
      expect(h.notices).toEqual(notices);
      expect(await h.snapshot()).toEqual(h.before);

      const { refreshed } = result;
      const hostPolicy = refreshed.contexts.filter((entry) => entry.name === "approval:policy");
      expect(hostPolicy).toHaveLength(1);
      expect(hostPolicy[0]?.text).toContain(
        current === "ask" ? "Approval policy: ask" : "Approval prompts are disabled",
      );
      expect(refreshed.contexts.find((entry) => entry.name === "sandbox:fixture")).toEqual(
        acceptedContexts.find((entry) => entry.name === "sandbox:fixture"),
      );
      expect(refreshed.contexts.find((entry) => entry.name === "unrelated:fixture")).toEqual({
        name: "unrelated:fixture",
        text: UNRELATED,
        interpolate: false,
      });
      expect(refreshed.sections).toEqual(accepted.sections);
      expect(refreshed.tools).toEqual(accepted.tools);
      expect(refreshed.variables).toEqual(accepted.variables);
      const delegation = refreshed.contexts.filter((entry) => entry.name === SHUD_CONTEXT);
      expect(delegation).toHaveLength(1);
      const text = delegation[0]?.text ?? "";
      expect(text.trim()).not.toBe("");
      expect(text).toContain("sandbox");
      expect(text).toContain("cannot be widened");
      expect(text).toContain("answerer");
      expect(text).toContain("allowed-once");
      expect(text).not.toMatch(/\bpolicy(?:\s+is|\s*:)\s*(?:ask|never)\b/i);
      expect(text).not.toMatch(/\byou are (?:a )?delegated coder\b|\bcurrent role\b/i);
      expect(text).not.toContain("rejected automatically");
      expect(refreshed.contexts.some((entry) => entry.name === "subagent:delegation")).toBe(false);
    } finally {
      release();
      await Promise.race([
        admission.then(
          () => undefined,
          () => undefined,
        ),
        h.watchdog,
      ]);
    }
  },
);
