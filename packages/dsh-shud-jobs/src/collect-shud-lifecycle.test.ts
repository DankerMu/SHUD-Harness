import * as io from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import type * as NodeFs from "node:fs";
import {
  RunJobSchema,
  RunRecordSchema,
  type RunId,
  type RunRecord,
} from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  seedRun,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
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
  return {
    ...actual,
    rename: vi.fn(actual.rename),
    readdir: vi.fn(actual.readdir),
    readFile: vi.fn(actual.readFile),
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, renameSync: vi.fn(actual.renameSync) };
});
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.readdir).mockReset().mockImplementation(actualIo.readdir);
  vi.mocked(io.readFile).mockReset().mockImplementation(actualIo.readFile);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
});

async function enteredBeforeCompletion(
  entered: Promise<void>,
  operation: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    entered,
    operation.then(() => {
      throw new Error("Collection bypassed its persistence barrier");
    }),
  ]);
}
function observe(operation: Promise<RunRecord>) {
  return operation.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

test("collectShud rejects CLOSED admission without touching an eligible terminal checkpoint", async () => {
  const h = await pollFixture();
  try {
    // Keep the real timer live but give it no exit evidence before disposal.
    // This disk-only entry uses the genuine live test-host identity, not a SHUD child.
    const running = await seedRun(h, {}, async (record) => {
      await io.mkdir(outputRoot(record), { recursive: true });
      await io.writeFile(join(outputRoot(record), "artifact.dat"), "abc");
    });
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    // Publish eligibility only after the ownership barrier, so automatic collect cannot race setup.
    // Without the CLOSED guard this indexed terminal entry is fully collectable.
    const terminal = await replaceRecord(running, {
      status: "succeeded",
      exit_code: 0,
      started_at: "2026-10-22T03:15:00.000Z",
      finished_at: "2026-10-22T03:15:02.500Z",
    });
    await publishExit(terminal, "0\n");
    expect(h.registry.indexes.lookup(terminal.run_id)).toEqual({
      run_id: terminal.run_id,
      job_id: terminal.job_id,
      run_dir: terminal.run_dir,
    });
    const jobPath = join(terminal.run_dir, "run-job.json");
    const before = await io.readFile(jobPath);
    const mtime = (await io.stat(jobPath, { bigint: true })).mtimeNs;
    const files = (await io.readdir(terminal.run_dir)).sort();
    await expect(h.registry.collectShud(terminal.run_id)).rejects.toThrow(/\bCLOSED\b/u);
    expect(await readRecord(terminal.run_dir)).toEqual(terminal);
    expect(await io.readFile(jobPath)).toEqual(before);
    expect((await io.stat(jobPath, { bigint: true })).mtimeNs).toBe(mtime);
    expect((await io.readdir(terminal.run_dir)).sort()).toEqual(files);
    expect(await io.readFile(join(terminal.run_dir, "exit_code"), "utf8")).toBe("0\n");
    expect(await io.readFile(join(outputRoot(terminal), "artifact.dat"), "utf8")).toBe("abc");
    await expectAbsent(join(terminal.run_dir, "run-record.json"));
    await expectAbsent(join(terminal.run_dir, "collect-error.json"));
  } finally {
    await h.close();
  }
}, 15000);

test("RunRecord publication is the commit boundary and a failed collected projection repairs without regeneration", async () => {
  const h = await pollFixture();
  let recordPath = "";
  let jobPath = "";
  let root = "";
  let blockProjection = true;
  let forbidScan = false;
  let publications = 0;
  let ledgerWrites = 0;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === recordPath) publications++;
      if (typeof target === "string" && target.endsWith("/collect-error.json")) ledgerWrites++;
      await actualIo.rename(source, target);
    });
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      if (target === jobPath) {
        const candidate = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
        if (candidate.status === "collected") {
          expect(
            RunRecordSchema.parse(JSON.parse(actualFs.readFileSync(recordPath, "utf8"))).run_id,
          ).toBe(candidate.run_id);
          if (blockProjection)
            throw Object.assign(new Error("injected collected projection failure"), {
              code: "EIO",
            });
        }
      }
      actualFs.renameSync(source, target);
    });
    vi.mocked(io.readdir).mockImplementation(async (...args) => {
      if (forbidScan && args[0] === root)
        throw new Error("Committed record must not be regenerated from outputs");
      return actualIo.readdir(...args);
    });
    const job = await seedTerminal(h, {}, async (record) => {
      root = outputRoot(record);
      recordPath = join(record.run_dir, "run-record.json");
      jobPath = join(record.run_dir, "run-job.json");
      await io.writeFile(join(root, "original.dat"), "abc");
    });
    const api = h.registry;
    await expect(api.collectShud(job.run_id)).rejects.toThrow();
    const committed = await readResult(job.run_dir);
    expect(committed.artifacts.files).toEqual([{ path: "original.dat", size_bytes: 3 }]);
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
    const bytes = await io.readFile(recordPath);
    const stat = await io.stat(recordPath, { bigint: true });
    expect(publications).toBe(1);
    expect(ledgerWrites).toBe(0);
    await expectAbsent(join(job.run_dir, "collect-error.json"));
    await io.writeFile(join(root, "later.dat"), "must not appear");
    await io.rm(join(job.run_dir, "exit_code"));
    forbidScan = true;
    await h.registry.pollOnce();
    blockProjection = false;
    expect(await api.collectShud(job.job_id)).toEqual(committed);
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    expect(await io.readFile(recordPath)).toEqual(bytes);
    expect((await io.stat(recordPath, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    expect(publications).toBe(1);
    expect(ledgerWrites).toBe(0);
    expect(h.errors.length).toBeGreaterThan(0);
  } finally {
    blockProjection = false;
    forbidScan = false;
    await h.close();
  }
});

test.each(["record-publication", "error-ledger", "failure-status"] as const)(
  "%s write failure preserves evidence and reports the actual incomplete boundary",
  async (phase) => {
    const h = await pollFixture();
    let targetRun = "";
    try {
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (typeof target === "string" && targetRun && target.startsWith(`${targetRun}/`)) {
          if (
            (phase === "record-publication" && target.endsWith("/run-record.json")) ||
            (phase === "error-ledger" && target.endsWith("/collect-error.json"))
          ) {
            throw Object.assign(new Error("PRIVATE_WRITE_FAILURE_PAYLOAD_308"), { code: "EIO" });
          }
        }
        await actualIo.rename(source, target);
      });
      vi.mocked(fs.renameSync).mockImplementation((source, target) => {
        if (phase === "failure-status" && targetRun && target === join(targetRun, "run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(actualFs.readFileSync(source, "utf8")));
          if (record.status === "failed")
            throw Object.assign(new Error("PRIVATE_STATUS_FAILURE_PAYLOAD_308"), {
              code: "EACCES",
            });
        }
        actualFs.renameSync(source, target);
      });
      const job = await seedTerminal(
        h,
        phase === "failure-status"
          ? { status: "cancelled", exit_code: 13, cancel_requested_at: "2026-10-22T03:15:01.000Z" }
          : phase === "error-ledger"
            ? { status: "failed", exit_code: null }
            : {},
        async (record) => {
          targetRun = record.run_dir;
          if (phase !== "record-publication") await publishExit(record, "abc");
        },
      );
      await h.registry.pollOnce();
      await expectAbsent(join(job.run_dir, "run-record.json"));
      if (phase === "error-ledger") await expectAbsent(join(job.run_dir, "collect-error.json"));
      else expect((await readLedger(job.run_dir)).attempts).toBe(1);
      expect(await readRecord(job.run_dir)).toEqual(job);
      expect(await io.readFile(join(job.run_dir, "exit_code"), "utf8")).toBe(
        phase === "record-publication" ? "0\n" : "abc",
      );
      expect((await io.readdir(job.run_dir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      expect(h.errors.length).toBeGreaterThan(0);
      expect(h.errors.join("\n")).toContain(phase === "failure-status" ? "EACCES" : "EIO");
      if (phase === "error-ledger") expect(h.errors.join("\n")).toMatch(/collect-error|ledger/iu);
      if (phase === "failure-status")
        expect(h.errors.join("\n")).toMatch(/run-job|projection|status/iu);
      expect(h.errors.join("\n")).not.toContain("PRIVATE_WRITE_FAILURE_PAYLOAD_308");
      expect(h.errors.join("\n")).not.toContain("PRIVATE_STATUS_FAILURE_PAYLOAD_308");
    } finally {
      vi.mocked(io.rename).mockImplementation(actualIo.rename);
      vi.mocked(fs.renameSync).mockImplementation(actualFs.renameSync);
      await h.close();
    }
  },
);

test("direct collection retains the primary controlled reason when error-ledger publication also fails", async () => {
  const h = await pollFixture();
  let ledgerPath = "";
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === ledgerPath)
        throw Object.assign(new Error("PRIVATE_LEDGER_FAILURE_PAYLOAD_315"), { code: "EIO" });
      await actualIo.rename(source, target);
    });
    const job = await seedTerminal(h, { status: "failed", exit_code: null }, async (record) => {
      ledgerPath = join(record.run_dir, "collect-error.json");
      await publishExit(record, "abc");
    });
    const outcome = await observe(h.registry.collectShud(job.run_id));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Invalid exit evidence unexpectedly collected");
    expect(outcome.error).toBeInstanceOf(AggregateError);
    if (!(outcome.error instanceof AggregateError)) throw new Error("Missing aggregate failure");
    expect(outcome.error.cause).toMatchObject({
      message: "SHUD collect exit evidence: INVALID_INTEGER",
    });
    expect(outcome.error.errors).toMatchObject([
      { message: "SHUD collect exit evidence: INVALID_INTEGER" },
      { message: "SHUD collect collect-error write: EIO" },
    ]);
    expect(outcome.error.message).toContain("SHUD collect exit evidence: INVALID_INTEGER");
    expect(outcome.error.message).toContain("SHUD collect collect-error write: EIO");
    expect(inspect(outcome.error, { depth: 5 })).not.toContain(
      "PRIVATE_LEDGER_FAILURE_PAYLOAD_315",
    );
    await expectAbsent(ledgerPath);
    await expectAbsent(join(job.run_dir, "run-record.json"));
    expect(await readRecord(job.run_dir)).toEqual(job);
  } finally {
    vi.mocked(io.rename).mockImplementation(actualIo.rename);
    await h.close();
  }
});

test("automatic and direct collection publish once per run while a held run does not block another", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  const requests: Promise<RunRecord>[] = [];
  let polling: Promise<void> | undefined;
  let target = "";
  let writes = 0;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, destination) => {
      if (destination === target) {
        writes++;
        entered.release();
        await release.waiting;
      }
      await actualIo.rename(source, destination);
    });
    const job = await seedTerminal(h, {}, (record) => {
      target = join(record.run_dir, "run-record.json");
    });
    const api = h.registry;
    requests.push(api.collectShud(job.run_id));
    void requests[0].catch(() => undefined);
    await enteredBeforeCompletion(entered.waiting, requests[0]);
    requests.push(api.collectShud(job.job_id));
    void requests[1].catch(() => undefined);
    polling = h.registry.pollOnce();
    await expectAbsent(target);
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
    const healthy = await seedTerminal(h);
    expect((await api.collectShud(healthy.run_id)).exit_class).toBe("ok");
    expect(writes).toBe(1);
    release.release();
    const results = await Promise.all(requests);
    await polling;
    expect(results[0]).toEqual(results[1]);
    expect(results[0]).toEqual(await readResult(job.run_dir));
    expect(writes).toBe(1);
    expect((await readRecord(job.run_dir)).status).toBe("collected");
  } finally {
    release.release();
    await Promise.allSettled(requests);
    await polling?.catch(() => undefined);
    await h.close();
  }
}, 15000);

test("failed concurrent direct requests preserve per-run exclusion, durable attempt counts and ownership through queued work", async () => {
  const h = await pollFixture();
  const contender = await createHarness();
  const firstEntered = barrier();
  const firstRelease = barrier();
  const laterEntered = barrier();
  const laterRelease = barrier();
  const requests: ReturnType<typeof observe>[] = [];
  let target = "";
  let runDir = "";
  let attempts = 0;
  let active = 0;
  let maximumActive = 0;
  const durableAttempts: number[] = [];
  const unlockedWrites: string[] = [];
  let polling: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  try {
    vi.mocked(io.readdir).mockImplementation(async (...args) => {
      if (args[0] !== target) return actualIo.readdir(...args);
      const attempt = ++attempts;
      active++;
      maximumActive = Math.max(maximumActive, active);
      try {
        if (attempt === 1) {
          firstEntered.release();
          await firstRelease.waiting;
        } else {
          laterEntered.release();
          await laterRelease.waiting;
        }
        throw Object.assign(new Error("injected generation scan failure"), { code: "EACCES" });
      } finally {
        active--;
      }
    });
    vi.mocked(io.rename).mockImplementation(async (source, destination) => {
      if (destination === join(runDir, "collect-error.json")) {
        if (!(await actualIo.readdir(h.stateDir)).includes("lock"))
          unlockedWrites.push(String(destination));
        const value: unknown = JSON.parse(await actualIo.readFile(source, "utf8"));
        if (
          typeof value !== "object" ||
          value === null ||
          !("attempts" in value) ||
          typeof value.attempts !== "number"
        ) {
          throw new Error("Generation failure attempted to publish an invalid retry ledger");
        }
        durableAttempts.push(value.attempts);
      }
      await actualIo.rename(source, destination);
    });
    const job = await seedTerminal(h, {}, (record) => {
      target = outputRoot(record);
      runDir = record.run_dir;
    });
    const api = h.registry;
    requests.push(observe(api.collectShud(job.run_id)));
    await enteredBeforeCompletion(firstEntered.waiting, requests[0]);
    requests.push(observe(api.collectShud(job.job_id)));
    firstRelease.release();
    // The live timer may own generation A. Do not await a queued direct request while successor B is held.
    const next = await Promise.race([
      laterEntered.waiting.then(() => "successor" as const),
      requests[0].then((result) => {
        expect(result.ok).toBe(false);
        return "joined" as const;
      }),
    ]);
    if (next === "joined") {
      const retry = observe(api.collectShud(job.run_id));
      requests.push(retry);
      await enteredBeforeCompletion(laterEntered.waiting, retry);
    }
    expect((await readLedger(job.run_dir)).attempts).toBeGreaterThanOrEqual(1);
    requests.push(observe(api.collectShud(job.job_id)));
    polling = h.registry.pollOnce();
    const healthy = await seedTerminal(h);
    expect((await api.collectShud(healthy.run_id)).exit_class).toBe("ok");
    expect(maximumActive).toBe(1);
    disposing = Promise.resolve(h.ctx.fiber.dispose());
    await expect
      .poll(async () => {
        try {
          await h.registry.submitShud({ ...h.request, project: "../admission-probe" }, () => {
            throw new Error("Invalid admission probe reached execution");
          });
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "unexpected acceptance";
      })
      .toContain("admission is closed");
    expect(await actualIo.readdir(h.stateDir)).toContain("lock");
    const refused: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : null).toContain(h.stateDir);
    laterRelease.release();
    const results = await Promise.all(requests);
    await polling;
    await disposing;
    await waitForOwnershipRelease(h.stateDir);
    expect(results.every((result) => !result.ok)).toBe(true);
    for (const result of results) {
      if (result.ok) throw new Error("An injected failed generation unexpectedly succeeded");
      expect(inspect(result.error, { depth: 5 })).toContain("EACCES");
    }
    expect(attempts).toBeGreaterThanOrEqual(2);
    expect(maximumActive).toBe(1);
    expect((await readLedger(job.run_dir)).attempts).toBe(attempts);
    expect(durableAttempts).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
    expect(unlockedWrites).toEqual([]);
    await expectAbsent(join(job.run_dir, "run-record.json"));
  } finally {
    firstRelease.release();
    laterRelease.release();
    await Promise.allSettled(requests);
    await polling?.catch(() => undefined);
    await disposing;
    vi.mocked(io.readdir).mockImplementation(actualIo.readdir);
    vi.mocked(io.rename).mockImplementation(actualIo.rename);
    await contender.dispose();
    await h.close();
  }
}, 15000);

test("direct collection waits for accepted async registration completion before publishing a result", async () => {
  // Freeze cadence before admission so the manual tick owns the post-release step.
  // Date, native execution and output-pump timeouts remain real.
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  let ticking: Promise<void> | undefined;
  let collection: Promise<RunRecord> | undefined;
  try {
    const { producer, pending } = h.start(async () => {
      entered.release();
      await release.waiting;
    });
    const job = await pending;
    const api = h.registry;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === join(job.run_dir, "run-record.json")) {
        expect(producer.completed).toHaveLength(1);
        expect(producer.durableAtDone).toHaveLength(1);
        expect(producer.durableAtDone[0].status).toBe("succeeded");
      }
      await actualIo.rename(source, target);
    });
    await releaseRun(job);
    ticking = h.registry.pollOnce();
    await enteredBeforeCompletion(entered.waiting, ticking);
    collection = api.collectShud(job.job_id);
    void collection.catch(() => undefined);
    await expectAbsent(join(job.run_dir, "run-record.json"));
    expect(producer.completed).toEqual([]);
    release.release();
    await ticking;
    expect((await collection).exit_class).toBe("ok");
    expect(producer.attempts).toHaveLength(1);
    expect(producer.registration.cancellations).toEqual([]);
    expect((await readRecord(job.run_dir)).status).toBe("collected");
  } finally {
    try {
      release.release();
      await ticking?.catch(() => undefined);
      await collection?.catch(() => undefined);
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("direct collection rejects a submission-in-flight without publishing a result or retry ledger", async () => {
  const h = await pollFixture();
  const entered = barrier();
  const release = barrier();
  let runId: RunId | undefined;
  let runDir = "";
  try {
    const api = h.registry;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const record = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (record.status === "running") {
          runId = record.run_id;
          runDir = record.run_dir;
          await actualIo.rename(source, target);
          entered.release();
          await release.waiting;
          return;
        }
      }
      await actualIo.rename(source, target);
    });
    const { pending } = h.start();
    await enteredBeforeCompletion(entered.waiting, pending);
    if (!runId) throw new Error("Submission did not reach the D7 barrier");
    expect(api.isSubmissionInFlight(runId)).toBe(true);
    const current = await readRecord(runDir);
    expect(current.status).toBe("running");
    expect(current.dsh_job_id).not.toBeNull();
    const outcome = await observe(api.collectShud(runId));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("D7 submission unexpectedly collected");
    expect(outcome.error).toMatchObject({ code: "SUBMISSION_IN_FLIGHT" });
    if (!(outcome.error instanceof Error)) throw new Error("D7 request omitted its error");
    expect(outcome.error.message).toContain("running");
    expect(outcome.error.message).toContain("dsh_job_id");
    expect(outcome.error.message).toContain(current.dsh_job_id);
    await expectAbsent(join(runDir, "run-record.json"));
    await expectAbsent(join(runDir, "collect-error.json"));
    release.release();
    await pending;
  } finally {
    release.release();
    await h.close();
  }
}, 15000);

test("an admitted D7 diagnostic read retains rejection and state ownership after submission finishes", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const h = await pollFixture();
  const contender = await createHarness();
  const published = barrier();
  const finishSubmission = barrier();
  const readEntered = barrier();
  const finishRead = barrier();
  let runId: RunId | undefined;
  let runDir = "";
  let jobPath = "";
  let collection: Promise<RunRecord> | undefined;
  let disposing: Promise<void> | undefined;
  let disposed = false;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (candidate.status === "running") {
          runId = candidate.run_id;
          runDir = candidate.run_dir;
          await actualIo.rename(source, target);
          published.release();
          await finishSubmission.waiting;
          return;
        }
      }
      await actualIo.rename(source, target);
    });
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === jobPath) {
        readEntered.release();
        await finishRead.waiting;
      }
      return actualIo.readFile(...args);
    });
    const { pending } = h.start();
    await enteredBeforeCompletion(published.waiting, pending);
    if (!runId) throw new Error("Submission did not publish its D7 running checkpoint");
    expect(h.registry.isSubmissionInFlight(runId)).toBe(true);
    jobPath = join(runDir, "run-job.json");
    collection = h.registry.collectShud(runId);
    const observed = observe(collection);
    await enteredBeforeCompletion(readEntered.waiting, observed);
    finishSubmission.release();
    const job = await pending;
    expect(h.registry.isSubmissionInFlight(runId)).toBe(false);
    disposing = Promise.resolve(h.ctx.fiber.dispose()).then(() => {
      disposed = true;
    });
    await expect
      .poll(async () => {
        try {
          await h.registry.submitShud({ ...h.request, project: "../admission-probe" }, () => {
            throw new Error("Invalid admission probe reached execution");
          });
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "unexpected acceptance";
      })
      .toContain("admission is closed");
    expect(disposed).toBe(false);
    expect(await actualIo.readdir(h.stateDir)).toContain("lock");
    await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
    await expectAbsent(join(runDir, "run-record.json"));
    await expectAbsent(join(runDir, "collect-error.json"));

    finishRead.release();
    const outcome = await observed;
    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error("Admitted D7 diagnostic became a collection");
    expect(outcome.error).toMatchObject({ code: "SUBMISSION_IN_FLIGHT" });
    if (!(outcome.error instanceof Error)) throw new Error("D7 diagnostic omitted its error");
    expect(outcome.error.message).toContain("running");
    expect(outcome.error.message).toContain("dsh_job_id");
    expect(outcome.error.message).toContain(job.dsh_job_id);
    await disposing;
    await waitForOwnershipRelease(h.stateDir);
    expect(await readRecord(runDir)).toEqual(job);
    await expectAbsent(join(runDir, "run-record.json"));
    await expectAbsent(join(runDir, "collect-error.json"));
  } finally {
    finishSubmission.release();
    finishRead.release();
    try {
      await collection?.catch(() => undefined);
      await disposing;
      vi.mocked(io.readFile).mockImplementation(actualIo.readFile);
      vi.mocked(io.rename).mockImplementation(actualIo.rename);
      await contender.dispose();
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("one automatic step settles a running entry and only a later cadence collects it", async () => {
  // Timer scheduling is controlled only for this disk-only fixture; its host identity is genuine.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let h: Awaited<ReturnType<typeof pollFixture>> | undefined;
  try {
    h = await pollFixture();
    const job = await seedRun(h, {}, async (record) => {
      await io.mkdir(outputRoot(record), { recursive: true });
      await io.writeFile(join(record.run_dir, "stdout.log"), "");
      await io.writeFile(join(record.run_dir, "stderr.log"), "");
      await publishExit(record, "0\n");
    });
    await h.registry.pollOnce();
    expect((await readRecord(job.run_dir)).status).toBe("succeeded");
    await expectAbsent(join(job.run_dir, "run-record.json"));
    await expectAbsent(join(job.run_dir, "collect-error.json"));
    await vi.advanceTimersByTimeAsync(7);
    await h.registry.pollOnce();
    expect((await readRecord(job.run_dir)).status).toBe("collected");
    expect((await readResult(job.run_dir)).exit_class).toBe("ok");
    expect(h.producers).toEqual([]);
  } finally {
    vi.useRealTimers();
    await h?.close();
  }
}, 15000);
