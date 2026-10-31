import type * as Core from "@shud-harness/dsh-shud-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { COORDINATOR_TOOLS, createRoleHarness, WORKER_TOOLS } from "./test-harness.ts";
import type { RoleHarness } from "./test-harness.ts";

// Reload the entry after each core-boundary reset: a static import would retain the
// unmodified canonical map and prevent the empty-list module-loading control.
let harness: RoleHarness | undefined;
afterEach(async () => {
  await harness?.dispose();
  harness = undefined;
  vi.doUnmock("@shud-harness/dsh-shud-core");
  vi.resetModules();
});

describe("shud-role-restrict bind failures", () => {
  it.each([
    ["coordinator", "report_generate"],
    ["coordinator", "job_output"],
    ["worker", "shud_run"],
  ])("rejects %s creation when inherited %s was never registered", async (role, missing) => {
    harness = await createRoleHarness({ missing });
    await harness.ctx.plugin(await import("./index.ts"));
    const caller = harness.prepareAgent(role);
    const later = vi.fn();
    harness.ctx.on("agent/created", later);
    const creation = caller.announce();
    await expect(creation).rejects.toThrow("shud-role-restrict");
    await expect(creation).rejects.toThrow(missing);
    expect(later).not.toHaveBeenCalled();
    // This exercises the public serial boundary, not the host Agent factory's rollback.
  });

  it("propagates raw selected errors, preserves the old and foreign masks, then binds on a later valid event", async () => {
    harness = await createRoleHarness({ missing: "shud_run" });
    await harness.ctx.plugin(await import("./index.ts"));
    const caller = harness.prepareAgent("coordinator");
    caller.agent.ctx.tools.restrict({ deny: ["bash", "job_kill"] });
    await caller.announce();
    caller.setLocalSubagent(false);
    const previous = COORDINATOR_TOOLS.filter((name) => name !== "subagent" && name !== "job_kill");
    const changes: string[][] = [];
    harness.ctx.on("tools/change", () => changes.push(caller.surface()));
    const later = vi.fn();
    harness.ctx.on("agent-preset/selected", later);
    caller.setProjection("worker");
    let failure: unknown;
    try {
      caller.selected("worker");
    } catch (error) {
      failure = error;
    }
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain("shud-role-restrict");
    expect(String(failure)).toContain("shud_run");
    expect(caller.surface()).toEqual(previous);
    expect(changes).toEqual([]);
    expect(later).not.toHaveBeenCalled();
    harness.registerGlobal("shud_run");
    expect(caller.surface()).toEqual(previous);
    caller.selected("coordinator");
    expect(caller.surface()).toEqual(WORKER_TOOLS.filter((name) => name !== "job_kill"));
    expect(later).toHaveBeenCalledTimes(1);
    caller.setProjection("standard");
    caller.selected();
    expect(caller.surface()).not.toContain("bash");
    expect(caller.surface()).not.toContain("job_kill");
    expect(caller.surface()).toContain("write");
  });

  it.each(["creation", "replacement"])(
    "explicitly rejects an empty canonical inherited list during %s",
    async (phase) => {
      // The canonical map is frozen and never empty today. Override only this impossible
      // input at the core boundary, retaining the real reader, mapping and ToolRuntime.
      vi.resetModules();
      vi.doMock("@shud-harness/dsh-shud-core", async () => {
        const actual = await vi.importActual<typeof Core>("@shud-harness/dsh-shud-core");
        return {
          ...actual,
          getRoleToolIds(role: Parameters<typeof actual.getRoleToolIds>[0]) {
            return role === "coordinator"
              ? { inherited: [], local: ["subagent"] }
              : actual.getRoleToolIds(role);
          },
        };
      });
      harness = await createRoleHarness();
      await harness.ctx.plugin(await import("./index.ts"));
      const caller = harness.prepareAgent(phase === "creation" ? "coordinator" : "worker");
      if (phase === "creation") {
        const creation = caller.announce();
        await expect(creation).rejects.toThrow("shud-role-restrict");
        await expect(creation).rejects.toThrow("coordinator");
      } else {
        await caller.announce();
        caller.setProjection("coordinator");
        expect(() => caller.selected()).toThrow(
          /shud-role-restrict.*coordinator|coordinator.*shud-role-restrict/,
        );
        expect(caller.surface()).toEqual(WORKER_TOOLS);
        caller.setProjection("standard");
        caller.selected();
        expect(caller.surface()).toContain("bash");
        caller.setProjection("worker");
        caller.selected();
        expect(caller.surface()).toEqual(WORKER_TOOLS);
      }
    },
  );
});
