import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import { ShudJobRegistry } from "./index.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
  writeInputTree,
} from "./submit-shud/test-harness.ts";

// Observe real filesystem writes; path resolution and all operations still use the actual OS.
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, mkdir: vi.fn(actual.mkdir), rename: vi.fn(actual.rename) };
});

type TreeSnapshot = Record<string, { kind: "directory" } | { kind: "file"; bytes: Buffer }>;

async function snapshotTree(root: string): Promise<TreeSnapshot> {
  const snapshot: TreeSnapshot = {};
  async function visit(relative: string): Promise<void> {
    const entries = await io.readdir(join(root, relative), { withFileTypes: true });
    for (const entry of entries) {
      const name = relative ? join(relative, entry.name) : entry.name;
      if (entry.isDirectory()) {
        snapshot[name] = { kind: "directory" };
        await visit(name);
      } else if (entry.isFile()) {
        snapshot[name] = { kind: "file", bytes: await io.readFile(join(root, name)) };
      } else {
        throw new Error(`Unexpected snapshot entry type: ${name}`);
      }
    }
  }
  await visit("");
  return snapshot;
}

async function existingRunsAlias(cwd: string): Promise<string | undefined> {
  try {
    return await io.realpath(join(cwd, "runs"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

test("existing Runs used as input rejects its runs case alias before producer or filesystem writes", async ({
  skip,
}) => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const input = join(h.cwd, "Runs");
  try {
    await writeInputTree(input);
    const physicalInput = await io.realpath(input);
    const alias = await existingRunsAlias(h.cwd);
    if (alias === undefined) {
      skip("filesystem treats Runs and runs as distinct directories");
      return;
    }
    expect(alias).toBe(physicalInput);
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const inputBefore = await snapshotTree(input);
    const stateBefore = await snapshotTree(h.stateDir);
    const indexesBefore = registry.indexes.read();
    vi.mocked(io.mkdir).mockClear();
    vi.mocked(io.rename).mockClear();

    await expect(
      registry.submitShud({ ...h.request, input_dir: input }, execution.start),
    ).rejects.toThrow(/input/u);

    expect(execution.handles).toEqual([]);
    expect(await snapshotTree(input)).toEqual(inputBefore);
    expect(await snapshotTree(h.stateDir)).toEqual(stateBefore);
    expect(registry.indexes.read()).toEqual(indexesBefore);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(registry.list()).toEqual([]);
    expect(io.mkdir).not.toHaveBeenCalled();
    expect(io.rename).not.toHaveBeenCalled();
  } finally {
    execution.finish();
    await h.dispose();
  }
});

test("existing Runs with disjoint input records the physical run path and preserves case-sensitive behavior", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  const existing = join(h.cwd, "Runs");
  try {
    await io.mkdir(existing);
    await io.writeFile(join(existing, "sentinel"), "pre-existing directory bytes\n");
    const physicalExisting = await io.realpath(existing);
    const alias = await existingRunsAlias(h.cwd);
    if (alias !== undefined) expect(alias).toBe(physicalExisting);
    // On a case-sensitive filesystem, Runs is unrelated and the ordinary runs root is created.
    const expectedRoot = alias ?? join(await io.realpath(h.cwd), "runs");
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    const record = await registry.submitShud(h.request, execution.start);
    const expectedRun = join(expectedRoot, record.run_id);

    expect(record.run_dir).toBe(expectedRun);
    expect(await io.realpath(record.run_dir)).toBe(expectedRun);
    expect(JSON.parse(await io.readFile(join(expectedRun, "run-job.json"), "utf8"))).toEqual(
      record,
    );
    const expectedIndex = [{ run_id: record.run_id, job_id: record.job_id, run_dir: expectedRun }];
    expect(registry.indexes.read()).toEqual({ active: expectedIndex, completed: [] });
    expect(JSON.parse(await io.readFile(join(h.stateDir, "active.json"), "utf8"))).toEqual(
      expectedIndex,
    );
    expect(await io.readFile(join(existing, "sentinel"), "utf8")).toBe(
      "pre-existing directory bytes\n",
    );
    if (alias === undefined) expect(await io.readdir(existing)).toEqual(["sentinel"]);
    for (const [name, bytes] of Object.entries(h.originals)) {
      expect(await io.readFile(join(expectedRun, "input", "tiny", name))).toEqual(bytes);
      expect(await io.readFile(join(h.inputDir, name))).toEqual(bytes);
    }
  } finally {
    execution.finish();
    await h.dispose();
  }
});
