import * as io from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import type * as NodeCrypto from "node:crypto";
import type * as NodeIo from "node:fs/promises";
import { ShudJobRegistry } from "./index.ts";
import { barrier, entry } from "./state-indexes/test-harness.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

const entropy = vi.hoisted(() => ({ suffixes: [] as string[] }));
vi.mock("node:crypto", async (original) => {
  const actual = await original<typeof NodeCrypto>();
  return {
    ...actual,
    randomBytes(size: number, callback?: (error: Error | null, bytes: Buffer) => void) {
      if (callback) return actual.randomBytes(size, callback);
      const suffix = size === 2 ? entropy.suffixes.shift() : undefined;
      return suffix === undefined ? actual.randomBytes(size) : Buffer.from(suffix, "hex");
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), copyFile: vi.fn(actual.copyFile) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  entropy.suffixes = [];
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-22T03:15:00Z"));
  vi.mocked(io.mkdir).mockReset().mockImplementation(actualIo.mkdir);
  vi.mocked(io.copyFile).mockReset().mockImplementation(actualIo.copyFile);
});
afterEach(() => vi.useRealTimers());

test("active, completed and existing-directory collisions redraw more than three times without deleting foreign data", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const active = entry(join(h.root, "active"), "a1b2");
    const completed = entry(join(h.root, "completed"), "c3d4");
    await registry.indexes.addActive(active);
    await registry.indexes.addActive(completed);
    await registry.indexes.completeActive(completed.run_id);
    const foreign = join(h.cwd, "runs", "RUN-20261022T031500-e5f6");
    await io.mkdir(foreign, { recursive: true });
    await io.writeFile(join(foreign, "sentinel"), "foreign directory bytes");
    entropy.suffixes = ["a1b2", "c3d4", "e5f6", "a1b2", "c3d4", "abcd"];
    const record = await registry.submitShud(h.request, execution.start);
    expect(record.run_id).toBe("RUN-20261022T031500-abcd");
    expect(record.job_id).toBe("JOB-20261022T031500-abcd");
    expect(await io.readdir(foreign)).toEqual(["sentinel"]);
    expect(await io.readFile(join(foreign, "sentinel"), "utf8")).toBe("foreign directory bytes");
    expect(registry.indexes.read()).toEqual({
      active: [active, { run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
      completed: [completed],
    });
  } finally {
    execution.finish();
    await h.dispose();
  }
});

test("nonrecursive mkdir EEXIST retries have no three-attempt cap and never authorize collision cleanup", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const collided: string[] = [];
  try {
    await h.apply(ShudJobRegistry, h.config);
    entropy.suffixes = ["0001", "0002", "0003", "0004", "0005"];
    vi.mocked(io.mkdir).mockImplementation(async (...args) => {
      const path = args[0];
      if (typeof path === "string" && basename(path).startsWith("RUN-") && collided.length < 4) {
        await actualIo.mkdir(path);
        await io.writeFile(join(path, "sentinel"), "won by another transaction");
        collided.push(path);
        throw Object.assign(new Error("competing mkdir won"), { code: "EEXIST" });
      }
      return actualIo.mkdir(...args);
    });
    const record = await actualRegistry(h.ctx).submitShud(h.request, execution.start);
    expect(record.run_id).toBe("RUN-20261022T031500-0005");
    expect(collided).toHaveLength(4);
    for (const path of collided) {
      expect(await io.readdir(path)).toEqual(["sentinel"]);
      expect(await io.readFile(join(path, "sentinel"), "utf8")).toBe("won by another transaction");
    }
    expect(actualRegistry(h.ctx).indexes.read().active).toEqual([
      { run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir },
    ]);
  } finally {
    execution.finish();
    await h.dispose();
  }
});

test("synchronous reservations prevent two workspaces from claiming one id while the first copy is paused", async () => {
  const h = await submissionFixture();
  const first = submissionProducer();
  const second = submissionProducer();
  const entered = barrier();
  const release = barrier();
  try {
    const otherCwd = join(h.root, "other-workspace");
    await io.mkdir(otherCwd);
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    entropy.suffixes = ["aaaa", "aaaa", "bbbb"];
    let held = false;
    vi.mocked(io.copyFile).mockImplementation(async (source, target, flags) => {
      if (!held && String(target).includes("RUN-20261022T031500-aaaa")) {
        held = true;
        entered.release();
        await release.waiting;
      }
      await actualIo.copyFile(source, target, flags);
    });
    const firstSubmission = registry.submitShud(h.request, first.start);
    const secondSubmission = registry.submitShud({ ...h.request, cwd: otherCwd }, second.start);
    await entered.waiting;
    const secondRecord = await secondSubmission;
    expect(secondRecord.run_id).toBe("RUN-20261022T031500-bbbb");
    expect(await io.readdir(join(otherCwd, "runs"))).toEqual([secondRecord.run_id]);
    release.release();
    const firstRecord = await firstSubmission;
    expect(firstRecord.run_id).toBe("RUN-20261022T031500-aaaa");
    expect(await io.readdir(join(h.cwd, "runs"))).toEqual([firstRecord.run_id]);
    expect(registry.indexes.read().active).toHaveLength(2);
    expect(registry.indexes.lookup(firstRecord.job_id)?.run_dir).toBe(firstRecord.run_dir);
    expect(registry.indexes.lookup(secondRecord.job_id)?.run_dir).toBe(secondRecord.run_dir);
  } finally {
    release.release();
    first.finish();
    second.finish();
    await h.dispose();
  }
});
