import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import type { RunJob } from "@shud-harness/dsh-shud-core";
import { serializeRunMetrics } from "@shud-harness/dsh-shud-records";
import { snapshotTree } from "../../dsh-shud-records/src/run-metrics-test-harness.ts";
import { pollFixture, readRecord } from "./poll-shud/test-harness.ts";
import { deliveredWake } from "./wake-shud/test-harness.ts";
import {
  expectAbsent,
  expectMetricsBound,
  expectUnavailableMetrics,
  NULL_HEALTH,
  readLedger,
  readResult,
  seedMetricsRun,
  wakeText,
  type CollectFixture,
} from "./collect-shud/test-harness.ts";

// Independent inventory of the closed-budget output tree (records wb-mini plus snow/canopy stores).
const OUTPUT_FILES = [
  "wbmini.eleveta.dat",
  "wbmini.elevetp.dat",
  "wbmini.elevprcp.dat",
  "wbmini.eleygw.dat",
  "wbmini.eleyic.dat",
  "wbmini.eleysnow.dat",
  "wbmini.eleysurf.dat",
  "wbmini.eleyunsat.dat",
  "wbmini.rivqdown.dat",
  "wbmini.rivystage.dat",
];
const datPath = (job: Pick<RunJob, "run_dir">, variable: string) =>
  join(job.run_dir, "output", "wbmini.out", `wbmini.${variable}.dat`);

/** Solver outputs, logs and the input copy, including bytes, identities and mtimes. */
function solverEvidence(runDir: string) {
  return {
    input: snapshotTree(join(runDir, "input")),
    output: snapshotTree(join(runDir, "output")),
    stdout: snapshotTree(join(runDir, "stdout.log")),
    stderr: snapshotTree(join(runDir, "stderr.log")),
  };
}

async function collectedAndWoken(h: CollectFixture, job: RunJob) {
  await deliveredWake(h.registry, job.run_dir);
  expect((await readRecord(job.run_dir)).status).toBe("collected");
  return readResult(job.run_dir);
}

test("a succeeded run publishes canonical metrics.json bound to the RunRecord digest without touching solver evidence", async () => {
  const h = await pollFixture(0, "held", "available");
  let before: ReturnType<typeof solverEvidence> | undefined;
  try {
    const job = await seedMetricsRun(h, {}, (record) => {
      before = solverEvidence(record.run_dir);
    });
    const result = await collectedAndWoken(h, job);
    expect(result).toMatchObject({ status: "succeeded", exit_code: 0, exit_class: "ok" });
    const { bytes, metrics } = await expectMetricsBound(result, job.run_dir);
    expect(metrics).toMatchObject({ status: "ok", reason: null });
    expect(bytes.toString("utf8")).toBe(serializeRunMetrics(metrics));
    expect(result.numerical_health).toMatchObject({
      cvode_failures: 2,
      negative_state_count: 0,
      max_solver_dt: null,
    });
    expect(Number.isFinite(result.numerical_health.water_balance_residual)).toBe(true);
    expect(result.artifacts.files.map((file) => file.path)).toEqual(OUTPUT_FILES);
    await expectAbsent(join(job.run_dir, "collect-error.json"));
    expect(solverEvidence(job.run_dir)).toEqual(before);
    const text = wakeText(h);
    expect(text).toContain(job.run_id);
    expect(text).not.toContain("metrics=");
  } finally {
    await h.close();
  }
}, 15000);

test.each([
  ["a truncated existing state .dat", "parse:output/wbmini.out/wbmini.eleygw.dat"],
  ["a missing rivqdown .dat", "missing_variable:rivqdown"],
] as const)(
  "%s yields unavailable metrics without failing, counting or delaying the collect",
  async (kind, reason) => {
    const h = await pollFixture(0, "held", "available");
    try {
      const job = await seedMetricsRun(h, {}, async (record) => {
        if (reason === "missing_variable:rivqdown") await io.rm(datPath(record, "rivqdown"));
        else await io.truncate(datPath(record, "eleygw"), 1000);
      });
      const result = await collectedAndWoken(h, job);
      await expectUnavailableMetrics(result, job.run_dir, reason);
      const text = wakeText(h);
      expect(text, kind).toContain("exit_class=ok");
      expect(text).not.toContain("metrics=");
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([
  ["missing eleyic output", "missing_variable:eleyic"],
  ["unreadable copy cfg.calib", "unreadable_input:input/wbmini/wbmini.cfg.calib"],
] as const)("%s keeps metrics ok and nulls only the residual", async (_kind, reason) => {
  const h = await pollFixture();
  try {
    const job = await seedMetricsRun(h, {}, async (record) => {
      if (reason === "missing_variable:eleyic") await io.rm(datPath(record, "eleyic"));
      else {
        const calib = join(record.run_dir, "input", "wbmini", "wbmini.cfg.calib");
        await io.rm(calib);
        await io.mkdir(calib);
      }
    });
    const result = await h.registry.collectShud(job.run_id);
    const { metrics } = await expectMetricsBound(result, job.run_dir);
    expect(metrics).toMatchObject({ status: "ok", reason: null });
    expect(metrics.numerical_health.reasons.water_balance_residual).toBe(reason);
    expect(metrics.flow.peak_flow_m3d).toBe(16.5);
    expect(result.numerical_health).toEqual({
      water_balance_residual: null,
      cvode_failures: 2,
      negative_state_count: 0,
      max_solver_dt: null,
    });
    expect(result).toMatchObject({ status: "succeeded", exit_class: "ok" });
    await expectAbsent(join(job.run_dir, "collect-error.json"));
  } finally {
    await h.close();
  }
});

test.each(["directory", "symlink"] as const)(
  "a metrics.json path occupied by a %s still publishes the record and reports metrics=write_failed",
  async (occupant) => {
    const h = await pollFixture(0, "held", "available");
    const ledger = JSON.stringify({
      attempts: 1,
      last_error: "SHUD collect output scan: EACCES",
      at: "2026-10-22T03:15:03.000Z",
    });
    let foreign = "";
    try {
      const job = await seedMetricsRun(h, {}, async (record) => {
        await io.writeFile(join(record.run_dir, "collect-error.json"), ledger);
        const path = join(record.run_dir, "metrics.json");
        if (occupant === "directory") await io.mkdir(path);
        else {
          foreign = join(h.root, "foreign-metrics.json");
          await io.writeFile(foreign, "foreign bytes");
          await io.symlink(foreign, path);
        }
      });
      const result = await collectedAndWoken(h, job);
      expect(result).toMatchObject({
        status: "succeeded",
        exit_code: 0,
        exit_class: "ok",
        artifacts: { metrics_summary: null },
        numerical_health: NULL_HEALTH,
      });
      expect(await io.readFile(join(job.run_dir, "collect-error.json"), "utf8")).toBe(ledger);
      expect((await readLedger(job.run_dir)).attempts).toBe(1);
      const occupied = await io.lstat(join(job.run_dir, "metrics.json"));
      if (occupant === "directory") expect(occupied.isDirectory()).toBe(true);
      else {
        expect(occupied.isSymbolicLink()).toBe(true);
        expect(await io.readFile(foreign, "utf8")).toBe("foreign bytes");
      }
      expect((await io.readdir(job.run_dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(wakeText(h)).toBe(
        `SHUD run ${job.run_id}: exit_class=ok; artifacts=${String(result.artifacts.files.length)}; metrics=write_failed.`,
      );
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([
  ["exit 19", { status: "failed", exit_code: 19 }, "cvode"],
  [
    "cancellation",
    { status: "cancelled", exit_code: null, cancel_requested_at: "2026-10-22T03:15:01.000Z" },
    "cancelled",
  ],
] as const)("a non-ok %s run writes no metrics.json", async (_kind, changes, exitClass) => {
  const h = await pollFixture();
  try {
    // seedTerminal publishes no exit file for a null code: a genuine no-exit cancellation.
    const job = await seedMetricsRun(h, changes);
    const result = await h.registry.collectShud(job.run_id);
    expect(result).toMatchObject({
      status: "failed",
      exit_class: exitClass,
      artifacts: { metrics_summary: null },
      numerical_health: NULL_HEALTH,
    });
    await expectAbsent(join(job.run_dir, "metrics.json"));
    await expectAbsent(join(job.run_dir, "collect-error.json"));
  } finally {
    await h.close();
  }
});

test("a committed record and its metrics are never recomputed after solver outputs change", async () => {
  const h = await pollFixture();
  try {
    const job = await seedMetricsRun(h);
    const first = await h.registry.collectShud(job.run_id);
    await expectMetricsBound(first, job.run_dir);
    const committed = ["run-record.json", "metrics.json"].map((name) => join(job.run_dir, name));
    const frozen = () => committed.map((path) => snapshotTree(path));
    const before = frozen();
    await io.writeFile(datPath(job, "rivqdown"), "rewritten after commit");
    await io.rm(datPath(job, "eleyic"));
    await h.registry.pollOnce();
    expect(await h.registry.collectShud(job.job_id)).toEqual(first);
    await h.registry.pollOnce();
    expect(await h.registry.collectShud(job.run_id)).toEqual(first);
    expect(frozen()).toEqual(before);
  } finally {
    await h.close();
  }
});
