import type { SessionId } from "@deepseek-ai/dsh-session";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { getRoleToolIds } from "@shud-harness/dsh-shud-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as roleRestrict from "./index.ts";
import { COORDINATOR_TOOLS, createRoleHarness, WORKER_TOOLS } from "./test-harness.ts";
import type { HarnessOptions, RoleHarness } from "./test-harness.ts";

const harnesses: RoleHarness[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.dispose();
  vi.restoreAllMocks();
});

async function setup(options: HarnessOptions = {}) {
  const harness = await createRoleHarness(options);
  harnesses.push(harness);
  const plugin = await harness.ctx.plugin(roleRestrict);
  return { ...harness, plugin };
}

describe("shud-role-restrict public lifecycle", () => {
  it("exports the global plugin identity and restricts inherited tools, not Agent-owned subagent", async () => {
    expect(roleRestrict.name).toBe("shud-role-restrict");
    const harness = await setup();
    const restrict = vi.spyOn(ToolRuntime.prototype, "restrict");
    const coordinator = harness.prepareAgent("coordinator");
    const worker = harness.prepareAgent("worker");
    await coordinator.announce();
    await worker.announce();
    expect(coordinator.surface()).toEqual(COORDINATOR_TOOLS);
    expect(worker.surface()).toEqual(WORKER_TOOLS);
    expect(restrict).toHaveBeenNthCalledWith(1, { allow: getRoleToolIds("coordinator").inherited });
    expect(restrict).toHaveBeenNthCalledWith(2, { allow: getRoleToolIds("worker").inherited });
    expect(restrict.mock.calls[0]?.[0].allow).not.toContain("subagent");
    expect(restrict.mock.calls[0]?.[0].allow).toEqual(
      expect.arrayContaining(["job_output", "job_list", "job_kill"]),
    );
    expect(harness.stateOf).toHaveBeenCalledWith(worker.session, "agentPreset");
  });

  it("uses the current projection on creation, never the stale creation header", async () => {
    const harness = await setup();
    const worker = harness.prepareAgent("worker");
    expect(worker.session.header.agentPreset).toBe("coordinator");
    await worker.announce();
    expect(worker.surface()).toEqual(WORKER_TOOLS);
  });

  it("switches in both directions only after committed selection, ignoring its stale payload", async () => {
    const harness = await setup();
    const caller = harness.prepareAgent("coordinator");
    await caller.announce();
    caller.setLocalSubagent(false);
    caller.setProjection("worker");
    harness.ctx.emit("tools/change");
    expect(caller.surface()).toEqual(COORDINATOR_TOOLS.filter((name) => name !== "subagent"));
    harness.ctx.emit("agent-preset/selected", "unrelated-session" as SessionId, "worker");
    expect(caller.surface()).not.toContain("shud_run");
    caller.selected("coordinator");
    expect(caller.surface()).toEqual(WORKER_TOOLS);
    caller.setLocalSubagent(true);
    caller.setProjection("coordinator");
    caller.selected("worker");
    expect(caller.surface()).toEqual(COORDINATOR_TOOLS);
    expect(caller.session.header.agentPreset).toBe("coordinator");
  });

  it.each([
    ["coordinator", "worker"],
    ["worker", "coordinator"],
  ] as const)(
    "installs %s → %s before releasing the old mask without transient widening",
    async (from, to) => {
      const harness = await setup();
      const caller = harness.prepareAgent(from);
      await caller.announce();
      caller.setLocalSubagent(to === "coordinator");
      caller.setProjection(to);
      const changes: string[][] = [];
      harness.ctx.on("tools/change", () => changes.push(caller.surface()));
      caller.selected(from);
      const local = to === "coordinator" ? ["subagent"] : [];
      expect(changes).toEqual([
        ["job_kill", "job_list", "job_output", "shud_collect", ...local].sort(),
        to === "coordinator" ? COORDINATOR_TOOLS : WORKER_TOOLS,
      ]);
    },
  );

  it("does not stack masks for duplicate creation or same-role selected events", async () => {
    const harness = await setup();
    const caller = harness.prepareAgent();
    await caller.announce();
    const changed = vi.fn();
    harness.ctx.on("tools/change", changed);
    await caller.announce();
    caller.selected("coordinator");
    caller.selected("worker");
    expect(changed).not.toHaveBeenCalled();
    expect(caller.surface()).toEqual(COORDINATOR_TOOLS);
    caller.setProjection("standard");
    caller.selected("standard");
    expect(changed).toHaveBeenCalledTimes(1);
    expect(caller.surface()).toContain("bash");
  });

  it.each([
    "unknown",
    "standard",
    "custom-research",
    "repo_explorer",
    "coder",
    "reviewer",
    null,
    "",
  ])("leaves %s unmasked and tracks it for a later known role", async (preset) => {
    const harness = await setup();
    const caller = harness.prepareAgent(preset);
    const unrestricted = caller.surface();
    await caller.announce();
    expect(caller.surface()).toEqual(unrestricted);
    expect(caller.surface()).toContain("bash");
    caller.setProjection("worker");
    caller.selected("standard");
    expect(caller.surface()).toEqual(WORKER_TOOLS);
    caller.setProjection(preset);
    caller.selected("worker");
    expect(caller.surface()).toEqual(unrestricted);
  });

  it("does not infer a known role from a header when the projection service is absent", async () => {
    const harness = await setup({ projections: false });
    const caller = harness.prepareAgent("worker");
    const unrestricted = caller.surface();
    await caller.announce();
    caller.selected("coordinator");
    expect(caller.surface()).toEqual(unrestricted);
    expect(harness.stateOf).not.toHaveBeenCalled();
  });

  it("isolates different Agents and removes disposed Agent registrations", async () => {
    const harness = await setup();
    const first = harness.prepareAgent("coordinator");
    const second = harness.prepareAgent("worker");
    await first.announce();
    await second.announce();
    first.setLocalSubagent(false);
    first.setProjection("worker");
    first.selected();
    expect(first.surface()).toEqual(WORKER_TOOLS);
    expect(second.surface()).toEqual(WORKER_TOOLS);
    first.announceDisposed();
    expect(first.surface()).toContain("bash");
    expect(second.surface()).toEqual(WORKER_TOOLS);
    first.setProjection("coordinator");
    first.selected();
    expect(first.surface()).toContain("bash");
    await first.disposeScopes();
    expect(second.surface()).toEqual(WORKER_TOOLS);
  });

  it("keys ownership by actual Agent identity even when session ids coincide", async () => {
    const harness = await setup();
    const first = harness.prepareAgent("worker");
    const second = harness.prepareAgent("worker", first.session.id);
    await first.announce();
    await second.announce();
    first.setProjection("coordinator");
    second.setProjection("coordinator");
    first.setLocalSubagent(true);
    second.setLocalSubagent(true);
    first.selected("worker");
    expect(first.surface()).toEqual(COORDINATOR_TOOLS);
    expect(second.surface()).toEqual(COORDINATOR_TOOLS);
    first.announceDisposed();
    second.setProjection("worker");
    second.setLocalSubagent(false);
    second.selected();
    expect(second.surface()).toEqual(WORKER_TOOLS);
    expect(first.surface()).toContain("bash");
  });

  it("preserves foreign masks across unknown selection, Agent disposal and plugin disposal", async () => {
    const harness = await setup();
    const first = harness.prepareAgent("coordinator");
    const second = harness.prepareAgent("worker");
    const releaseFirst = first.agent.ctx.tools.restrict({ deny: ["bash", "job_kill"] });
    const releaseSecond = second.agent.ctx.tools.restrict({ deny: ["write", "job_list"] });
    const firstForeign = first.surface();
    const secondForeign = second.surface();
    await first.announce();
    await second.announce();
    expect(first.surface()).toEqual(COORDINATOR_TOOLS.filter((name) => name !== "job_kill"));
    expect(second.surface()).toEqual(WORKER_TOOLS.filter((name) => name !== "job_list"));
    first.setProjection("standard");
    first.selected();
    expect(first.surface()).toEqual(firstForeign);
    first.setProjection("coordinator");
    first.selected();
    first.announceDisposed();
    expect(first.surface()).toEqual(firstForeign);
    await harness.plugin.dispose();
    expect(second.surface()).toEqual(secondForeign);
    second.selected();
    await second.announce();
    expect(second.surface()).toEqual(secondForeign);
    const afterDisposal = harness.prepareAgent("worker");
    await afterDisposal.announce();
    expect(afterDisposal.surface()).toContain("bash");
    releaseFirst();
    releaseSecond();
    expect(first.surface()).toContain("bash");
    expect(second.surface()).toContain("write");
  });
});
