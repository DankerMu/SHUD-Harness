import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  seedRun,
  settlingProducer,
  waitForEvidence,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename), readFile: vi.fn(actual.readFile) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.readFile).mockReset().mockImplementation(actualIo.readFile);
});

function tick(registry: ShudJobRegistry): Promise<void> {
  return Promise.resolve().then(() => registry.pollOnce());
}

async function enteredBeforeCompletion(
  entered: Promise<void>,
  pending: Promise<unknown>,
): Promise<void> {
  await Promise.race([
    entered,
    pending.then(() => {
      throw new Error("Operation bypassed its held persistence barrier");
    }),
  ]);
}

test("D7 excludes both submitted and already-renamed running bytes until startup publication returns", async () => {
  const h = await pollFixture(0, "immediate");
  const before = barrier();
  const publish = barrier();
  const after = barrier();
  const returnWrite = barrier();
  let running: RunJob | undefined;
  try {
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (typeof target === "string" && target.endsWith("/run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (candidate.status === "running") {
          running = candidate;
          waitForEvidence(candidate.run_dir, "exit_code");
          before.release();
          await publish.waiting;
          await actualIo.rename(source, target);
          after.release();
          await returnWrite.waiting;
          return;
        }
      }
      await actualIo.rename(source, target);
    });
    const { producer, pending } = h.start();
    await enteredBeforeCompletion(before.waiting, pending);
    if (!running) throw new Error("No running candidate reached the barrier");
    expect(h.registry.isSubmissionInFlight(running.run_id)).toBe(true);
    await h.registry.pollOnce();
    expect((await readRecord(running.run_dir)).status).toBe("submitted");
    expect(producer.completed).toEqual([]);
    publish.release();
    await enteredBeforeCompletion(after.waiting, pending);
    await h.registry.pollOnce();
    expect(await readRecord(running.run_dir)).toEqual(running);
    expect(h.registry.isSubmissionInFlight(running.run_id)).toBe(true);
    expect(producer.completed).toEqual([]);
    returnWrite.release();
    const record = await pending;
    await h.registry.pollOnce();
    await expect.poll(() => producer.completed.length).toBe(1);
    expect((await readRecord(record.run_dir)).status).toBe("succeeded");
    expect(h.registry.isSubmissionInFlight(record.run_id)).toBe(false);
  } finally {
    publish.release();
    returnWrite.release();
    await h.close();
  }
}, 15000);

test("overlapping manual and timer ticks single-flight one held entry while another settles", async () => {
  const h = await pollFixture();
  const held = barrier();
  const release = barrier();
  const ticks: Promise<void>[] = [];
  let terminalWrites = 0;
  try {
    const first = h.start();
    const second = h.start();
    const [record, healthy] = await Promise.all([first.pending, second.pending]);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === join(record.run_dir, "run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (candidate.status === "succeeded") {
          terminalWrites++;
          held.release();
          await release.waiting;
        }
      }
      await actualIo.rename(source, target);
    });
    await releaseRun(record);
    ticks.push(tick(h.registry));
    await enteredBeforeCompletion(held.waiting, ticks[0]);
    await releaseRun(healthy);
    ticks.push(tick(h.registry), tick(h.registry));
    await expect.poll(() => second.producer.completed.length).toBe(1);
    expect((await readRecord(healthy.run_dir)).status).toBe("succeeded");
    expect(first.producer.completed).toEqual([]);
    expect((await readRecord(record.run_dir)).status).toBe("running");
    expect(terminalWrites).toBe(1);
    release.release();
    await Promise.all(ticks);
    await expect.poll(() => first.producer.completed.length).toBe(1);
    expect(terminalWrites).toBe(1);
  } finally {
    release.release();
    await Promise.allSettled(ticks);
    await h.close();
  }
}, 15000);

test("failed terminal persistence preserves done and retries successfully without blocking another run", async () => {
  const h = await pollFixture();
  let refuse = true;
  try {
    const first = h.start();
    const healthy = h.start();
    const [record, other] = await Promise.all([first.pending, healthy.pending]);
    const path = join(record.run_dir, "run-job.json");
    const original = await io.readFile(path);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (refuse && target === path) {
        const candidate = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (candidate.status === "succeeded")
          throw new Error("injected terminal persistence failure");
      }
      await actualIo.rename(source, target);
    });
    await releaseRun(record);
    await releaseRun(other);
    await h.registry.pollOnce();
    await expect
      .poll(() => h.errors.some((error) => error.includes("injected terminal persistence failure")))
      .toBe(true);
    expect(await io.readFile(path)).toEqual(original);
    expect(first.producer.completed).toEqual([]);
    expect(first.producer.registration.cancellations).toEqual([]);
    await expect.poll(() => healthy.producer.completed.length).toBe(1);
    refuse = false;
    await h.registry.pollOnce();
    await expect.poll(() => first.producer.completed.length).toBe(1);
    expect((await readRecord(record.run_dir)).status).toBe("succeeded");
  } finally {
    refuse = false;
    await h.close();
  }
}, 15000);

test("completion callback retry does not rewrite terminal bytes, mtime or finished_at", async () => {
  const h = await pollFixture();
  let refuse = true;
  const { producer, pending } = h.start(() => {
    if (refuse) throw new Error("injected completion callback failure");
  });
  try {
    const record = await pending;
    await releaseRun(record);
    await h.registry.pollOnce();
    await expect.poll(() => producer.attempts.length).toBeGreaterThan(0);
    expect(producer.completed).toEqual([]);
    const path = join(record.run_dir, "run-job.json");
    const terminal = await readRecord(record.run_dir);
    expect(terminal.status).toBe("succeeded");
    const bytes = await io.readFile(path);
    const stat = await io.stat(path, { bigint: true });
    expect(h.errors.some((error) => error.includes("injected completion callback failure"))).toBe(
      true,
    );
    refuse = false;
    await h.registry.pollOnce();
    await expect.poll(() => producer.completed.length).toBe(1);
    await producer.doneObserved;
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    expect((await readRecord(record.run_dir)).finished_at).toBe(terminal.finished_at);
    const attempts = producer.attempts.length;
    await h.registry.pollOnce();
    expect(producer.attempts).toHaveLength(attempts);
  } finally {
    refuse = false;
    await h.close();
  }
}, 15000);

test("composite disposal drains an accepted settlement before releasing state ownership", async () => {
  const h = await pollFixture();
  const contender = await createHarness();
  const held = barrier();
  const release = barrier();
  let polling: Promise<void> | undefined;
  let disposing: Promise<void> | undefined;
  try {
    const { pending } = h.start();
    const record = await pending;
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      if (target === join(record.run_dir, "run-job.json")) {
        const candidate = RunJobSchema.parse(JSON.parse(await actualIo.readFile(source, "utf8")));
        if (candidate.status === "succeeded") {
          held.release();
          await release.waiting;
        }
      }
      await actualIo.rename(source, target);
    });
    await releaseRun(record);
    polling = tick(h.registry);
    await enteredBeforeCompletion(held.waiting, polling);
    disposing = Promise.resolve(h.ctx.fiber.dispose());
    await expect
      .poll(async () => {
        try {
          await h.registry.submitShud(
            { ...h.request, project: "../admission-probe" },
            h.producers[0].start,
          );
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "unexpected acceptance";
      })
      .toContain("admission is closed");
    const refused: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : null).toContain(h.stateDir);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    release.release();
    await polling;
    await disposing;
    expect(await io.readdir(h.stateDir)).not.toContain("lock");
    await contender.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(contender.ctx);
    const terminal = await io.readFile(join(record.run_dir, "run-job.json"));
    await replacement.pollOnce();
    expect(await io.readFile(join(record.run_dir, "run-job.json"))).toEqual(terminal);
    expect((await readRecord(record.run_dir)).status).toBe("succeeded");
  } finally {
    release.release();
    await polling?.catch(() => undefined);
    await disposing;
    await contender.dispose();
    await h.close();
  }
}, 15000);

test("disposed timer admits no more steps and reload starts only the replacement dispatcher", async () => {
  // This timer-only case has no SHUD children: disk-only entries refer to the genuine test-host identity.
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
  let h: Awaited<ReturnType<typeof pollFixture>> | undefined;
  const published = barrier();
  try {
    h = await pollFixture();
    const record = await seedRun(h);
    await h.registry.pollOnce();
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    const path = join(record.run_dir, "run-job.json");
    let reads = 0;
    vi.mocked(io.readFile).mockImplementation(async (source, options) => {
      if (source === path) reads++;
      return actualIo.readFile(source, options);
    });
    await io.writeFile(join(record.run_dir, "exit_code"), "0\n");
    // Closed manual admission may reject or no-op, but must not perform another record read.
    await h.registry.pollOnce().catch(() => undefined);
    await vi.advanceTimersByTimeAsync(70);
    expect(reads).toBe(0);
    expect((await readRecord(record.run_dir)).status).toBe("running");
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      await actualIo.rename(source, target);
      if (target === path) published.release();
    });
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    await vi.advanceTimersByTimeAsync(7);
    await published.waiting;
    expect((await readRecord(record.run_dir)).status).toBe("succeeded");
    expect(h.registry.list()).toEqual([]);
  } finally {
    vi.useRealTimers();
    await h?.close();
  }
}, 15000);

test("reload settles a new local registration without invoking the retired completion receipt again", async () => {
  const h = await pollFixture();
  try {
    const first = h.start();
    const record = await first.pending;
    await releaseRun(record);
    await h.registry.pollOnce();
    await expect.poll(() => first.producer.completed.length).toBe(1);
    const path = join(record.run_dir, "run-job.json");
    const bytes = await io.readFile(path);
    const stat = await io.stat(path, { bigint: true });
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);
    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    const producer = settlingProducer();
    h.producers.push(producer);
    const pending = replacement.submitShud(h.request, producer.start);
    h.submissions.push(pending);
    const next = await pending;
    await h.registry.pollOnce().catch(() => undefined);
    await replacement.pollOnce();
    expect(producer.completed).toEqual([]);
    await releaseRun(next);
    // The replacement timer, not a new manual tick, must complete its own receipt.
    await expect.poll(() => producer.completed.length).toBe(1);
    expect((await readRecord(next.run_dir)).status).toBe("succeeded");
    expect(first.producer.attempts).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
  } finally {
    await h.close();
  }
}, 15000);

test("async completion remains single-flight and retains state ownership until its accepted work finishes", async () => {
  const h = await pollFixture();
  const contender = await createHarness();
  const entered = barrier();
  const release = barrier();
  const ticks: Promise<void>[] = [];
  let disposing: Promise<void> | undefined;
  try {
    const { producer, pending } = h.start(async () => {
      entered.release();
      await release.waiting;
    });
    const record = await pending;
    await releaseRun(record);
    ticks.push(tick(h.registry));
    await enteredBeforeCompletion(entered.waiting, ticks[0]);
    ticks.push(tick(h.registry));
    expect((await readRecord(record.run_dir)).status).toBe("succeeded");
    expect(producer.completed).toEqual([]);
    expect(producer.attempts).toHaveLength(1);
    disposing = Promise.resolve(h.ctx.fiber.dispose());
    await expect
      .poll(async () => {
        try {
          await h.registry.submitShud(
            { ...h.request, project: "../admission-probe" },
            producer.start,
          );
        } catch (error) {
          return error instanceof Error ? error.message : String(error);
        }
        return "unexpected acceptance";
      })
      .toContain("admission is closed");
    const refused: unknown = await contender.apply(ShudJobRegistry, h.config).then(
      () => null,
      (error: unknown) => error,
    );
    expect(refused).toBeInstanceOf(Error);
    expect(refused instanceof Error ? refused.message : null).toContain(h.stateDir);
    expect(await io.readdir(h.stateDir)).toContain("lock");
    release.release();
    await Promise.all(ticks);
    await disposing;
    await waitForOwnershipRelease(h.stateDir);
    expect(producer.completed).toHaveLength(1);
    expect(producer.attempts).toHaveLength(1);
  } finally {
    release.release();
    await Promise.allSettled(ticks);
    await disposing;
    await contender.dispose();
    await h.close();
  }
}, 15000);
