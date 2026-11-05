import { readWorkspaceRecord } from "@shud-harness/dsh-shud-records";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { CHANGE_ID, snapshotFile } from "./test-harness.ts";
import { mountCoderHarness } from "./approval/coder/test-harness.ts";

beforeEach(() => vi.stubEnv("DSH_PERMISSION_MODE", "workspace-write"));
afterEach(() => vi.unstubAllEnvs());

test("fresh owned coder holds actual change_submit without writes until allowed-once", async () => {
  const h = await mountCoderHarness();
  try {
    const { session, child, notices, parentSession, paths, before } = h;
    await h.announce();
    expect(h.ctx.approval.overrideOf(session)).toBe("ask");
    expect(
      session.snapshotEvents().filter((event) => event.type === "approval/policy"),
    ).toMatchObject([
      { data: { policy: "never", source: "delegation" } },
      { data: { policy: "ask" } },
    ]);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.source).toMatchObject({ kind: "shud-coder-approval" });
    const held = h.hold();
    session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit", session, child);
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]).toMatchObject({
      agent: child,
      toolName: "change_submit",
      callId: operation.callId,
    });
    expect(operation.isSettled()).toBe(false);
    expect(h.executions).toEqual([]);
    expect(session.snapshotEvents().filter((event) => event.type === "approval/decided")).toEqual(
      [],
    );
    expect(await Promise.all(paths.map(snapshotFile))).toEqual(before);
    held.answer.resolve("allowed-once");
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
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
    expect(readWorkspaceRecord(h.cwd, "change", CHANGE_ID, { readonly: true })).toMatchObject({
      status: "approved",
      approval_ref: operation.callId,
    });
    const asked = session.snapshotEvents().find((event) => event.type === "approval/asked");
    expect(asked?.data).toMatchObject({ toolName: "change_submit", callId: operation.callId });
    expect(
      session.snapshotEvents().filter((event) => event.type === "approval/decided"),
    ).toMatchObject([{ data: { id: asked?.data.id, outcome: "allowed-once" } }]);
    expect(await Promise.all(paths.slice(1).map(snapshotFile))).toEqual(before.slice(1));
    expect(h.ctx.approval.overrideOf(parentSession)).toBe("ask");
  } finally {
    await h.dispose();
  }
});
