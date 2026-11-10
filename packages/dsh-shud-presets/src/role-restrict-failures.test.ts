import type * as Core from "@shud-harness/dsh-shud-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createRoleHarness, ROLE_CASES } from "./test-harness.ts";
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
    ["coordinator", "analysis_create"],
    ["coordinator", "job_output"],
    ["worker", "shud_run"],
    ["coder", "shud_build"],
    ["reviewer", "verification_run"],
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

  it.each([
    { target: ROLE_CASES[0], previous: ROLE_CASES[1], missing: "report_generate" },
    { target: ROLE_CASES[1], previous: ROLE_CASES[0], missing: "shud_run" },
    { target: ROLE_CASES[2], previous: ROLE_CASES[0], missing: "shud_build" },
    { target: ROLE_CASES[3], previous: ROLE_CASES[0], missing: "verification_run" },
  ])(
    "preserves old and foreign masks on failed $target.role replacement, then binds on a valid event",
    async ({ target, previous, missing }) => {
      harness = await createRoleHarness({ missing });
      await harness.ctx.plugin(await import("./index.ts"));
      const caller = harness.prepareAgent(previous.role);
      caller.setLocalDelegations(target.role === "coordinator");
      const denied = ["write", "shud_collect", "change_create"];
      caller.agent.ctx.tools.restrict({ deny: denied });
      await caller.announce();
      const prior = [...previous.inherited, ...target.local]
        .filter((name) => !denied.includes(name))
        .sort();
      expect(caller.surface()).toEqual(prior);
      const changes: string[][] = [];
      harness.ctx.on("tools/change", () => changes.push(caller.surface()));
      const later = vi.fn();
      harness.ctx.on("agent-preset/selected", later);
      caller.setProjection(target.role);
      let failure: unknown;
      try {
        caller.selected(previous.role);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("shud-role-restrict");
      expect(String(failure)).toContain(missing);
      expect(caller.surface()).toEqual(prior);
      expect(changes).toEqual([]);
      expect(later).not.toHaveBeenCalled();
      harness.registerGlobal(missing);
      expect(caller.surface()).toEqual(prior);
      caller.selected(previous.role);
      expect(caller.surface()).toEqual(target.expected.filter((name) => !denied.includes(name)));
      expect(later).toHaveBeenCalledTimes(1);
      caller.setProjection("standard");
      caller.selected();
      for (const name of denied) expect(caller.surface()).not.toContain(name);
      expect(caller.surface()).toContain("edit");
    },
  );

  it.each(
    ROLE_CASES.flatMap((target) =>
      (["creation", "replacement"] as const).flatMap((phase) =>
        (["empty", "unknown"] as const).map((invalid) => ({ target, phase, invalid })),
      ),
    ),
  )(
    "rejects $invalid $target.role inherited lists during $phase without losing ownership",
    async ({ target, phase, invalid }) => {
      // Only the impossible core-map input is doubled. Projection, role derivation,
      // scope ownership and unknown-tool rejection remain the real implementations.
      let injectInvalid = phase === "creation";
      vi.resetModules();
      vi.doMock("@shud-harness/dsh-shud-core", async () => {
        const actual = await vi.importActual<typeof Core>("@shud-harness/dsh-shud-core");
        return {
          ...actual,
          getRoleToolIds(role: Parameters<typeof actual.getRoleToolIds>[0]) {
            const profile = actual.getRoleToolIds(role);
            if (role !== target.role || !injectInvalid) return profile;
            return {
              ...profile,
              inherited: invalid === "empty" ? [] : [...profile.inherited, "shud.run"],
            };
          },
        };
      });
      harness = await createRoleHarness();
      await harness.ctx.plugin(await import("./index.ts"));
      const previous = ROLE_CASES[target.role === "coordinator" ? 1 : 0];
      const caller = harness.prepareAgent(phase === "creation" ? target.role : previous.role);
      caller.setLocalDelegations(target.role === "coordinator");
      const denied = ["write", "shud_collect", "change_create"];
      caller.agent.ctx.tools.restrict({ deny: denied });
      const foreignOnly = caller.surface();
      if (phase === "replacement") {
        await caller.announce();
        expect(caller.surface()).toEqual(
          [...previous.inherited, ...target.local].filter((name) => !denied.includes(name)).sort(),
        );
        caller.setProjection(target.role);
        injectInvalid = true;
      }
      const prior = caller.surface();
      const changes = vi.fn();
      harness.ctx.on("tools/change", changes);
      const later = vi.fn();
      if (phase === "creation") harness.ctx.on("agent/created", later);
      else harness.ctx.on("agent-preset/selected", later);
      let failure: unknown;
      try {
        if (phase === "creation") await caller.announce();
        else caller.selected(previous.role);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toContain("shud-role-restrict");
      expect(String(failure)).toContain(target.role);
      if (invalid === "unknown") {
        expect(String(failure)).toContain("shud.run");
        expect((failure as Error).cause).toBeInstanceOf(Error);
        expect(String((failure as Error).cause)).toContain("shud.run");
      } else {
        expect(String(failure)).toContain("empty");
      }
      expect(caller.surface()).toEqual(prior);
      expect(changes).not.toHaveBeenCalled();
      expect(later).not.toHaveBeenCalled();

      injectInvalid = false;
      if (phase === "creation") await caller.announce();
      else caller.selected(previous.role);
      expect(caller.surface()).toEqual(target.expected.filter((name) => !denied.includes(name)));
      expect(later).toHaveBeenCalledTimes(1);
      caller.setProjection("standard");
      caller.selected();
      expect(caller.surface()).toEqual(foreignOnly);
      caller.setProjection(target.role);
      caller.selected("standard");
      expect(caller.surface()).toEqual(target.expected.filter((name) => !denied.includes(name)));
    },
  );
});
