import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { fileSnapshot, readCard } from "./analysis-create/test-harness.ts";
import { cardSnapshot, putCard, treeOrAbsent } from "./task-linked/test-harness.ts";
import { expectReportError } from "./report-workflow/test-harness.ts";
import {
  sensitivityHarness,
  type SensitivityHarness,
  type SensitivityRunKind,
} from "./report-sensitivity/test-harness.ts";

let h: SensitivityHarness;
beforeEach(async () => {
  h = await sensitivityHarness();
});
afterEach(async () => {
  vi.useRealTimers();
  await h.dispose();
});

/** Baseline plus PSET-2 and PSET-4 collected succeeded; PSET-3's only job is `kind`. */
async function batchWithPset3(kind: SensitivityRunKind) {
  const runs = [
    await h.seedRun("0001", "PSET-1", "succeeded"),
    await h.seedRun("0002", "PSET-2", "succeeded"),
    await h.seedRun("0003", "PSET-3", kind),
    await h.seedRun("0004", "PSET-4", "succeeded"),
  ];
  h.link(runs);
  return runs;
}

function closureFailures(message: string): unknown {
  const match = /^report_generate closure failed: (.*)$/su.exec(message);
  if (!match) throw new Error(`Not a closure failure: ${message}`);
  return JSON.parse(match[1]) as unknown;
}

test.each(["uncollected-failed", "exhausted"] as const)(
  "a non-baseline %s job reaches the predicate as clause 3 without any collection",
  async (kind) => {
    const runs = await batchWithPset3(kind);
    const target = runs[2].job;
    const runBefore = await treeOrAbsent(target.run_dir);
    const card = await cardSnapshot(h);
    const collect = vi.spyOn(h.registry, "collectShud");
    const message = expectReportError(await h.generate(), /closure failed/u);
    expect(closureFailures(message)).toEqual([
      {
        clause: 3,
        reason: "inadmissible_effective_run",
        analysis_plan_id: h.plan,
        job_id: target.job_id,
        parameter_set_id: "PSET-3",
      },
    ]);
    expect(collect.mock.calls).toEqual(
      [0, 1, 3].map((index) => [runs[index].job.job_id, { readonly: true }]),
    );
    expect(await treeOrAbsent(target.run_dir)).toEqual(runBefore);
    expect(fs.existsSync(join(target.run_dir, "run-record.json"))).toBe(false);
    expect(fs.existsSync(join(target.run_dir, "collect-error.json"))).toBe(kind === "exhausted");
    expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
    expect(await cardSnapshot(h)).toEqual(card);
  },
);

test("a running sensitivity job fails clause 1 as not terminal", async () => {
  const runs = await batchWithPset3("running");
  const message = expectReportError(await h.generate(), /closure failed/u);
  expect(closureFailures(message)).toEqual([
    {
      clause: 1,
      reason: "job_not_terminal",
      analysis_plan_id: h.plan,
      job_id: runs[2].job.job_id,
      parameter_set_id: "PSET-3",
    },
  ]);
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
});

test("a corrupt collect ledger fails as collect evidence before closure", async () => {
  const runs = await batchWithPset3("succeeded");
  const ledger = join(runs[1].job.run_dir, "collect-error.json");
  fs.writeFileSync(ledger, "PRIVATE_LEDGER_667");
  const runsBefore = await treeOrAbsent(join(h.cwd, "runs"));
  const message = expectReportError(
    await h.generate(),
    new RegExp(`collect evidence failed for ${runs[1].job.job_id}`, "u"),
  );
  expect(message).not.toContain("PRIVATE_");
  expect(message).not.toContain("closure");
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
  expect(await treeOrAbsent(join(h.cwd, "runs"))).toEqual(runsBefore);
});

test("a failed baseline names clause 3 and writes no report file or card change", async () => {
  const runs = [
    await h.seedRun("0001", "PSET-1", "failed"),
    await h.seedRun("0002", "PSET-2", "succeeded"),
    await h.seedRun("0003", "PSET-3", "succeeded"),
    await h.seedRun("0004", "PSET-4", "succeeded"),
  ];
  h.link(runs);
  fs.mkdirSync(join(h.cwd, "reports"));
  const reports = await treeOrAbsent(join(h.cwd, "reports"));
  const card = await cardSnapshot(h);
  const message = expectReportError(await h.generate(), /closure failed/u);
  expect(closureFailures(message)).toEqual([
    {
      clause: 3,
      reason: "inadmissible_effective_run",
      analysis_plan_id: h.plan,
      job_id: runs[0].job.job_id,
      parameter_set_id: "PSET-1",
    },
  ]);
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toEqual(reports);
  expect(fs.readdirSync(join(h.cwd, "reports"))).toEqual([]);
  expect(await cardSnapshot(h)).toEqual(card);
});

test("a failed baseline after a publishing reconcile keeps only the reconcile and plan links", async () => {
  const runs = [
    await h.seedRun("0001", "PSET-1", "failed"),
    await h.seedRun("0002", "PSET-2", "succeeded"),
    await h.seedRun("0003", "PSET-3", "succeeded"),
    await h.seedRun("0004", "PSET-4", "succeeded"),
  ];
  const stale = putCard(h, {
    ...h.link(runs),
    linked_jobs: [runs[0].job.job_id],
    updated_at: "2026-11-08T09:00:00.000Z",
  });
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T10:00:00.000Z"));
  expectReportError(await h.generate(), /"clause":3/u);
  expect(readCard(h)).toEqual({
    ...stale,
    linked_jobs: runs.map(({ job }) => job.job_id),
    linked_analyses: [h.plan],
    updated_at: "2026-11-08T10:00:00.000Z",
  });
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
});

test("an unlinked plan left by a write-back failure is never linked by report reconcile", async () => {
  const runs = [
    await h.seedRun("0001", "PSET-1", "succeeded"),
    await h.seedRun("0002", "PSET-2", "succeeded"),
    await h.seedRun("0003", "PSET-3", "succeeded"),
    await h.seedRun("0004", "PSET-4", "succeeded"),
  ];
  // The plan exists on disk for this card, but analysis_create never linked it.
  const stale = putCard(h, {
    ...h.link(runs),
    linked_jobs: [],
    linked_analyses: [],
    updated_at: "2026-11-08T09:00:00.000Z",
  });
  const plan = fileSnapshot(h.planPath);
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-11-08T10:00:00.000Z"));
  const message = expectReportError(await h.generate(), /closure failed/u);
  expect(closureFailures(message)).toEqual([{ clause: 0, reason: "invalid_plan_link" }]);
  // The publishing reconcile repaired job links and refreshed updated_at, nothing else.
  expect(readCard(h)).toEqual({
    ...stale,
    linked_jobs: runs.map(({ job }) => job.job_id),
    linked_analyses: [],
    updated_at: "2026-11-08T10:00:00.000Z",
  });
  expect(fileSnapshot(h.planPath)).toEqual(plan);
  expect(await treeOrAbsent(join(h.cwd, "reports"))).toBeNull();
});
