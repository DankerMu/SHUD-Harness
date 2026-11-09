import * as io from "node:fs/promises";
import { basename, join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { snapshotQueryTree } from "./list-run-jobs/test-harness.ts";
import { names as listing } from "./submit-shud-build/test-harness.ts";
import { DUPLICATE, psetFixture } from "./submit-shud-pset/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    copyFile: vi.fn(actual.copyFile),
    rm: vi.fn(actual.rm),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.mkdir).mockReset().mockImplementation(actualIo.mkdir);
  vi.mocked(io.copyFile).mockReset().mockImplementation(actualIo.copyFile);
  vi.mocked(io.rm).mockReset().mockImplementation(actualIo.rm);
});

type Fixture = Awaited<ReturnType<typeof psetFixture>>;

/** Reset the observed filesystem calls, so a rejected submission must make none of its own. */
function watchRunCreation() {
  vi.mocked(io.mkdir).mockClear();
  vi.mocked(io.copyFile).mockClear();
}

function expectNoRunCreation() {
  expect(vi.mocked(io.mkdir)).not.toHaveBeenCalled();
  expect(vi.mocked(io.copyFile)).not.toHaveBeenCalled();
}

async function evidence(h: Fixture) {
  return {
    tree: await snapshotQueryTree(h.cwd),
    indexes: h.registry.indexes.read(),
  };
}

/** Fail the first input copy of a run, before any provenance exists. */
function failFirstCopy() {
  let failed = false;
  vi.mocked(io.copyFile).mockImplementation(async (source, target, flags) => {
    if (!failed) {
      failed = true;
      throw new Error("injected input copy failure");
    }
    await actualIo.copyFile(source, target, flags);
  });
}

test("two concurrent same-pset submissions accept exactly one; the other leaves no trace", async () => {
  const h = await psetFixture();
  try {
    const [first, second] = await Promise.allSettled([h.submit(), h.submit()]);
    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("rejected");
    if (first.status !== "fulfilled" || second.status !== "rejected")
      throw new Error("Expected exactly the first submission to be accepted");
    expect(second.reason).toBeInstanceOf(Error);
    expect(String(second.reason)).toMatch(DUPLICATE);
    const record = first.value;
    expect(await listing(join(h.cwd, "runs"))).toEqual([record.run_id]);
    expect(h.registry.indexes.read()).toEqual({
      active: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
      completed: [],
    });
    expect(await listing(join(h.cwd, "provenance"))).toEqual([`${record.data_id}.json`]);
    const copied = vi.mocked(io.copyFile).mock.calls.map(([, target]) => String(target));
    expect(copied.length).toBeGreaterThan(0);
    expect(copied.every((target) => target.startsWith(`${record.run_dir}/`))).toBe(true);
  } finally {
    await h.close();
  }
}, 20000);

test("a running same-pset job rejects before any input walk, run directory or file write", async () => {
  const h = await psetFixture();
  try {
    const running = await h.submit();
    expect(running.status).toBe("running");
    const jobBytes = await io.readFile(join(running.run_dir, "run-job.json"));
    const before = {
      runs: await listing(join(h.cwd, "runs")),
      provenance: await snapshotQueryTree(join(h.cwd, "provenance")),
      stacks: await snapshotQueryTree(join(h.cwd, "stacks")),
      indexes: h.registry.indexes.read(),
    };
    watchRunCreation();
    // A missing input directory proves the duplicate decision precedes every input read.
    await expect(h.submit({ input_dir: join(h.root, "missing-input") })).rejects.toThrow(DUPLICATE);
    await expect(h.submit()).rejects.toThrow(DUPLICATE);
    expectNoRunCreation();
    expect({
      runs: await listing(join(h.cwd, "runs")),
      provenance: await snapshotQueryTree(join(h.cwd, "provenance")),
      stacks: await snapshotQueryTree(join(h.cwd, "stacks")),
      indexes: h.registry.indexes.read(),
    }).toEqual(before);
    expect(await io.readFile(join(running.run_dir, "run-job.json"))).toEqual(jobBytes);
  } finally {
    await h.close();
  }
}, 20000);

test("a synchronous preflight failure after the claim releases the pair", async () => {
  const h = await psetFixture();
  try {
    await expect(h.submit({ input_dir: join(h.root, "missing-input") })).rejects.toThrow(/ENOENT/u);
    await expect(h.submit({ project: "../escape" })).rejects.toThrow(/contained path component/u);
    expect(await listing(join(h.cwd, "runs"))).toEqual([]);
    const record = await h.submit();
    expect(record.parameter_set_id).toBe("PSET-2");
  } finally {
    await h.close();
  }
}, 20000);

test("a cleanly rolled-back in-flight submission no longer holds its pset", async () => {
  const h = await psetFixture();
  try {
    failFirstCopy();
    await expect(h.submit()).rejects.toThrow("Cannot copy input entry");
    expect(await listing(join(h.cwd, "runs"))).toEqual([]);
    expect(h.registry.indexes.read()).toEqual({ active: [], completed: [] });
    const record = await h.submit();
    expect(await listing(join(h.cwd, "runs"))).toEqual([record.run_id]);
  } finally {
    await h.close();
  }
}, 20000);

test("a rollback whose cleanup fails keeps the pset claimed (fail closed)", async () => {
  const h = await psetFixture();
  try {
    failFirstCopy();
    vi.mocked(io.rm).mockImplementation(async (path, options) => {
      if (basename(String(path)).startsWith("RUN-"))
        throw Object.assign(new Error("injected run cleanup failure"), { code: "EACCES" });
      await actualIo.rm(path, options);
    });
    const failure = await h.submit().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AggregateError);
    vi.mocked(io.rm).mockImplementation(actualIo.rm);
    const [retained] = await listing(join(h.cwd, "runs"));
    expect(retained).toMatch(/^RUN-/u);
    const before = await evidence(h);
    watchRunCreation();
    await expect(h.submit()).rejects.toThrow(DUPLICATE);
    expectNoRunCreation();
    expect(await evidence(h)).toEqual(before);
    const other = await h.submit({ parameter_set_id: "PSET-3" });
    expect(await listing(join(h.cwd, "runs"))).toEqual([retained, other.run_id].sort());
  } finally {
    vi.mocked(io.rm).mockImplementation(actualIo.rm);
    await h.close();
  }
}, 20000);

test("a plan-bound EEXIST redraw keeps its own claim and never rejects itself", async () => {
  const h = await psetFixture();
  const collided: string[] = [];
  try {
    vi.mocked(io.mkdir).mockImplementation(async (...args) => {
      const path = args[0];
      if (typeof path === "string" && basename(path).startsWith("RUN-") && collided.length < 2) {
        await actualIo.mkdir(path);
        collided.push(path);
        throw Object.assign(new Error("competing mkdir won"), { code: "EEXIST" });
      }
      return actualIo.mkdir(...args);
    });
    const record = await h.submit();
    expect(collided).toHaveLength(2);
    expect(collided).not.toContain(record.run_dir);
    expect(record.parameter_set_id).toBe("PSET-2");
    await expect(h.submit()).rejects.toThrow(DUPLICATE);
  } finally {
    await h.close();
  }
}, 20000);
