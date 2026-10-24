import { mkdirSync, readFileSync, unlinkSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { activeGroup, terminateGroup } from "../../dsh-shud-jobs/src/detached-shud/test-harness.ts";
import { waitForEvidence } from "../../dsh-shud-jobs/src/poll-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";

test("actual native startup rolls back processes, registration and files when publication hits a directory", async () => {
  const h = await createToolHarness();
  let pid: number | undefined;
  let runDir: string | undefined;
  try {
    h.ctx.jobs.events.subscribe({ owners: "all" }, (event) => {
      if (event.type !== "registered") return;
      const entry = h.registry.indexes.read().active[0];
      if (!entry) throw new Error("Native registration preceded the active index");
      runDir = entry.run_dir;
      // A real external filesystem obstruction, after the genuine held solver has started.
      waitForEvidence(runDir, "invocation.json");
      pid = Number(readFileSync(join(runDir, "wrapper.pid"), "utf8"));
      expect(Number.isSafeInteger(pid)).toBe(true);
      expect(activeGroup(pid)).toContain(pid);
      const metadata = join(runDir, "run-job.json");
      unlinkSync(metadata);
      mkdirSync(metadata);
    });
    const result = await h.call({ input_dir: h.inputDir });
    expect(result.isError).toBe(true);
    if (!result.isError) throw new Error("Blocked metadata publication unexpectedly succeeded");
    expect(result.error.message).toMatch(/EISDIR|directory/iu);
    if (pid === undefined || runDir === undefined)
      throw new Error("Native rollback fault was not reached");
    expect(activeGroup(pid)).toEqual([]);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await readdir(join(h.cwd, "runs"))).toEqual([]);
    await expect(readdir(runDir)).rejects.toMatchObject({ code: "ENOENT" });
    for (const [path, original] of Object.entries(h.originals)) {
      expect(await readFile(join(h.inputDir, path))).toEqual(original);
    }
  } finally {
    if (pid !== undefined) await terminateGroup(pid);
    await h.dispose();
  }
}, 15_000);
