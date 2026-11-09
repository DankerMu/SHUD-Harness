import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { COLLECT_RETRY_INTERVAL_MS } from "@shud-harness/dsh-shud-core";
import { pollFixture, readRecord } from "./poll-shud/test-harness.ts";
import {
  existingResult,
  expectAbsent,
  expectMetricsBound,
  readLedger,
  readResult,
  seedMetricsRun,
} from "./collect-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const NOW = Date.parse("2026-10-23T03:15:00.000Z");
beforeEach(() => {
  // Explicit polls are the only writers; only wall-clock accounting is controlled.
  vi.useFakeTimers({ toFake: ["Date", "setInterval", "clearInterval"] });
  vi.setSystemTime(NOW);
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
});
afterEach(() => {
  vi.mocked(io.rename).mockImplementation(actualIo.rename);
  vi.useRealTimers();
});

test("a RunRecord write failure after metrics publication retries once and rewrites identical metrics bytes", async () => {
  const h = await pollFixture();
  let failRecord = "";
  vi.mocked(io.rename).mockImplementation(async (source, target) => {
    if (failRecord && target === failRecord)
      throw Object.assign(new Error("PRIVATE_RECORD_WRITE_662"), { code: "EIO" });
    await actualIo.rename(source, target);
  });
  try {
    const job = await seedMetricsRun(h, {}, (record) => {
      failRecord = join(record.run_dir, "run-record.json");
    });
    await h.registry.pollOnce();
    const ledgerPath = join(job.run_dir, "collect-error.json");
    expect(await readLedger(job.run_dir)).toMatchObject({ attempts: 1 });
    await expectAbsent(failRecord);
    const metricsPath = join(job.run_dir, "metrics.json");
    const firstMetrics = await io.readFile(metricsPath);
    const ledgerBytes = await io.readFile(ledgerPath);
    const ledgerMtime = (await io.stat(ledgerPath, { bigint: true })).mtimeNs;
    failRecord = "";
    vi.setSystemTime(NOW + COLLECT_RETRY_INTERVAL_MS);
    await h.registry.pollOnce();
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    const result = await readResult(job.run_dir);
    const { bytes } = await expectMetricsBound(result, job.run_dir);
    expect(bytes).toEqual(firstMetrics);
    expect(await io.readFile(ledgerPath)).toEqual(ledgerBytes);
    expect((await io.stat(ledgerPath, { bigint: true })).mtimeNs).toBe(ledgerMtime);
    expect(h.errors.join("\n")).not.toContain("PRIVATE_RECORD_WRITE_662");
  } finally {
    await h.close();
  }
});

test("readonly collection computes and writes no metrics and pre-M5 records are not backfilled", async () => {
  const h = await pollFixture();
  try {
    const pending = await seedMetricsRun(h);
    await expect(h.registry.collectShud(pending.run_id, { readonly: true })).rejects.toThrow();
    await expectAbsent(join(pending.run_dir, "metrics.json"));
    const legacy = await seedMetricsRun(h, {}, (record) =>
      io.writeFile(join(record.run_dir, "run-record.json"), JSON.stringify(existingResult(record))),
    );
    for (const readonly of [false, true]) {
      expect(await h.registry.collectShud(legacy.run_id, { readonly })).toEqual(
        existingResult(legacy),
      );
      await expectAbsent(join(legacy.run_dir, "metrics.json"));
    }
    expect(existingResult(legacy).artifacts.metrics_summary).toBeNull();
  } finally {
    await h.close();
  }
});
