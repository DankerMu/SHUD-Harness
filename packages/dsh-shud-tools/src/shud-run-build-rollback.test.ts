import { mkdir, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { fileSnapshot } from "../../dsh-shud-jobs/src/submit-shud-build/test-harness.ts";
import { snapshotTree } from "../../dsh-shud-jobs/src/submit-shud/test-harness.ts";
import { createToolHarness } from "./test-harness.ts";
import { seedBuild } from "./shud-run-build/test-harness.ts";
import { cardPath, expectToolError, plannedCard, putCard } from "./task-linked/test-harness.ts";

test.each(
  ["unknown", "digest mismatch"].flatMap((fault) =>
    [false, true].map((linked) => ({ fault, linked })),
  ),
)("$fault build leaves no run or capture; linked=$linked", async ({ fault, linked }) => {
  const h = await createToolHarness({ pumpPollMs: 60_000 });
  const submit = vi.spyOn(h.registry, "submitShud");
  try {
    const { build, buildDir, source, recordPath } = await seedBuild(h.cwd);
    if (fault === "digest mismatch") await writeFile(source, "#!/bin/sh\nexit 71\n");
    if (linked) putCard(h, plannedCard({ task_id: build.task_id }));
    const roots = ["runs", "stacks", "provenance"].map((name) => join(h.cwd, name));
    for (const root of roots) {
      await mkdir(root);
      await writeFile(join(root, "unrelated-sentinel"), "retain unrelated bytes\n");
    }
    const trees = await Promise.all(roots.map(snapshotTree));
    const paths = [
      source,
      recordPath,
      h.shudBin,
      ...Object.keys(h.originals).map((name) => join(h.inputDir, name)),
      ...(linked ? [cardPath(h, build.task_id)] : []),
    ];
    const snapshots = await Promise.all(paths.map(fileSnapshot));
    const buildId = fault === "unknown" ? "BUILD-20261102T090000-ffff" : build.build_id;
    const message = expectToolError(
      await h.call({
        input_dir: h.inputDir,
        build_id: buildId,
        threads: 1,
        ...(linked ? { task_id: build.task_id } : {}),
      }),
      fault === "unknown" ? /build|ENOENT/iu : /sha256|digest|mismatch/iu,
    );
    expect(message).toContain(buildId);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await Promise.all(roots.map(snapshotTree))).toEqual(trees);
    expect(await Promise.all(paths.map(fileSnapshot))).toEqual(snapshots);
    expect((await readdir(buildDir)).sort()).toEqual(["build-record.json", "shud"]);
  } finally {
    submit.mockRestore();
    await h.dispose();
  }
});
