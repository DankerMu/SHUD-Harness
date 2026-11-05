import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mountCoderHarness, policyEvents } from "./approval/coder/test-harness.ts";

const fixtures: Array<{ dispose(): Promise<void> }> = [];
beforeEach(() => vi.stubEnv("DSH_PERMISSION_MODE", "workspace-write"));
afterEach(async () => {
  vi.restoreAllMocks();
  for (const h of fixtures.splice(0)) await h.dispose();
  vi.unstubAllEnvs();
});
async function fixture() {
  const h = await mountCoderHarness();
  fixtures.push(h);
  return h;
}

test("initialization append failure preserves never and original failure without retry", async () => {
  const h = await fixture();
  const failure = new Error("Policy append refused before commit");
  const before = h.session.snapshotEvents();
  // Reject before append: no invented post-commit failure contract.
  const append = vi.spyOn(h.session, "append").mockImplementationOnce(() => {
    throw failure;
  });
  await expect(h.announce()).rejects.toMatchObject({ cause: failure });
  expect(append).toHaveBeenCalledTimes(1);
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.ctx.approval.overrideOf(h.session)).toBe("never");
  expect(h.notices).toEqual([]);
  await h.announce();
  expect(append).toHaveBeenCalledTimes(1);
  expect(await h.snapshot()).toEqual(h.before);
});

test("inbox failure rolls back only the initialization policy and fails creation", async () => {
  const h = await fixture();
  const failure = new Error("Inbox refused initialization notice");
  vi.spyOn(h.child, "inject").mockImplementation(() => {
    throw failure;
  });
  await expect(h.announce()).rejects.toMatchObject({ cause: failure });
  expect(policyEvents(h.session).map((event) => event.data)).toEqual([
    { policy: "never", source: "delegation" },
    { policy: "ask" },
    { policy: "never" },
  ]);
  expect(h.ctx.approval.overrideOf(h.session)).toBe("never");
  expect(h.notices).toEqual([]);
  const afterFailure = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(afterFailure);
  expect(await h.snapshot()).toEqual(h.before);
});

test("inbox and rollback failures both remain observable without a second write attempt", async () => {
  const h = await fixture();
  const noticeFailure = new Error("Inbox refused notice");
  const rollbackFailure = new Error("Rollback append refused before commit");
  vi.spyOn(h.child, "inject").mockImplementation(() => {
    vi.spyOn(h.session, "append").mockImplementationOnce(() => {
      throw rollbackFailure;
    });
    throw noticeFailure;
  });
  await expect(h.announce()).rejects.toMatchObject({
    name: "AggregateError",
    errors: [noticeFailure, rollbackFailure],
    cause: rollbackFailure,
  });
  expect(policyEvents(h.session).map((event) => event.data)).toEqual([
    { policy: "never", source: "delegation" },
    { policy: "ask" },
  ]);
  expect(h.notices).toEqual([]);
  const afterFailure = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(afterFailure);
  expect(await h.snapshot()).toEqual(h.before);
});

test.each(["ask", "never"] as const)(
  "failed notice cannot overwrite an intervening external %s record",
  async (policy) => {
    const h = await fixture();
    const failure = new Error("Inbox refused notice after external policy selection");
    vi.spyOn(h.child, "inject").mockImplementation(() => {
      // A separate public append is an external policy write, not a post-commit append exception.
      h.session.append("approval/policy", { policy });
      throw failure;
    });
    await expect(h.announce()).rejects.toMatchObject({ cause: failure });
    expect(policyEvents(h.session).map((event) => event.data)).toEqual([
      { policy: "never", source: "delegation" },
      { policy: "ask" },
      { policy },
    ]);
    expect(h.ctx.approval.overrideOf(h.session)).toBe(policy);
    expect(h.notices).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);
