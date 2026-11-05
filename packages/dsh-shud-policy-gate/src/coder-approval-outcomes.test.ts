import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountCoderHarness, policyEvents } from "./approval/coder/test-harness.ts";
import type { CoderOptions } from "./approval/coder/test-harness.ts";

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
  return h;
}

test.each(["rejected", "cancelled", "unavailable"] as const)(
  "initialized coder actual change_submit waits then fails closed for %s",
  async (outcome) => {
    const h = await fixture();
    await h.announce();
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit", h.session, h.child);
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toEqual({
      kind: "dispatched",
    });
    expect(held.requests).toHaveLength(1);
    expect(held.requests[0]).toMatchObject({
      agent: h.child,
      toolName: "change_submit",
      callId: operation.callId,
    });
    expect(operation.isSettled()).toBe(false);
    expect(h.executions).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
    expect(h.session.snapshotEvents().filter((event) => event.type === "approval/decided")).toEqual(
      [],
    );
    held.answer.resolve(outcome);
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: true },
    });
    const asked = h.session.snapshotEvents().find((event) => event.type === "approval/asked");
    expect(asked?.data).toMatchObject({ toolName: "change_submit", callId: operation.callId });
    expect(
      h.session.snapshotEvents().filter((event) => event.type === "approval/decided"),
    ).toMatchObject([{ data: { id: asked?.data.id, outcome } }]);
    expect(h.executions).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each(["absent", "throwing"] as const)(
  "%s answerer fails actual coder change_submit closed",
  async (kind) => {
    const h = await fixture();
    await h.announce();
    const deliveries: string[] = [];
    if (kind === "throwing")
      h.ctx.on("approval/request", (request) => {
        deliveries.push(request.callId ?? "missing");
        throw new Error("Answerer transport unavailable");
      });
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit", h.session, h.child);
    expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: true },
    });
    expect(deliveries).toEqual(kind === "throwing" ? [operation.callId] : []);
    expect(
      h.session.snapshotEvents().filter((event) => event.type === "approval/asked"),
    ).toMatchObject([{ data: { toolName: "change_submit", callId: operation.callId } }]);
    expect(
      h.session.snapshotEvents().filter((event) => event.type === "approval/decided"),
    ).toMatchObject([{ data: { outcome: "unavailable" } }]);
    expect(h.executions).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each(["parent", "explicit", "restored", "later explicit"] as const)(
  "%s never settles rejection before a held answerer and preserves every business byte",
  async (kind) => {
    const source = kind === "restored" ? await fixture({ childPolicy: "never" }) : undefined;
    const h = await fixture(
      kind === "parent"
        ? { parentPolicy: "never" }
        : kind === "explicit"
          ? { childPolicy: "never" }
          : source
            ? { delegation: false, seed: source.session.snapshotEvents() }
            : {},
    );
    const before = policyEvents(h.session);
    await h.announce(kind === "restored" ? "resume" : "startup");
    if (kind === "later explicit") h.ctx.approval.setPolicy(h.child, "never");
    else expect(policyEvents(h.session)).toEqual(before);
    const held = h.hold();
    h.session.append("turn/start", { turn: 1 });
    const operation = h.call("change_submit", h.session, h.child);
    // Settlement, not zero callback count alone, proves policy-before-answerer rejection.
    expect(await Promise.race([held.dispatched, operation.done, h.watchdog])).toMatchObject({
      kind: "settled",
      result: { isError: true },
    });
    expect(held.requests).toEqual([]);
    expect(
      h.session.snapshotEvents().filter((event) => event.type === "approval/decided"),
    ).toMatchObject([{ data: { outcome: "rejected" } }]);
    expect(h.executions).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test("missing child ApprovalService fails actual change_submit before handler dispatch", async () => {
  const h = await fixture({ approvalService: false });
  const before = policyEvents(h.session);
  await h.announce();
  expect(h.ctx.get("approval")).toBeUndefined();
  expect(policyEvents(h.session)).toEqual(before);
  expect(h.notices).toEqual([]);
  h.session.append("turn/start", { turn: 1 });
  const operation = h.call("change_submit", h.session, h.child);
  expect(await Promise.race([operation.done, h.watchdog])).toMatchObject({
    kind: "settled",
    result: { isError: true },
  });
  expect(h.executions).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});
