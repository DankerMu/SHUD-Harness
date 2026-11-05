import type { SessionLogOffset } from "@deepseek-ai/dsh-session";
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

const ineligible: Array<{ label: string; options: CoderOptions }> = [
  { label: "parent never", options: { parentPolicy: "never" } },
  { label: "explicit child never", options: { childPolicy: "never" } },
  { label: "explicit child ask", options: { childPolicy: "ask" } },
  {
    label: "sole explicit never without delegation provenance",
    options: { delegation: false, childPolicy: "never" },
  },
  {
    label: "sole explicit ask without delegation provenance",
    options: { delegation: false, childPolicy: "ask" },
  },
  { label: "missing live registry", options: { registry: false } },
  { label: "missing child approval service", options: { approvalService: false } },
  { label: "no delegation policy", options: { delegation: false } },
  { label: "prior completed child turn", options: { priorTurn: true } },
  {
    label: "root caller",
    options: { childMeta: { origin: undefined, parentSession: undefined, delegationDepth: 0 } },
  },
  { label: "worker", options: { childMeta: { agentPreset: "worker" } } },
  { label: "reviewer", options: { childMeta: { agentPreset: "reviewer" } } },
  { label: "unknown role", options: { childMeta: { agentPreset: "custom-role" } } },
  { label: "missing child depth", options: { childMeta: { delegationDepth: undefined } } },
  { label: "wrong child depth", options: { childMeta: { delegationDepth: 2 } } },
  { label: "missing parent lineage", options: { childMeta: { parentSession: undefined } } },
  {
    label: "non-root parent without persisted depth",
    options: { parentMeta: { origin: "subagent" } },
  },
  { label: "runtime depth deepens root", options: { runtimeDepth: 1 } },
  { label: "negative runtime depth", options: { runtimeDepth: -1 } },
  { label: "negative zero runtime depth", options: { runtimeDepth: -0 } },
  { label: "fractional runtime depth", options: { runtimeDepth: 0.5 } },
  { label: "unknown runtime depth", options: { runtimeDepth: "0" } },
  { label: "nonfinite runtime depth", options: { runtimeDepth: Number.NaN } },
  {
    label: "explicitly empty fork seed",
    options: {
      childMeta: { isSeeded: true },
      seed: [],
      inheritedEventCount: 0 as SessionLogOffset,
    },
  },
];

test.each(ineligible)(
  "$label never adds initialization or changes business files",
  async ({ options }) => {
    const h = await fixture(options);
    const before = policyEvents(h.session);
    const parentBefore = h.parentSession.snapshotEvents();
    await h.announce();
    expect(policyEvents(h.session)).toEqual(before);
    expect(h.notices).toEqual([]);
    expect(h.parentSession.snapshotEvents()).toEqual(parentBefore);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each([undefined, 0])(
  "top-level parent persisted depth %s permits one initialization",
  async (depth) => {
    const h = await fixture({ parentMeta: { delegationDepth: depth }, runtimeDepth: 0 });
    h.session.append("sandbox/mode", { mode: "read-only", source: "delegation" });
    expect(h.ctx.sessionProjections.stateOf(h.session, "shudCoderApproval")).toMatchObject({
      inherited: 0,
      policyCount: 1,
      started: false,
      latest: { policy: "never", delegation: true },
    });
    const seq = h.session.seq;
    const parentBefore = h.parentSession.snapshotEvents();
    await h.announce();
    expect(policyEvents(h.session).map((event) => event.data)).toEqual([
      { policy: "never", source: "delegation" },
      { policy: "ask" },
    ]);
    expect(h.notices).toHaveLength(1);
    expect(h.notices[0]?.source).toEqual({
      kind: "shud-coder-approval",
      policySeq: seq,
      parentSession: h.parent.id,
      parentPolicy: "ask",
    });
    expect(JSON.stringify(h.notices[0])).not.toContain("changed by the user");
    expect(h.parentSession.snapshotEvents()).toEqual(parentBefore);
    expect(h.ctx.sessionProjections.stateOf(h.session, "permissions")).toMatchObject({
      sandbox: "read-only",
    });
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each(["resume", "clear", "compact"] as const)(
  "%s publication cannot opt in",
  async (source) => {
    const h = await fixture();
    const before = h.session.snapshotEvents();
    await h.announce(source);
    expect(h.session.snapshotEvents()).toEqual(before);
    expect(h.notices).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test.each([
  "missing child",
  "replacement child",
  "missing parent",
  "replacement parent",
  "replacement owner",
  "wrong child id",
  "wrong parent id",
  "wrong child session",
  "wrong parent session",
])("%s cannot authorize initialization", async (kind) => {
  const h = await fixture();
  if (kind === "missing child") h.registry.child = undefined;
  if (kind === "replacement child") h.registry.child = { ...h.child };
  if (kind === "missing parent") h.registry.parent = undefined;
  if (kind === "replacement parent") h.registry.parent = { ...h.parent };
  if (kind === "replacement owner") h.registry.owned = false;
  if (kind === "wrong child id") Object.assign(h.child, { id: h.parent.id });
  if (kind === "wrong parent id") Object.assign(h.parent, { id: h.child.id });
  if (kind === "wrong child session") Object.assign(h.child, { session: h.parentSession });
  if (kind === "wrong parent session") Object.assign(h.parent, { session: h.session });
  const before = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});

test.each(["service", "policy"] as const)(
  "missing parent %s is not inferred as ask",
  async (kind) => {
    const h = await fixture();
    h.missingParentCapability(kind);
    const before = h.session.snapshotEvents();
    await h.announce();
    expect(h.session.snapshotEvents()).toEqual(before);
    expect(h.notices).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test("parent changed to never before publication remains authoritative", async () => {
  const h = await fixture();
  h.parentSession.append("approval/policy", { policy: "never" });
  const before = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.ctx.approval.overrideOf(h.parentSession)).toBe("never");
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});

test("cancelled creation does not initialize", async () => {
  const h = await fixture();
  const signal = AbortSignal.abort();
  const before = h.session.snapshotEvents();
  await h.announce("startup", signal);
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});

test("seeded inherited policy is not mistaken for a sole child-owned policy", async () => {
  const source = await fixture();
  const seed = source.parentSession.snapshotEvents();
  const h = await fixture({
    seed,
    inheritedEventCount: seed.length as SessionLogOffset,
    childMeta: { isSeeded: true },
  });
  const before = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.ctx.sessionProjections.stateOf(h.session, "shudCoderApproval")).toMatchObject({
    inherited: seed.length,
    policyCount: 1,
    started: false,
  });
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});

test("duplicate creation and later role changes cannot overwrite explicit never", async () => {
  const h = await fixture();
  await h.announce();
  const initialized = policyEvents(h.session);
  await h.announce();
  expect(policyEvents(h.session)).toEqual(initialized);
  h.ctx.approval.setPolicy(h.child, "never");
  const notices = [...h.notices];
  h.session.append("agent-preset/selected", { agentPreset: "worker" });
  h.ctx.emit("agent-preset/selected", h.session.id, "worker");
  h.session.append("agent-preset/selected", { agentPreset: "coder" });
  h.ctx.emit("agent-preset/selected", h.session.id, "coder");
  const before = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.notices).toEqual(notices);
  expect(h.ctx.approval.overrideOf(h.session)).toBe("never");
  expect(await h.snapshot()).toEqual(h.before);
});

test.each(["ask", "never"] as const)(
  "disposal and reload retain persisted %s without reinitialization",
  async (policy) => {
    const h = await fixture();
    await h.announce();
    if (policy === "never") h.ctx.approval.setPolicy(h.child, "never");
    const before = h.session.snapshotEvents();
    const notices = [...h.notices];
    await h.unmount();
    expect(h.ctx.sessionProjections.stateOf(h.session, "shudCoderApproval")).toBeUndefined();
    await h.announce();
    expect(h.session.snapshotEvents()).toEqual(before);
    await h.remount();
    expect(h.ctx.approval.overrideOf(h.session)).toBe(policy);
    await h.announce("resume");
    expect(h.session.snapshotEvents()).toEqual(before);
    expect(h.notices).toEqual(notices);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test("later coder selection and plugin reload do not opt in an existing worker", async () => {
  const h = await fixture({ childMeta: { agentPreset: "worker" } });
  await h.announce();
  h.session.append("agent-preset/selected", { agentPreset: "coder" });
  h.ctx.emit("agent-preset/selected", h.session.id, "coder");
  await h.unmount();
  await h.remount();
  const before = h.session.snapshotEvents();
  // Reload does not replay startup announcement; a real resumed lifecycle is ineligible.
  await h.announce("resume");
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});

test.each(["ask", "never"] as const)(
  "restored %s retains its complete recorded policy prefix",
  async (policy) => {
    const source = await fixture();
    await source.announce();
    if (policy === "never") source.ctx.approval.setPolicy(source.child, "never");
    const seed = source.session.snapshotEvents();
    const h = await fixture({ seed, delegation: false });
    const before = h.session.snapshotEvents();
    await h.announce("resume");
    expect(h.session.snapshotEvents()).toEqual(before);
    expect(h.session.snapshotEvents().slice(0, seed.length)).toEqual(seed);
    expect(h.ctx.approval.overrideOf(h.session)).toBe(policy);
    expect(h.notices).toEqual([]);
    expect(await h.snapshot()).toEqual(h.before);
  },
);

test("a previously ineligible creation is not retried after parent becomes ask", async () => {
  const h = await fixture({ parentPolicy: "never" });
  await h.announce();
  h.parentSession.append("approval/policy", { policy: "ask" });
  const before = h.session.snapshotEvents();
  await h.announce();
  expect(h.session.snapshotEvents()).toEqual(before);
  expect(h.ctx.approval.overrideOf(h.session)).toBe("never");
  expect(h.notices).toEqual([]);
  expect(await h.snapshot()).toEqual(h.before);
});
