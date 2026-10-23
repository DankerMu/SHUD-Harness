import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { pollFixture, readRecord } from "./poll-shud/test-harness.ts";
import {
  expectAbsent,
  outputRoot,
  publishExit,
  readLedger,
  readResult,
  seedTerminal,
} from "./collect-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, readdir: vi.fn(actual.readdir), readFile: vi.fn(actual.readFile) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const NOW = Date.parse("2026-10-23T03:15:00.000Z");
const fault = { output: "", exit: "", denied: false, scans: 0, exitReads: 0 };
beforeEach(() => {
  // Only wall-clock accounting is controlled; the real dispatcher and native process identity stay live.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  fault.output = "";
  fault.exit = "";
  fault.denied = false;
  fault.scans = 0;
  fault.exitReads = 0;
  vi.mocked(io.readdir)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.output) {
        fault.scans++;
        if (fault.denied)
          throw Object.assign(new Error("transient output access failure"), { code: "EACCES" });
      }
      return actualIo.readdir(...args);
    });
  vi.mocked(io.readFile)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.exit) fault.exitReads++;
      return actualIo.readFile(...args);
    });
});
afterEach(() => {
  vi.useRealTimers();
});

test("abc exit evidence consumes exactly three automatic attempts at durable ten-second boundaries and manual retry can recover after the cap", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h, { status: "failed", exit_code: null }, async (record) => {
      await publishExit(record, "abc");
      fault.exit = join(record.run_dir, "exit_code");
    });
    const api = h.registry;
    await h.registry.pollOnce();
    const first = await readLedger(job.run_dir);
    expect(first.attempts).toBe(1);
    expect(first.at).toBe("2026-10-23T03:15:00.000Z");
    const journal = join(job.run_dir, "collect-error.json");
    const firstBytes = await io.readFile(journal);
    const firstStat = await io.stat(journal, { bigint: true });
    const reads = fault.exitReads;
    vi.setSystemTime(NOW + 9999);
    await h.registry.pollOnce();
    expect(await io.readFile(journal)).toEqual(firstBytes);
    expect((await io.stat(journal, { bigint: true })).mtimeNs).toBe(firstStat.mtimeNs);
    expect(fault.exitReads).toBe(reads);
    vi.setSystemTime(NOW - 1000);
    await h.registry.pollOnce();
    expect(await io.readFile(journal)).toEqual(firstBytes);
    expect(fault.exitReads).toBe(reads);
    vi.setSystemTime(NOW + 10000);
    await h.registry.pollOnce();
    expect((await readLedger(job.run_dir)).attempts).toBe(2);
    vi.setSystemTime(NOW + 19999);
    await h.registry.pollOnce();
    expect((await readLedger(job.run_dir)).attempts).toBe(2);
    vi.setSystemTime(NOW + 20000);
    await h.registry.pollOnce();
    expect((await readLedger(job.run_dir)).attempts).toBe(3);
    const capped = await io.readFile(journal);
    const cappedStat = await io.stat(journal, { bigint: true });
    const cappedReads = fault.exitReads;
    vi.setSystemTime(NOW + 3600000);
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(await io.readFile(journal)).toEqual(capped);
    expect(fault.exitReads).toBe(cappedReads);
    expect((await readRecord(job.run_dir)).status).toBe("failed");
    await expectAbsent(join(job.run_dir, "run-record.json"));
    await publishExit(job, "0\n");
    const result = await api.collectShud(job.job_id);
    expect(result).toMatchObject({ exit_code: 0, exit_class: "ok", status: "succeeded" });
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    expect(await io.readFile(journal)).toEqual(capped);
    expect((await io.stat(journal, { bigint: true })).mtimeNs).toBe(cappedStat.mtimeNs);
    expect(h.producers).toEqual([]);
  } finally {
    await h.close();
  }
});

test("repaired output permissions retry no earlier than ten seconds and retain attempts=1 history on success", async () => {
  const h = await pollFixture();
  try {
    const job = await seedTerminal(h, {}, async (record) => {
      await io.writeFile(join(outputRoot(record), "artifact.dat"), "abc");
      fault.output = outputRoot(record);
      fault.denied = true;
    });
    await h.registry.pollOnce();
    expect((await readLedger(job.run_dir)).attempts).toBe(1);
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
    const journal = join(job.run_dir, "collect-error.json");
    const original = await io.readFile(journal);
    const stat = await io.stat(journal, { bigint: true });
    const scans = fault.scans;
    fault.denied = false;
    vi.setSystemTime(NOW + 9999);
    await h.registry.pollOnce();
    expect(fault.scans).toBe(scans);
    await expectAbsent(join(job.run_dir, "run-record.json"));
    vi.setSystemTime(NOW + 10000);
    await h.registry.pollOnce();
    const result = await readResult(job.run_dir);
    expect(result.artifacts.files).toEqual([{ path: "artifact.dat", size_bytes: 3 }]);
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    expect(await io.readFile(journal)).toEqual(original);
    expect((await io.stat(journal, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    expect((await readLedger(job.run_dir)).attempts).toBe(1);
  } finally {
    fault.denied = false;
    await h.close();
  }
});

const malformedLedgers: Record<string, string> = {
  json: "{not-json",
  negative: JSON.stringify({
    attempts: -1,
    last_error: "prior failure",
    at: "2026-10-23T03:15:00.000Z",
  }),
  fractional: JSON.stringify({
    attempts: 1.5,
    last_error: "prior failure",
    at: "2026-10-23T03:15:00.000Z",
  }),
  unsafe: JSON.stringify({
    attempts: 9007199254740992,
    last_error: "prior failure",
    at: "2026-10-23T03:15:00.000Z",
  }),
  "string-counter": JSON.stringify({
    attempts: "1",
    last_error: "prior failure",
    at: "2026-10-23T03:15:00.000Z",
  }),
  "empty-diagnostic": JSON.stringify({
    attempts: 1,
    last_error: "",
    at: "2026-10-23T03:15:00.000Z",
  }),
  "bad-time": JSON.stringify({ attempts: 1, last_error: "prior failure", at: "yesterday" }),
  "invalid-calendar": JSON.stringify({
    attempts: 1,
    last_error: "prior failure",
    at: "2026-02-30T03:15:00.000Z",
  }),
  "non-UTC-offset": JSON.stringify({
    attempts: 1,
    last_error: "prior failure",
    at: "2026-10-23T03:15:00+01:00",
  }),
  "missing-field": JSON.stringify({ attempts: 1, last_error: "prior failure" }),
  "unknown-field": JSON.stringify({
    attempts: 1,
    last_error: "prior failure",
    at: "2026-10-23T03:15:00.000Z",
    extra: "PRIVATE_LEDGER_PAYLOAD_308",
  }),
};

test.each(Object.entries(malformedLedgers))(
  "malformed %s retry ledger is preserved without reopening the generation budget",
  async (_kind, bytes) => {
    const h = await pollFixture();
    let mtime = 0n;
    try {
      const job = await seedTerminal(h, {}, async (record) => {
        const journal = join(record.run_dir, "collect-error.json");
        await io.writeFile(journal, bytes);
        mtime = (await io.stat(journal, { bigint: true })).mtimeNs;
        fault.output = outputRoot(record);
        fault.exit = join(record.run_dir, "exit_code");
      });
      const api = h.registry;
      vi.setSystemTime(NOW + 3600000);
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      await expect(api.collectShud(job.run_id)).rejects.toThrow();
      const journal = join(job.run_dir, "collect-error.json");
      expect(await io.readFile(journal, "utf8")).toBe(bytes);
      expect((await io.stat(journal, { bigint: true })).mtimeNs).toBe(mtime);
      expect(fault.scans).toBe(0);
      expect(fault.exitReads).toBe(0);
      expect(await readRecord(job.run_dir)).toEqual(job);
      await expectAbsent(join(job.run_dir, "run-record.json"));
      expect(h.errors.length).toBeGreaterThan(0);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_LEDGER_PAYLOAD_308");
    } finally {
      await h.close();
    }
  },
);
