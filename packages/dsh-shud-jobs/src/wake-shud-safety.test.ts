import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { generateRunIdentifiers, MAX_COLLECT_ATTEMPTS } from "@shud-harness/dsh-shud-core";
import { pollFixture, readRecord } from "./poll-shud/test-harness.ts";
import { collectedWake, deliveredWake, expectWakeEvidence } from "./wake-shud/test-harness.ts";

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

test.each([
  "run identity",
  "RunRecord identity",
  "RunRecord payload",
  "RunRecord symlink",
  "resolved Session",
] as const)(
  "an invalid %s cannot authorize a wake while a healthy owner continues normally",
  async (kind) => {
    const h = await pollFixture(0, "held", "absent");
    let restoreResolve: (() => void) | undefined;
    try {
      const bad = await collectedWake(h);
      const metadataPath = join(bad.running.run_dir, "run-job.json");
      const record = await readRecord(bad.running.run_dir);
      const ids = generateRunIdentifiers();
      if (kind === "run identity")
        await io.writeFile(metadataPath, JSON.stringify({ ...record, run_id: ids.run_id }));
      if (
        kind === "RunRecord identity" ||
        kind === "RunRecord payload" ||
        kind === "RunRecord symlink"
      ) {
        if (kind === "RunRecord symlink") {
          const target = join(h.root, "foreign-result.json");
          await io.writeFile(target, JSON.stringify(bad.result));
          await io.rm(bad.resultPath);
          await io.symlink(target, bad.resultPath);
        } else {
          await io.writeFile(
            bad.resultPath,
            JSON.stringify({
              ...bad.result,
              ...(kind === "RunRecord identity"
                ? { job_id: ids.job_id }
                : { exit_class: "PRIVATE_INVALID_EXIT_CLASS" }),
            }),
          );
        }
        // Even a valid capped diagnostic cannot relabel invalid committed evidence as failure.
        await io.writeFile(
          join(bad.running.run_dir, "collect-error.json"),
          JSON.stringify({
            attempts: MAX_COLLECT_ATTEMPTS,
            at: new Date(bad.origin).toISOString(),
            last_error: "SHUD collect output scan: SYMLINK",
          }),
        );
      }
      const resultBytes = await io.readFile(bad.resultPath);
      const resultMtime = (await io.stat(bad.resultPath, { bigint: true })).mtimeNs;
      await h.mountSessionController();
      if (kind === "resolved Session") {
        const resolve = h.ctx.sessionController.resolveAgent.bind(h.ctx.sessionController);
        const other = await resolve(h.otherId);
        if ("error" in other) throw new Error("The real alternate fixture Session did not resolve");
        const spy = vi
          .spyOn(h.ctx.sessionController, "resolveAgent")
          .mockImplementation(async (id) => (id === h.ownerId ? other : resolve(id)));
        restoreResolve = () => spy.mockRestore();
      }
      // A real healthy run on the same registry proves optional delivery is active, rather than
      // allowing absence of the service to make the negative notification oracle vacuous.
      h.request.owner_session = h.otherId;
      const healthy = await collectedWake(h);
      await deliveredWake(h.registry, healthy.running.run_dir);
      await h.registry.pollOnce();
      expect(h.followups).toHaveLength(1);
      expect(h.followups[0].sessionId).toBe(h.otherId);
      const text = h.followups[0].message.content
        .flatMap((block) => (block.type === "text" ? [block.text] : []))
        .join("\n");
      expect(text).toContain(healthy.running.run_id);
      expect(text).not.toContain(bad.running.run_id);
      expect(h.flushes).toEqual([h.otherId]);
      expect((await readRecord(bad.running.run_dir)).notify.status).toBe("pending");
      expect(h.registry.indexes.read()).toEqual({
        active: [bad.entry],
        completed: [healthy.entry],
      });
      expect(await io.readFile(bad.resultPath)).toEqual(resultBytes);
      expect((await io.stat(bad.resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
      if (kind === "RunRecord symlink")
        expect((await io.lstat(bad.resultPath)).isSymbolicLink()).toBe(true);
      expect(h.errors.length).toBeGreaterThan(0);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_");
      expect(h.sessionEvents.filter((event) => event.type === "job/settled")).toEqual([]);
      await expectWakeEvidence(healthy);
    } finally {
      restoreResolve?.();
      await h.close();
    }
  },
  15000,
);
