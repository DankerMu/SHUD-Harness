import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { inspect } from "node:util";
import { expect, test } from "vitest";
import { classifyRunExit, type RunJob } from "@shud-harness/dsh-shud-core";
import { observe, snapshotQueryTree } from "./list-run-jobs/test-harness.ts";
import { names as listing } from "./submit-shud-build/test-harness.ts";
import {
  DUPLICATE,
  ledger,
  OTHER_PLAN,
  PRIVATE_LEDGER,
  psetFixture,
  type SeedEvidence,
} from "./submit-shud-pset/test-harness.ts";

type Fixture = Awaited<ReturnType<typeof psetFixture>>;
type Row = { changes: Partial<RunJob> } & SeedEvidence;

const failedRecord = { status: "failed", exit_code: 1, exit_class: classifyRunExit(1) } as const;

/** Workspace bytes, run listing and both indexes: a rejection must leave all of them unchanged. */
async function evidence(h: Fixture) {
  return {
    tree: await snapshotQueryTree(h.cwd),
    runs: await listing(join(h.cwd, "runs")),
    indexes: h.registry.indexes.read(),
  };
}

const nonFailed: Record<string, Row> = {
  "persisted created job (lost in-flight table after restart)": { changes: { status: "created" } },
  "persisted submitted job": { changes: { status: "submitted" } },
  "terminal uncollected succeeded below the collect limit": {
    changes: { status: "succeeded", exit_code: 0 },
    ledger: ledger(2),
  },
  "collected job whose RunRecord succeeded": {
    changes: { status: "collected", exit_code: 0 },
    record: {},
    ledger: ledger(1),
    index: "completed",
  },
};

test.each(Object.entries(nonFailed))(
  "%s rejects a same-pset submission with zero side effects",
  async (_name, { changes, ...seeded }) => {
    const h = await psetFixture();
    try {
      await h.seed("a001", changes, seeded);
      const before = await evidence(h);
      await expect(h.submit()).rejects.toThrow(DUPLICATE);
      expect(await evidence(h)).toEqual(before);
    } finally {
      await h.close();
    }
  },
  20000,
);

const failed: Record<string, Row> = {
  "RunJob failed": { changes: { status: "failed", exit_code: 1 } },
  "RunJob cancelled": { changes: { status: "cancelled" }, ledger: ledger(1) },
  "uncollected succeeded with an exhausted ledger": {
    changes: { status: "succeeded", exit_code: 0 },
    ledger: ledger(3),
  },
  "collected RunRecord succeeded with an exhausted ledger (recorded decision)": {
    changes: { status: "collected", exit_code: 0 },
    record: {},
    ledger: ledger(4),
    index: "completed",
  },
  "collected RunRecord failed": {
    changes: { status: "collected", exit_code: 1 },
    record: failedRecord,
    index: "completed",
  },
};

test.each(Object.entries(failed))(
  "only a prior %s job accepts the resubmission and keeps its files byte-identical",
  async (_name, { changes, ...seeded }) => {
    const h = await psetFixture();
    try {
      const prior = await h.seed("a001", changes, seeded);
      const before = await snapshotQueryTree(prior.run_dir);
      const record = await h.submit();
      expect([record.analysis_plan_id, record.parameter_set_id]).toEqual([
        prior.analysis_plan_id,
        "PSET-2",
      ]);
      expect(JSON.parse(await io.readFile(join(record.run_dir, "run-job.json"), "utf8"))).toEqual(
        record,
      );
      expect(await listing(join(h.cwd, "runs"))).toEqual([prior.run_id, record.run_id].sort());
      expect(await snapshotQueryTree(prior.run_dir)).toEqual(before);
      // The held fake SHUD publishes its barrier asynchronously; settle it before the snapshot.
      await expect
        .poll(() => fs.existsSync(join(record.run_dir, "submission-barrier.json")))
        .toBe(true);
      // The failed job indexed first must not hide the accepted running one from the check.
      const accepted = await evidence(h);
      await expect(h.submit()).rejects.toThrow(DUPLICATE);
      expect(await evidence(h)).toEqual(accepted);
    } finally {
      await h.close();
    }
  },
  20000,
);

test("a different pset, a different plan and an unbound submission are not checked against PSET-2", async () => {
  const h = await psetFixture();
  try {
    const prior = await h.seed(
      "a001",
      { status: "collected", exit_code: 0 },
      { record: {}, index: "completed" },
    );
    const before = await snapshotQueryTree(prior.run_dir);
    const accepted = [
      await h.submit({ parameter_set_id: "PSET-3" }),
      await h.submit({ analysis_plan_id: OTHER_PLAN }),
      await h.submit(h.unbound),
    ];
    expect(accepted.map((job) => [job.analysis_plan_id, job.parameter_set_id])).toEqual([
      [prior.analysis_plan_id, "PSET-3"],
      [OTHER_PLAN, "PSET-2"],
      [null, null],
    ]);
    expect(await snapshotQueryTree(prior.run_dir)).toEqual(before);
    await expect(h.submit()).rejects.toThrow(DUPLICATE);
  } finally {
    await h.close();
  }
}, 30000);

const corrupt: Record<string, { row: Row; damage?: (job: RunJob) => void }> = {
  "unparsable ledger of a non-failed job": {
    row: { changes: { status: "succeeded", exit_code: 0 }, ledger: PRIVATE_LEDGER },
  },
  "invalid ledger of an already-failed job": {
    row: { changes: { status: "failed", exit_code: 1 }, ledger: { ...ledger(3), attempts: "3" } },
  },
  "symlinked ledger": {
    row: { changes: { status: "succeeded", exit_code: 0 } },
    damage: (job) => {
      const outside = join(job.run_dir, "..", "..", "outside.json");
      fs.writeFileSync(outside, JSON.stringify(ledger(3)));
      fs.symlinkSync(outside, join(job.run_dir, "collect-error.json"));
    },
  },
  "collected job without a RunRecord": {
    row: { changes: { status: "collected", exit_code: 0 }, index: "completed" },
  },
  "collected job with an unparsable RunRecord": {
    row: {
      changes: { status: "collected", exit_code: 1 },
      record: PRIVATE_LEDGER,
      index: "completed",
    },
  },
  "collected job whose RunRecord names another run": {
    row: {
      changes: { status: "collected", exit_code: 1 },
      record: { ...failedRecord, run_id: "RUN-20261022T031500-ffff" },
    },
  },
  "unparsable indexed RunJob of another pset": {
    row: { changes: { parameter_set_id: "PSET-4" } },
    damage: (job) => fs.writeFileSync(join(job.run_dir, "run-job.json"), PRIVATE_LEDGER),
  },
  "schema-invalid indexed RunJob": {
    row: { changes: {} },
    damage: (job) =>
      fs.writeFileSync(
        join(job.run_dir, "run-job.json"),
        JSON.stringify({ ...job, status: "running" }),
      ),
  },
};

test.each(Object.entries(corrupt))(
  "%s fails the submission explicitly instead of treating it as failed",
  async (_name, { row: { changes, ...seeded }, damage }) => {
    const h = await psetFixture();
    try {
      const job = await h.seed("a001", changes, seeded);
      damage?.(job);
      const before = await evidence(h);
      const outcome = await observe(h.submit());
      expect(outcome.ok).toBe(false);
      if (outcome.ok) throw new Error("Corrupt registry state was treated as a failed job");
      expect(outcome.error).toBeInstanceOf(Error);
      if (!(outcome.error instanceof Error)) throw new Error("Missing controlled error");
      expect(outcome.error.message).toContain(job.run_id);
      expect(outcome.error.message).not.toMatch(DUPLICATE);
      expect(inspect(outcome.error, { depth: 12 })).not.toContain(PRIVATE_LEDGER);
      expect(await evidence(h)).toEqual(before);
    } finally {
      await h.close();
    }
  },
  20000,
);
