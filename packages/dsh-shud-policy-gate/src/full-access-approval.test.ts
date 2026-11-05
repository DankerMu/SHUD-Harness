import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Session } from "@deepseek-ai/dsh-session";
import { readCallerPresetId } from "@shud-harness/dsh-shud-core";
import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import * as policyGate from "./index.ts";
import {
  CHANGE_ID,
  REPORT_ID,
  snapshotFile,
  writeChangeSentinel,
  writeProposedChange,
} from "./test-harness.ts";
import { modes, reportTools, mountApprovalHarness } from "./approval/test-harness.ts";

beforeEach(() => vi.stubEnv("DSH_PERMISSION_MODE", "workspace-write"));
afterEach(() => vi.unstubAllEnvs());

function decisions(session: Session) {
  return session.snapshotEvents().filter((event) => event.type === "approval/decided");
}

for (const tool of reportTools) {
  test(`full filesystem access dispatches ${tool} and waits for PI before allowing one execution`, async () => {
    const h = await mountApprovalHarness();
    try {
      const held = h.hold();
      h.ctx.permissionPresets.set(h.session, "danger-full-access");
      h.session.append("turn/start", { turn: 1 });
      const operation = h.call(tool);
      const first = await Promise.race([held.dispatched, operation.done, h.watchdog]);
      expect(h.ctx.permissionPresets.current(h.session)).toBe("danger-full-access");
      expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
        sandbox: "danger-full-access",
        approval: "ask",
      });
      expect(first).toMatchObject({ kind: "dispatched" });
      expect(held.requests).toHaveLength(1);
      expect(held.requests[0]).toMatchObject({
        toolName: tool,
        reason: `${policyGate.REPORT_APPROVAL_REASON_PREFIX} ${REPORT_ID}`,
      });
      expect(held.requests[0].agent).toBe(operation.agent);
      expect(operation.isSettled()).toBe(false);
      expect(h.executions).toEqual([]);
      expect(decisions(h.session)).toEqual([]);
      held.answer.resolve("allowed-once");
      expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
        kind: "settled",
        result: { isError: false, value: "executed" },
      });
      expect(h.executions).toEqual([tool]);
      expect(decisions(h.session)).toMatchObject([{ data: { outcome: "allowed-once" } }]);
    } finally {
      await h.dispose();
    }
  });

  test.each(["rejected", "cancelled", "unavailable"] as const)(
    `${tool} under full access fails closed when approval is %s`,
    async (outcome) => {
      const h = await mountApprovalHarness();
      try {
        // No listener is installed for unavailable: exercise real no-answerer fallthrough.
        const held = outcome === "unavailable" ? undefined : h.hold();
        h.ctx.permissionPresets.set(h.session, "danger-full-access");
        h.session.append("turn/start", { turn: 1 });
        const operation = h.call(tool);
        if (held) {
          expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
            kind: "dispatched",
          });
          held.answer.resolve(outcome);
        }
        expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
          kind: "settled",
          result: { isError: true },
        });
        expect(h.executions).toEqual([]);
        expect(decisions(h.session)).toMatchObject([{ data: { outcome } }]);
      } finally {
        await h.dispose();
      }
    },
  );
}

test("all three filesystem modes retain ask and repeated selection appends nothing", async () => {
  const h = await mountApprovalHarness();
  try {
    expect(h.ctx.permissionPresets.names).toEqual(modes);
    for (const mode of modes) {
      h.ctx.permissionPresets.set(h.session, mode);
      expect(h.ctx.permissionPresets.current(h.session)).toBe(mode);
      expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
        sandbox: mode,
        approval: "ask",
      });
      const before = h.session.snapshotEvents();
      h.ctx.permissionPresets.set(h.session, mode);
      expect(h.session.snapshotEvents()).toEqual(before);
    }
  } finally {
    await h.dispose();
  }
});

test("environment-selected full access starts with ask and reaches approval without reselection", async () => {
  vi.stubEnv("DSH_PERMISSION_MODE", "danger-full-access");
  const h = await mountApprovalHarness();
  try {
    expect(h.ctx.approval.config.policy).toBe("ask");
    expect(h.ctx.permissionPresets.current(h.session)).toBe("danger-full-access");
    expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
      sandbox: "danger-full-access",
      approval: "ask",
    });
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("report_submit");
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(operation.isSettled()).toBe(false);
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: false },
    });
    expect(h.executions).toEqual(["report_submit"]);
  } finally {
    await h.dispose();
  }
});

test("restored full-access never history remains intact until explicit preset reselection", async () => {
  const h = await mountApprovalHarness();
  try {
    // Durable old-session fixture, constructed through real Session append and replay APIs.
    h.session.append("permission/preset", { preset: "danger-full-access" });
    h.session.append("sandbox/mode", { mode: "danger-full-access" });
    h.session.append("approval/policy", { policy: "never" });
    const history = structuredClone(h.session.snapshotEvents());
    const restored = h.createSession(history);
    expect(restored.snapshotEvents().slice(0, history.length)).toEqual(history);
    // Restoration may append lifecycle bookkeeping, but must not rewrite permission intent.
    expect(
      restored
        .snapshotEvents()
        .slice(history.length)
        .filter(
          ({ type }) =>
            type === "permission/preset" || type === "sandbox/mode" || type === "approval/policy",
        ),
    ).toEqual([]);
    expect(h.ctx.approval.overrideOf(restored)).toBe("never");
    expect(h.ctx.permissionPresets.current(restored)).toBe("custom");
    const held = h.hold();
    restored.append("turn/start", { turn: 1 });
    const rejected = h.call("report_submit", restored);
    const denial = await Promise.race([rejected.done, h.watchdog]);
    expect(denial).toMatchObject({
      kind: "settled",
      result: { isError: true },
    });
    if (denial.kind !== "settled" || !denial.result.isError) {
      throw new Error("Legacy never policy did not reject the report tool");
    }
    expect(denial.result.error.message).toContain("rejected");
    expect(held.requests).toEqual([]);
    expect(h.executions).toEqual([]);
    expect(decisions(restored)).toMatchObject([{ data: { outcome: "rejected" } }]);
    const beforeReselection = structuredClone(restored.snapshotEvents());
    h.ctx.permissionPresets.set(restored, "danger-full-access");
    expect(restored.snapshotEvents().slice(0, beforeReselection.length)).toEqual(beforeReselection);
    expect(
      restored
        .snapshotEvents()
        .slice(beforeReselection.length)
        .map(({ type, data }) => ({
          type,
          data,
        })),
    ).toEqual([
      { type: "permission/preset", data: { preset: "danger-full-access" } },
      { type: "approval/policy", data: { policy: "ask" } },
    ]);
    expect(h.ctx.permissionPresets.current(restored)).toBe("danger-full-access");
    expect(h.ctx.sessionProjections.stateOf(restored, "permissions")).toMatchObject({
      sandbox: "danger-full-access",
      approval: "ask",
    });
    const afterReselection = restored.snapshotEvents();
    h.ctx.permissionPresets.set(restored, "danger-full-access");
    expect(restored.snapshotEvents()).toEqual(afterReselection);
    const operation = h.call("report_submit", restored);
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(operation.isSettled()).toBe(false);
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: false },
    });
    expect(h.executions).toEqual(["report_submit"]);
    expect(restored.snapshotEvents().slice(0, history.length)).toEqual(history);
  } finally {
    await h.dispose();
  }
});

test("held high-risk change_submit approves only after allowed-once with the execution callId", async () => {
  const h = await mountApprovalHarness(true);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const sibling = await writeChangeSentinel(h.cwd, fixture.change);
    const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath, ...sibling.paths];
    const before = await Promise.all(paths.map(snapshotFile));
    const held = h.hold();
    h.ctx.permissionPresets.set(h.session, "danger-full-access");
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit");
    expect(readCallerPresetId(operation.agent)).toBe("coder");
    expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
      sandbox: "danger-full-access",
      approval: "ask",
    });

    // Missing registration must fail here with UNKNOWN_TOOL, not by waiting for a timeout.
    const first = await Promise.race([held.dispatched, operation.done, h.watchdog]);
    expect(first).toMatchObject({ kind: "dispatched" });
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]).toMatchObject({
      toolName: "change_submit",
      callId: operation.callId,
      agent: operation.agent,
    });
    expect(operation.isSettled()).toBe(false);
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
    expect(decisions(h.session)).toEqual([]);
    const asked = h.session.snapshotEvents().filter((event) => event.type === "approval/asked");
    expect(asked).toHaveLength(1);
    expect(asked[0]?.data).toMatchObject({
      toolName: "change_submit",
      callId: operation.callId,
    });
    expect(asked[0]?.data.id).not.toBe(operation.callId);

    const approvalStarted = Date.now();
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: {
        isError: false,
        value: {
          change_id: CHANGE_ID,
          status: "approved",
          approval_ref: operation.callId,
        },
      },
    });
    const approved = readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true });
    expect(approved).toEqual({
      ...fixture.change,
      status: "approved",
      approval_ref: "full-access-change_submit-1",
      approved_at: approved.approved_at,
      updated_at: approved.updated_at,
    });
    expect(approved.approval_ref).toBe(operation.callId);
    expect(approved.approval_ref).not.toBe(asked[0]?.data.id);
    expect(approved.approved_at).toBe(approved.updated_at);
    expect(approved.approved_at).toBeTypeOf("string");
    expect(Date.parse(approved.updated_at)).toBeGreaterThanOrEqual(approvalStarted);
    expect(Date.parse(approved.updated_at)).toBeLessThanOrEqual(Date.now());
    expect(approved.updated_at).not.toBe(fixture.change.updated_at);
    expect(await snapshotFile(fixture.taskPath)).toEqual(before[1]);
    expect(await snapshotFile(fixture.patchPath)).toEqual(before[2]);
    expect(await Promise.all(sibling.paths.map(snapshotFile))).toEqual(sibling.before);
    expect(decisions(h.session)).toMatchObject([
      { data: { id: asked[0]?.data.id, outcome: "allowed-once" } },
    ]);
  } finally {
    await h.dispose();
  }
});

test.each(["rejected", "cancelled", "unavailable"] as const)(
  "high-risk change_submit approval %s never executes or changes workspace evidence",
  async (outcome) => {
    const h = await mountApprovalHarness(true);
    try {
      const fixture = await writeProposedChange(h.cwd);
      const sibling = await writeChangeSentinel(h.cwd, fixture.change);
      const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath, ...sibling.paths];
      const before = await Promise.all(paths.map(snapshotFile));
      // No answerer exercises the real ApprovalService unavailable outcome.
      const held = outcome === "unavailable" ? undefined : h.hold();
      h.ctx.permissionPresets.set(h.session, "danger-full-access");
      h.session.append("turn/start", { turn: 1 });
      const operation = h.call("change_submit");
      if (held) {
        expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
          kind: "dispatched",
        });
        expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
        expect(h.executions).toEqual([]);
        held.answer.resolve(outcome);
      }
      expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
        kind: "settled",
        result: { isError: true },
      });
      expect(h.executions).toEqual([]);
      expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
      const asked = h.session.snapshotEvents().filter((event) => event.type === "approval/asked");
      expect(asked).toHaveLength(1);
      expect(asked[0]?.data).toMatchObject({
        toolName: "change_submit",
        callId: operation.callId,
      });
      expect(decisions(h.session)).toMatchObject([{ data: { id: asked[0]?.data.id, outcome } }]);
    } finally {
      await h.dispose();
    }
  },
);

test("change_submit rechecks patch bytes changed while high-risk approval is held", async () => {
  const h = await mountApprovalHarness(true);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const sibling = await writeChangeSentinel(h.cwd, fixture.change);
    const changeBefore = await snapshotFile(fixture.changePath);
    const taskBefore = await snapshotFile(fixture.taskPath);
    const patchBefore = await snapshotFile(fixture.patchPath);
    const held = h.hold();
    h.ctx.permissionPresets.set(h.session, "danger-full-access");
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit");
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(h.executions).toEqual([]);
    expect(await snapshotFile(fixture.changePath)).toEqual(changeBefore);
    expect(await snapshotFile(fixture.taskPath)).toEqual(taskBefore);
    expect(await snapshotFile(fixture.patchPath)).toEqual(patchBefore);
    expect(await Promise.all(sibling.paths.map(snapshotFile))).toEqual(sibling.before);
    await writeFile(fixture.patchPath, "abd");
    const mutatedPatch = await snapshotFile(fixture.patchPath);
    held.answer.resolve("allowed-once");
    const result = await Promise.race([operation.done, h.watchdog]);
    expect(result).toMatchObject({ kind: "settled", result: { isError: true } });
    if (result.kind !== "settled" || !result.result.isError) {
      throw new Error("Expected the actual change_submit handler to reject changed patch bytes");
    }
    expect(result.result.error.message).toMatch(/patch sha256 mismatch/iu);
    expect(result.result.error.message).toContain("change_create");
    expect(h.executions).toEqual(["change_submit"]);
    expect(await snapshotFile(fixture.changePath)).toEqual(changeBefore);
    expect(await snapshotFile(fixture.taskPath)).toEqual(taskBefore);
    expect(await snapshotFile(fixture.patchPath)).toEqual(mutatedPatch);
    expect(await Promise.all(sibling.paths.map(snapshotFile))).toEqual(sibling.before);
    expect(readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true })).toEqual(
      fixture.change,
    );
    expect(decisions(h.session)).toMatchObject([{ data: { outcome: "allowed-once" } }]);
  } finally {
    await h.dispose();
  }
});

test("matching low-risk change_submit approves directly with its execution callId and no card", async () => {
  const h = await mountApprovalHarness(true);
  try {
    const fixture = await writeProposedChange(h.cwd, {
      files_changed: ["docs/build.md"],
      semantic_level: "pure_engineering",
      semantic_floor: "pure_engineering",
      floor_categories: ["pure_engineering"],
      risk: "low",
    });
    const taskBefore = await snapshotFile(fixture.taskPath);
    const patchBefore = await snapshotFile(fixture.patchPath);
    const held = h.hold();
    h.ctx.permissionPresets.set(h.session, "danger-full-access");
    h.session.append("turn/start", { turn: 1 });
    const approvalStarted = Date.now();
    const operation = h.call("change_submit");
    expect(await Promise.race([operation.done, held.dispatched, h.watchdog])).toMatchObject({
      kind: "settled",
      result: {
        isError: false,
        value: {
          change_id: CHANGE_ID,
          status: "approved",
          approval_ref: "full-access-change_submit-1",
        },
      },
    });
    expect(h.executions).toEqual(["change_submit"]);
    expect(held.requests).toEqual([]);
    expect(h.session.snapshotEvents().filter((event) => event.type === "approval/asked")).toEqual(
      [],
    );
    expect(decisions(h.session)).toEqual([]);
    const approved = readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true });
    expect(approved).toEqual({
      ...fixture.change,
      status: "approved",
      approval_ref: operation.callId,
      approved_at: approved.approved_at,
      updated_at: approved.updated_at,
    });
    expect(approved.approved_at).toBe(approved.updated_at);
    expect(approved.approved_at).toBeTypeOf("string");
    expect(Date.parse(approved.updated_at)).toBeGreaterThanOrEqual(approvalStarted);
    expect(Date.parse(approved.updated_at)).toBeLessThanOrEqual(Date.now());
    expect(await snapshotFile(fixture.taskPath)).toEqual(taskBefore);
    expect(await snapshotFile(fixture.patchPath)).toEqual(patchBefore);
  } finally {
    await h.dispose();
  }
});

test("raw exact change JSON denies change_submit before policy approval and any evidence write", async () => {
  const h = await mountApprovalHarness(true, (cwd) => [join(cwd, "changes", `${CHANGE_ID}.json`)]);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath];
    const before = await Promise.all(paths.map(snapshotFile));
    const held = h.hold();
    h.ctx.permissionPresets.set(h.session, "danger-full-access");
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit");
    // A missing raw route reaches actual policy/approval immediately, not a watchdog timeout.
    const result = await Promise.race([operation.done, held.dispatched, h.watchdog]);
    expect(result).toMatchObject({ kind: "settled", result: { isError: true } });
    if (result.kind !== "settled" || !result.result.isError) {
      throw new Error("Expected raw-immutable denial before approval dispatch");
    }
    expect(result.result.error.message).toMatch(/immutable/iu);
    expect(held.requests).toEqual([]);
    expect(h.executions).toEqual([]);
    expect(h.session.snapshotEvents().filter((event) => event.type === "approval/asked")).toEqual(
      [],
    );
    expect(decisions(h.session)).toEqual([]);
    expect(h.logs.filter((row) => row.name === "shud-policy-gate")).toEqual([]);
    expect(
      h.logs.filter((row) => row.name === "shud-raw-guard").map((row) => row.args),
    ).toContainEqual(["deny change_submit raw-immutable"]);
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
  } finally {
    await h.dispose();
  }
});

test.each([
  "approved-change",
  "blocked-task",
  "missing-task",
  "missing-patch",
  "fresh-description",
] as const)("change_submit uses fresh %s evidence after host approval", async (mutation) => {
  const h = await mountApprovalHarness(true);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit");
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    if (mutation === "approved-change" || mutation === "fresh-description") {
      await writeFile(
        fixture.changePath,
        JSON.stringify({
          ...fixture.change,
          ...(mutation === "approved-change"
            ? {
                status: "approved",
                approval_ref: "other-approval",
                approved_at: "2026-11-03T00:00:00Z",
              }
            : { description: "Fresh externally updated description" }),
        }),
      );
    } else if (mutation === "blocked-task") {
      const card = readWorkspaceRecord(h.cwd, "task", fixture.change.task_id, { readonly: true });
      await writeFile(fixture.taskPath, JSON.stringify({ ...card, status: "blocked" }));
    } else await rm(mutation === "missing-task" ? fixture.taskPath : fixture.patchPath);
    const before = await snapshotFile(fixture.changePath);
    const taskBefore =
      mutation === "missing-task" ? undefined : await snapshotFile(fixture.taskPath);
    const patchBefore =
      mutation === "missing-patch" ? undefined : await snapshotFile(fixture.patchPath);
    held.answer.resolve("allowed-once");
    const result = await Promise.race([operation.done, h.watchdog]);
    expect(result).toMatchObject({
      kind: "settled",
      result: { isError: mutation !== "fresh-description" },
    });
    expect(h.executions).toEqual(["change_submit"]);
    if (mutation === "fresh-description") {
      expect(readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true })).toMatchObject({
        description: "Fresh externally updated description",
        status: "approved",
        approval_ref: operation.callId,
      });
    } else expect(await snapshotFile(fixture.changePath)).toEqual(before);
    if (taskBefore) expect(await snapshotFile(fixture.taskPath)).toEqual(taskBefore);
    else await expect(readFile(fixture.taskPath)).rejects.toMatchObject({ code: "ENOENT" });
    if (patchBefore) expect(await snapshotFile(fixture.patchPath)).toEqual(patchBefore);
    else await expect(readFile(fixture.patchPath)).rejects.toMatchObject({ code: "ENOENT" });
  } finally {
    await h.dispose();
  }
});

test("concurrent accepted change_submit calls publish exactly one durable approval", async () => {
  const h = await mountApprovalHarness(true);
  try {
    const fixture = await writeProposedChange(h.cwd);
    const taskBefore = await snapshotFile(fixture.taskPath);
    const patchBefore = await snapshotFile(fixture.patchPath);
    const held = h.hold(2);
    h.session.append("turn/start", { turn: 1 });
    const first = h.call("change_submit");
    const second = h.call("change_submit");
    expect(await Promise.race([held.dispatched, first.done, second.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(held.requests).toHaveLength(2);
    expect(h.executions).toEqual([]);
    const approvalStarted = Date.now();
    held.answer.resolve("allowed-once");
    const results = await Promise.race([Promise.all([first.done, second.done]), h.watchdog]);
    if (!Array.isArray(results)) throw new Error("Concurrent approval did not settle");
    const successes = results.filter((entry) => entry.kind === "settled" && !entry.result.isError);
    const failures = results.filter((entry) => entry.kind === "settled" && entry.result.isError);
    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    const winner = results[0]?.kind === "settled" && !results[0].result.isError ? first : second;
    const approved = readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true });
    expect(approved).toEqual({
      ...fixture.change,
      status: "approved",
      approval_ref: winner.callId,
      approved_at: approved.approved_at,
      updated_at: approved.updated_at,
    });
    expect(approved.approved_at).toBeTypeOf("string");
    expect(approved.approved_at).toBe(approved.updated_at);
    expect(Date.parse(approved.updated_at)).toBeGreaterThanOrEqual(approvalStarted);
    expect(Date.parse(approved.updated_at)).toBeLessThanOrEqual(Date.now());
    expect(h.executions).toEqual(["change_submit", "change_submit"]);
    expect(decisions(h.session)).toHaveLength(2);
    for (const event of decisions(h.session)) expect(event.data.outcome).toBe("allowed-once");
    expect(await snapshotFile(fixture.taskPath)).toEqual(taskBefore);
    expect(await snapshotFile(fixture.patchPath)).toEqual(patchBefore);
  } finally {
    await h.dispose();
  }
});

test.each([false, true])(
  "already approved change low=%s preserves original approval and policy ownership",
  async (low) => {
    const h = await mountApprovalHarness(true);
    try {
      const fixture = await writeProposedChange(h.cwd, {
        semantic_level: low ? "pure_engineering" : "numerical_implementation",
        semantic_floor: low ? "pure_engineering" : "numerical_implementation",
        floor_categories: [low ? "pure_engineering" : "numerical_implementation"],
        risk: low ? "low" : "high",
        status: "approved",
        approval_ref: "original-call",
        approved_at: "2026-11-02T09:01:00Z",
      });
      const before = await snapshotFile(fixture.changePath);
      const held = h.hold();
      h.session.append("turn/start", { turn: 1 });
      const operation = h.call("change_submit");
      if (!low) {
        expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
          kind: "dispatched",
        });
        expect(h.executions).toEqual([]);
        held.answer.resolve("allowed-once");
      }
      const settled = await Promise.race([
        operation.done,
        h.watchdog,
        ...(low ? [held.dispatched] : []),
      ]);
      expect(settled).toMatchObject({ kind: "settled", result: { isError: true } });
      expect(h.executions).toEqual(["change_submit"]);
      expect(held.requests).toHaveLength(low ? 0 : 1);
      expect(await snapshotFile(fixture.changePath)).toEqual(before);
    } finally {
      await h.dispose();
    }
  },
);

test.each(["patches", "tasks", "repos/SHUD", "changes/CHG-20261102T090000-ffff.json"])(
  "raw protected %s does not block approval of the distinct exact change JSON",
  async (raw) => {
    const h = await mountApprovalHarness(true, (cwd) => [join(cwd, raw)]);
    try {
      const fixture = await writeProposedChange(h.cwd);
      const before = await Promise.all([fixture.taskPath, fixture.patchPath].map(snapshotFile));
      const held = h.hold();
      h.session.append("turn/start", { turn: 1 });
      const operation = h.call("change_submit");
      expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
        kind: "dispatched",
      });
      held.answer.resolve("allowed-once");
      expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
        kind: "settled",
        result: { isError: false },
      });
      expect(readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true })).toMatchObject({
        status: "approved",
        approval_ref: operation.callId,
      });
      expect(await Promise.all([fixture.taskPath, fixture.patchPath].map(snapshotFile))).toEqual(
        before,
      );
      expect(h.logs.filter((row) => row.name === "shud-raw-guard")).toEqual([]);
    } finally {
      await h.dispose();
    }
  },
);

test("high-risk change_submit without ApprovalService fails closed before actual handler dispatch", async () => {
  const h = await mountApprovalHarness(true, undefined, false);
  try {
    expect(h.ctx.get("approval")).toBeUndefined();
    // The real permission plugin requires approval injection and is therefore inactive.
    expect(h.ctx.get("permissionPresets")).toBeUndefined();
    const fixture = await writeProposedChange(h.cwd);
    const sibling = await writeChangeSentinel(h.cwd, fixture.change);
    const paths = [fixture.changePath, fixture.taskPath, fixture.patchPath, ...sibling.paths];
    const before = await Promise.all(paths.map(snapshotFile));
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit");
    expect(readCallerPresetId(operation.agent)).toBe("coder");
    expect(h.ctx.tools.schemas(operation.agent).map((tool) => tool.name)).toContain(
      "change_submit",
    );
    expect(await Promise.race([operation.done, held.dispatched, h.watchdog])).toMatchObject({
      kind: "settled",
      result: {
        isError: true,
        error: { message: `${policyGate.CHANGE_APPROVAL_REASON_PREFIX} ${CHANGE_ID}` },
      },
    });
    expect(h.executions).toEqual([]);
    expect(held.requests).toEqual([]);
    // No service means no approval/request or approval audit pair, not an unavailable decision.
    expect(h.session.snapshotEvents().filter((event) => event.type === "approval/asked")).toEqual(
      [],
    );
    expect(decisions(h.session)).toEqual([]);
    expect(h.logs.filter((row) => row.name === "shud-policy-gate").map((row) => row.args)).toEqual([
      [`ask change_submit change-approval ${CHANGE_ID} numerical_implementation`],
    ]);
    expect(readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true })).toEqual(
      fixture.change,
    );
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
  } finally {
    await h.dispose();
  }
});
