import * as io from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import type { RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import {
  existingResult,
  expectAbsent,
  outputRoot,
  readLedger,
  readResult,
  seedTerminal,
  type CollectFixture,
} from "./collect-shud/test-harness.ts";
import { installFakeShud } from "./detached-shud/test-harness.ts";
import { pollFixture, readRecord, waitForOwnershipRelease } from "./poll-shud/test-harness.ts";
import { persisted } from "./state-indexes/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

const observation = vi.hoisted(() => ({ exit: "", output: "", exitReads: 0, scans: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    readFile: vi.fn(actual.readFile),
    readdir: vi.fn(actual.readdir),
    rename: vi.fn(actual.rename),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const NOW = "2026-10-23T03:15:00.000Z";
beforeEach(() => {
  observation.exit = "";
  observation.output = "";
  observation.exitReads = 0;
  observation.scans = 0;
  vi.mocked(io.readFile)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === observation.exit) observation.exitReads++;
      return actualIo.readFile(...args);
    });
  vi.mocked(io.readdir)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === observation.output) observation.scans++;
      return actualIo.readdir(...args);
    });
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  // Readiness must come from awaited startup, not either owner's normal interval ticks.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval", "Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

interface FileEvidence {
  bytes: Buffer;
  mtime: bigint;
}

async function captureFile(path: string): Promise<FileEvidence> {
  return {
    bytes: await io.readFile(path),
    mtime: (await io.stat(path, { bigint: true })).mtimeNs,
  };
}

async function expectUnchanged(path: string, evidence: FileEvidence): Promise<void> {
  expect(await io.readFile(path)).toEqual(evidence.bytes);
  expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(evidence.mtime);
}

async function stoppedTerminal(
  h: CollectFixture,
  changes: Partial<RunJob> = {},
  prepare?: (record: RunJob) => Promise<void>,
): Promise<RunJob> {
  await installFakeShud(h.shudBin, 0);
  const record = await seedTerminal(h, changes, prepare);
  await h.fiber.dispose();
  await waitForOwnershipRelease(h.stateDir);
  return record;
}

test("cancelled but not collected is recovered during apply and remains immutable on another restart", async () => {
  const h = await pollFixture();
  try {
    const job = await stoppedTerminal(h, {
      status: "cancelled",
      exit_code: null,
      cancel_requested_at: "2026-10-22T03:15:01.000Z",
    });
    const first = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(await readResult(job.run_dir)).toMatchObject({
      run_id: job.run_id,
      job_id: job.job_id,
      exit_code: null,
      exit_class: "cancelled",
    });
    expect(await readRecord(job.run_dir)).toEqual({ ...job, status: "collected" });
    const resultPath = join(job.run_dir, "run-record.json");
    const metadataPath = join(job.run_dir, "run-job.json");
    const result = await captureFile(resultPath);
    const metadata = await captureFile(metadataPath);
    await first.dispose();
    await waitForOwnershipRelease(h.stateDir);

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    await expectUnchanged(resultPath, result);
    await expectUnchanged(metadataPath, metadata);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
    await expectAbsent(join(job.run_dir, "wrapper.pid"));
    await expectAbsent(join(job.run_dir, "invocation.json"));
  } finally {
    await h.close();
  }
}, 15000);

test.each(["capped", "recent", "corrupt"] as const)(
  "startup repairs a committed record before consulting its %s generation ledger",
  async (kind) => {
    const h = await pollFixture();
    try {
      const ledgerBytes =
        kind === "corrupt"
          ? "{not-json\n"
          : JSON.stringify({
              attempts: kind === "capped" ? 3 : 1,
              last_error: "prior generation failure",
              at: kind === "recent" ? NOW : "2026-10-22T03:15:00.000Z",
            });
      const job = await stoppedTerminal(h, {}, async (record) => {
        const resultPath = join(record.run_dir, "run-record.json");
        const ledgerPath = join(record.run_dir, "collect-error.json");
        await io.writeFile(resultPath, JSON.stringify(existingResult(record)));
        await io.writeFile(ledgerPath, ledgerBytes);
        await io.writeFile(join(outputRoot(record), "after-commit.dat"), "later output\n");
        const oldTime = new Date("2026-10-21T03:15:00.000Z");
        await io.utimes(resultPath, oldTime, oldTime);
        await io.utimes(ledgerPath, oldTime, oldTime);
      });
      const resultPath = join(job.run_dir, "run-record.json");
      const ledgerPath = join(job.run_dir, "collect-error.json");
      const result = await captureFile(resultPath);
      const ledger = await captureFile(ledgerPath);
      observation.exit = join(job.run_dir, "exit_code");
      observation.output = outputRoot(job);
      for (let restart = 0; restart < 2; restart++) {
        const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
        expect(await readRecord(job.run_dir)).toEqual({ ...job, status: "collected" });
        expect(await readResult(job.run_dir)).toEqual(existingResult(job));
        await expectUnchanged(resultPath, result);
        await expectUnchanged(ledgerPath, ledger);
        expect(observation.exitReads).toBe(0);
        expect(observation.scans).toBe(0);
        expect(h.errors).toEqual([]);
        expect(actualRegistry(h.ctx).list()).toEqual([]);
        expect(h.sessionEvents).toEqual([]);
        expect(h.flushes).toEqual([]);
        await expectAbsent(join(job.run_dir, "invocation.json"));
        await expectAbsent(join(job.run_dir, "wrapper.pid"));
        await fiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
      }
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each(["capped", "recent"] as const)(
  "startup leaves a %s generation checkpoint unchanged when no committed record exists",
  async (kind) => {
    const h = await pollFixture();
    try {
      const job = await stoppedTerminal(h, { status: "failed", exit_code: 19 }, async (record) => {
        await io.writeFile(
          join(record.run_dir, "collect-error.json"),
          JSON.stringify({
            attempts: kind === "capped" ? 3 : 1,
            last_error: "prior output failure",
            at: kind === "recent" ? NOW : "2026-10-22T03:15:00.000Z",
          }),
        );
      });
      const metadataPath = join(job.run_dir, "run-job.json");
      const ledgerPath = join(job.run_dir, "collect-error.json");
      const metadata = await captureFile(metadataPath);
      const ledger = await captureFile(ledgerPath);
      observation.exit = join(job.run_dir, "exit_code");
      observation.output = outputRoot(job);
      for (let restart = 0; restart < 2; restart++) {
        const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
        expect(await readRecord(job.run_dir)).toEqual(job);
        await expectUnchanged(metadataPath, metadata);
        await expectUnchanged(ledgerPath, ledger);
        await expectAbsent(join(job.run_dir, "run-record.json"));
        expect(observation.exitReads).toBe(0);
        expect(observation.scans).toBe(0);
        expect(h.errors).toEqual([]);
        expect(h.sessionEvents).toEqual([]);
        expect(h.flushes).toEqual([]);
        expect(actualRegistry(h.ctx).list()).toEqual([]);
        await expectAbsent(join(job.run_dir, "invocation.json"));
        await expectAbsent(join(job.run_dir, "wrapper.pid"));
        await fiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
      }
    } finally {
      await h.close();
    }
  },
  15000,
);

test("collected pending notification is not rewritten, woken or moved during repeated startup", async () => {
  const h = await pollFixture();
  try {
    const job = await stoppedTerminal(h, { status: "collected" }, async (record) => {
      await io.writeFile(
        join(record.run_dir, "run-record.json"),
        JSON.stringify(existingResult(record)),
      );
    });
    const entry = { run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir };
    const resultPath = join(job.run_dir, "run-record.json");
    const metadataPath = join(job.run_dir, "run-job.json");
    const result = await captureFile(resultPath);
    const metadata = await captureFile(metadataPath);
    for (let restart = 0; restart < 2; restart++) {
      const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await expectUnchanged(resultPath, result);
      await expectUnchanged(metadataPath, metadata);
      expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [entry], completed: [] });
      expect(h.sessionEvents).toEqual([]);
      expect(h.flushes).toEqual([]);
      expect(actualRegistry(h.ctx).list()).toEqual([]);
      await expectAbsent(join(job.run_dir, "invocation.json"));
      await expectAbsent(join(job.run_dir, "wrapper.pid"));
      await fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
    }
  } finally {
    await h.close();
  }
}, 15000);

test.each(["delivered", "unreachable"] as const)(
  "%s notification moves an uncollected entry completed-first without replaying work",
  async (status) => {
    const h = await pollFixture();
    try {
      const job = await stoppedTerminal(h, {
        status: "failed",
        exit_code: null,
        notify: { status, attempts: 1, at: NOW, detail: "notification already finished" },
      });
      const entry = { run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir };
      const metadataPath = join(job.run_dir, "run-job.json");
      const metadata = await captureFile(metadataPath);
      const publications: string[] = [];
      observation.exit = join(job.run_dir, "exit_code");
      observation.output = outputRoot(job);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (target === join(h.stateDir, "completed.json")) publications.push("completed");
        if (target === join(h.stateDir, "active.json")) {
          expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
          publications.push("active");
        }
        await actualIo.rename(source, target);
      });
      for (let restart = 0; restart < 2; restart++) {
        const fiber = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
        const registry = actualRegistry(h.ctx);
        expect(registry.indexes.read()).toEqual({ active: [], completed: [entry] });
        expect(registry.indexes.lookup(job.run_id)).toEqual(entry);
        expect(registry.indexes.lookup(job.job_id)).toEqual(entry);
        expect(await persisted(h.stateDir, "active.json")).toEqual([]);
        expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
        expect(publications).toEqual(["completed", "active"]);
        await expectUnchanged(metadataPath, metadata);
        await expectAbsent(join(job.run_dir, "run-record.json"));
        await expectAbsent(join(job.run_dir, "invocation.json"));
        expect(observation.exitReads).toBe(0);
        expect(observation.scans).toBe(0);
        expect(registry.list()).toEqual([]);
        expect(h.sessionEvents).toEqual([]);
        expect(h.flushes).toEqual([]);
        await fiber.dispose();
        await waitForOwnershipRelease(h.stateDir);
      }
    } finally {
      await h.close();
    }
  },
  15000,
);

test("startup repairs completed-first overlap after interrupted active-index removal", async () => {
  const h = await pollFixture();
  try {
    const job = await stoppedTerminal(h, {
      status: "failed",
      exit_code: null,
      notify: { status: "delivered", attempts: 1, at: NOW, detail: null },
    });
    const entry = { run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir };
    const metadataPath = join(job.run_dir, "run-job.json");
    const metadata = await captureFile(metadataPath);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === join(h.stateDir, "active.json")) {
        expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
        throw Object.assign(new Error("active publication interrupted"), { code: "EIO" });
      }
      await actualIo.rename(source, target);
    });
    const first = await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [entry], completed: [entry] });
    expect(await persisted(h.stateDir, "active.json")).toEqual([entry]);
    expect(await persisted(h.stateDir, "completed.json")).toEqual([entry]);
    expect(h.errors.length).toBeGreaterThan(0);
    const completedPath = join(h.stateDir, "completed.json");
    const completed = await captureFile(completedPath);
    await first.dispose();
    await waitForOwnershipRelease(h.stateDir);
    vi.mocked(io.rename).mockImplementation(actualIo.rename);

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [], completed: [entry] });
    expect(await persisted(h.stateDir, "active.json")).toEqual([]);
    await expectUnchanged(completedPath, completed);
    await expectUnchanged(metadataPath, metadata);
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    vi.mocked(io.rename).mockImplementation(actualIo.rename);
    await h.close();
  }
}, 15000);

test("startup journals malformed terminal model metadata through collection instead of only logging", async () => {
  const h = await pollFixture();
  try {
    const job = await stoppedTerminal(h, {}, async (record) => {
      await io.writeFile(
        join(record.run_dir, "run-job.json"),
        JSON.stringify({
          ...record,
          llm: { response_model_source: "configured" },
        }),
      );
    });
    const metadataPath = join(job.run_dir, "run-job.json");
    const metadata = await captureFile(metadataPath);

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const ledger = await readLedger(job.run_dir);
    expect(ledger.attempts).toBe(1);
    expect(ledger.last_error).toMatch(/llm|response_model/iu);
    await expectUnchanged(metadataPath, metadata);
    await expectAbsent(join(job.run_dir, "run-record.json"));
    expect(h.errors.length).toBeGreaterThan(0);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test("invalid delivered notification metadata is retained rather than authorizing index migration", async () => {
  const h = await pollFixture();
  try {
    const job = await stoppedTerminal(h, {}, async (record) => {
      await io.writeFile(
        join(record.run_dir, "run-job.json"),
        JSON.stringify({
          ...record,
          notify: { status: "delivered", attempts: -1, at: NOW, detail: null },
        }),
      );
    });
    const metadataPath = join(job.run_dir, "run-job.json");
    const metadata = await captureFile(metadataPath);
    const entry = { run_id: job.run_id, job_id: job.job_id, run_dir: job.run_dir };

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [entry], completed: [] });
    await expectUnchanged(metadataPath, metadata);
    expect(h.errors.length).toBeGreaterThan(0);
    await expectAbsent(join(job.run_dir, "run-record.json"));
    expect(h.sessionEvents).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);
