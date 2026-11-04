import type { SessionId } from "@deepseek-ai/dsh-session";
import { ToolRuntime } from "@deepseek-ai/dsh-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import * as roleRestrict from "./index.ts";
import {
  COORDINATOR_DELEGATIONS,
  COORDINATOR_TOOLS,
  createRoleHarness,
  ROLE_CASES,
  WORKER_TOOLS,
} from "./test-harness.ts";
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
  it.each(ROLE_CASES)(
    "binds $role inherited tools from its current projection, excluding Agent-owned delegates",
    async ({ role, inherited, local, expected }) => {
      expect(roleRestrict.name).toBe("shud-role-restrict");
      const harness = await setup();
      const restrict = vi.spyOn(ToolRuntime.prototype, "restrict");
      const caller = harness.prepareAgent(role);
      expect(caller.session.header.agentPreset).toBe("coordinator");
      await caller.announce();
      expect(caller.surface()).toEqual(expected);
      expect(restrict).toHaveBeenCalledTimes(1);
      expect([...(restrict.mock.calls[0]?.[0].allow ?? [])].sort()).toEqual(inherited);
      for (const delegate of COORDINATOR_DELEGATIONS) {
        expect(restrict.mock.calls[0]?.[0].allow).not.toContain(delegate);
      }
      expect(caller.surface().filter((name) => COORDINATOR_DELEGATIONS.includes(name))).toEqual(
        local,
      );
      expect(harness.stateOf).toHaveBeenCalledWith(caller.session, "agentPreset");
    },
  );

  it("switches in both directions only after committed selection, ignoring its stale payload", async () => {
    const harness = await setup();
    const caller = harness.prepareAgent("coordinator");
    await caller.announce();
    caller.setLocalDelegations(false);
    caller.setProjection("worker");
    harness.ctx.emit("tools/change");
    expect(caller.surface()).toEqual(
      COORDINATOR_TOOLS.filter((name) => !COORDINATOR_DELEGATIONS.includes(name)),
    );
    harness.ctx.emit("agent-preset/selected", "unrelated-session" as SessionId, "worker");
    expect(caller.surface()).not.toContain("shud_run");
    caller.selected("coordinator");
    expect(caller.surface()).toEqual(WORKER_TOOLS);
    caller.setLocalDelegations(true);
    caller.setProjection("coordinator");
    caller.selected("worker");
    expect(caller.surface()).toEqual(COORDINATOR_TOOLS);
    expect(caller.session.header.agentPreset).toBe("coordinator");
  });

  it.each(
    ROLE_CASES.flatMap((from) =>
      ROLE_CASES.filter((to) => to.role !== from.role).map((to) => ({ from, to })),
    ),
  )(
    "installs $from.role → $to.role before releasing the old mask without transient widening",
    async ({ from, to }) => {
      const harness = await setup();
      const caller = harness.prepareAgent(from.role);
      await caller.announce();
      caller.setLocalDelegations(to.role === "coordinator");
      caller.setProjection(to.role);
      const changes: string[][] = [];
      harness.ctx.on("tools/change", () => changes.push(caller.surface()));
      caller.selected(from.role);
      expect(changes).toEqual([
        [...from.inherited.filter((name) => to.inherited.includes(name)), ...to.local].sort(),
        to.expected,
      ]);
    },
  );

  it.each(ROLE_CASES)(
    "does not stack $role masks for duplicate creation or same-role selected events",
    async ({ role, expected }) => {
      const harness = await setup();
      const caller = harness.prepareAgent(role);
      await caller.announce();
      const changed = vi.fn();
      harness.ctx.on("tools/change", changed);
      await caller.announce();
      caller.selected(role);
      caller.selected("stale-payload");
      expect(changed).not.toHaveBeenCalled();
      expect(caller.surface()).toEqual(expected);
      caller.setProjection("standard");
      caller.selected("standard");
      expect(changed).toHaveBeenCalledTimes(1);
      expect(caller.surface()).toContain("write");
      caller.setProjection(role);
      caller.selected("standard");
      expect(caller.surface()).toEqual(expected);
    },
  );

  it.each(["unknown", "standard", "custom-research", "repo_explorer", null, ""])(
    "leaves %s unmasked and tracks it for a later known role",
    async (preset) => {
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
    },
  );

  it("does not infer a known role from a header when the projection service is absent", async () => {
    const harness = await setup({ projections: false });
    const caller = harness.prepareAgent("worker");
    const unrestricted = caller.surface();
    await caller.announce();
    caller.selected("coordinator");
    expect(caller.surface()).toEqual(unrestricted);
    expect(harness.stateOf).not.toHaveBeenCalled();
  });

  it.each(ROLE_CASES)(
    "isolates two $role Agent lifetimes and removes disposed registrations",
    async ({ role, expected }) => {
      const harness = await setup();
      const restrict = vi.spyOn(ToolRuntime.prototype, "restrict");
      const first = harness.prepareAgent(role);
      const second = harness.prepareAgent(role);
      const unrestricted = first.surface();
      await first.announce();
      await second.announce();
      expect(first.surface()).toEqual(expected);
      expect(second.surface()).toEqual(expected);
      await first.announce();
      await second.announce();
      first.selected(role);
      second.selected("stale-payload");
      expect(restrict).toHaveBeenCalledTimes(2);
      expect(first.surface()).toEqual(expected);
      expect(second.surface()).toEqual(expected);
      first.setProjection("standard");
      first.selected(role);
      expect(first.surface()).toEqual(unrestricted);
      expect(second.surface()).toEqual(expected);
      first.setProjection(role);
      first.selected("standard");
      expect(first.surface()).toEqual(expected);
      first.announceDisposed();
      expect(first.surface()).toEqual(unrestricted);
      expect(second.surface()).toEqual(expected);
      first.selected(role);
      expect(first.surface()).toEqual(unrestricted);
      await first.disposeScopes();
      expect(second.surface()).toEqual(expected);
    },
  );

  it.each(ROLE_CASES)(
    "keys $role ownership by actual Agent identity even when session ids coincide",
    async ({ role, expected }) => {
      const harness = await setup();
      const target = ROLE_CASES[role === "coordinator" ? 1 : 0];
      const first = harness.prepareAgent(role);
      const second = harness.prepareAgent(role, first.session.id);
      await first.announce();
      await second.announce();
      first.setProjection(target.role);
      second.setProjection(target.role);
      first.setLocalDelegations(target.role === "coordinator");
      second.setLocalDelegations(target.role === "coordinator");
      first.selected(role);
      expect(first.surface()).toEqual(target.expected);
      expect(second.surface()).toEqual(target.expected);
      first.announceDisposed();
      second.setProjection(role);
      second.setLocalDelegations(role === "coordinator");
      second.selected(target.role);
      expect(second.surface()).toEqual(expected);
      expect(first.surface()).toContain("write");
    },
  );

  it.each(ROLE_CASES)(
    "preserves foreign masks for $role across unknown selection, Agent and plugin disposal",
    async ({ role, expected }) => {
      const harness = await setup();
      const first = harness.prepareAgent(role);
      const second = harness.prepareAgent(role);
      const firstDenied = ["write", "shud_collect", "change_create"];
      const secondDenied = ["edit", "job_list"];
      const releaseFirst = first.agent.ctx.tools.restrict({ deny: firstDenied });
      const releaseSecond = second.agent.ctx.tools.restrict({ deny: secondDenied });
      const firstForeign = first.surface();
      const secondForeign = second.surface();
      await first.announce();
      await second.announce();
      expect(first.surface()).toEqual(expected.filter((name) => !firstDenied.includes(name)));
      expect(second.surface()).toEqual(expected.filter((name) => !secondDenied.includes(name)));
      first.setProjection("standard");
      first.selected();
      expect(first.surface()).toEqual(firstForeign);
      first.setProjection(role);
      first.selected();
      first.announceDisposed();
      expect(first.surface()).toEqual(firstForeign);
      await harness.plugin.dispose();
      expect(second.surface()).toEqual(secondForeign);
      const restrict = vi.spyOn(ToolRuntime.prototype, "restrict");
      second.selected();
      await second.announce();
      expect(second.surface()).toEqual(secondForeign);
      const afterDisposal = harness.prepareAgent(role);
      const unrestricted = afterDisposal.surface();
      await afterDisposal.announce();
      afterDisposal.selected(role);
      expect(afterDisposal.surface()).toEqual(unrestricted);
      expect(restrict).not.toHaveBeenCalled();
      releaseFirst();
      releaseSecond();
      expect(first.surface()).toContain("write");
      expect(second.surface()).toContain("edit");
    },
  );

  it("releases every owned mask when a tools-change observer throws during plugin disposal", async () => {
    const harness = await setup();
    const first = harness.prepareAgent("coordinator");
    const second = harness.prepareAgent("worker");
    first.agent.ctx.tools.restrict({ deny: ["bash", "job_kill"] });
    second.agent.ctx.tools.restrict({ deny: ["write", "job_list"] });
    const firstForeign = first.surface();
    const secondForeign = second.surface();
    await first.announce();
    await second.announce();
    expect(first.surface()).toEqual(COORDINATOR_TOOLS.filter((name) => name !== "job_kill"));
    expect(second.surface()).toEqual(WORKER_TOOLS.filter((name) => name !== "job_list"));
    const observer = vi.fn(() => {
      throw new Error("controlled tools-change cleanup observer failure");
    });
    const stopFault = harness.ctx.on("tools/change", observer);
    try {
      // Cordis captures effect-disposal errors; this boundary does not reject.
      await expect(Promise.resolve(harness.plugin.dispose())).resolves.toBeUndefined();
      expect(observer).toHaveBeenCalled();
    } finally {
      stopFault();
    }
    expect(first.surface()).toEqual(firstForeign);
    expect(second.surface()).toEqual(secondForeign);
    first.setProjection("worker");
    second.setProjection("coordinator");
    first.selected("worker");
    second.selected("coordinator");
    await first.announce();
    await second.announce();
    expect(first.surface()).toEqual(firstForeign);
    expect(second.surface()).toEqual(secondForeign);
  });

  it.each([
    ["worker", "coordinator", WORKER_TOOLS],
    ["coordinator", "worker", COORDINATOR_TOOLS],
  ] as const)(
    "keeps the latest %s projection when a %s bind emits a reentrant committed selection",
    async (initial, outer, expected) => {
      const harness = await setup();
      const caller = harness.prepareAgent(initial);
      await caller.announce();
      caller.setProjection(outer);
      let reentered = false;
      const stopReentry = harness.ctx.on("tools/change", () => {
        stopReentry();
        reentered = true;
        caller.setProjection(initial);
        caller.selected(initial);
      });
      try {
        caller.selected(outer);
        expect(reentered).toBe(true);
        expect(caller.surface()).toEqual(expected);
      } finally {
        stopReentry();
      }
    },
  );

  it("releases an interrupted bind on reentrant unknown selection and can later bind again", async () => {
    const harness = await setup();
    const caller = harness.prepareAgent("worker");
    caller.agent.ctx.tools.restrict({ deny: ["bash"] });
    const foreignOnly = caller.surface();
    await caller.announce();
    caller.setProjection("coordinator");
    let reentered = false;
    const stopReentry = harness.ctx.on("tools/change", () => {
      stopReentry();
      reentered = true;
      caller.setProjection("standard");
      caller.selected("standard");
    });
    try {
      caller.selected("coordinator");
      expect(reentered).toBe(true);
      expect(caller.surface()).toEqual(foreignOnly);
      caller.setProjection("worker");
      caller.selected("worker");
      expect(caller.surface()).toEqual(WORKER_TOOLS);
    } finally {
      stopReentry();
    }
  });

  it("does not retain an interrupted bind or registration after reentrant Agent disposal", async () => {
    const harness = await setup();
    const caller = harness.prepareAgent("worker");
    caller.agent.ctx.tools.restrict({ deny: ["bash"] });
    const foreignOnly = caller.surface();
    await caller.announce();
    caller.setProjection("coordinator");
    let reentered = false;
    const stopReentry = harness.ctx.on("tools/change", () => {
      stopReentry();
      reentered = true;
      caller.announceDisposed();
    });
    try {
      caller.selected("coordinator");
      expect(reentered).toBe(true);
      expect(caller.surface()).toEqual(foreignOnly);
      caller.setProjection("worker");
      caller.selected("worker");
      expect(caller.surface()).toEqual(foreignOnly);
    } finally {
      stopReentry();
    }
  });
});
