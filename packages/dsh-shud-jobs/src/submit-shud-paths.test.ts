import { execFileSync } from "node:child_process";
import { mkdir, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import * as io from "node:fs/promises";
import type * as NodeIo from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, test, vi } from "vitest";
import type { RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import {
  actualRegistry,
  snapshotTree,
  submissionFixture,
  submissionProducer,
  writeInputTree,
} from "./submit-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    copyFile: vi.fn(actual.copyFile),
    rename: vi.fn(actual.rename),
  };
});

describe("submission filesystem boundaries", () => {
  test("an input root symlink is accepted and recorded as its physical directory", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      const alias = join(h.root, "input-alias");
      await symlink(h.inputDir, alias);
      await h.apply(ShudJobRegistry, h.config);
      const record: RunJob = await actualRegistry(h.ctx).submitShud(
        { ...h.request, input_dir: alias },
        execution.start,
      );
      expect(record.input_dir).toBe(await realpath(h.inputDir));
      for (const [name, bytes] of Object.entries(h.originals)) {
        expect(await readFile(join(record.run_dir, "input", "tiny", name))).toEqual(bytes);
        expect(await readFile(join(alias, name))).toEqual(bytes);
      }
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test("relative input symlink-parent traversal selects physical rather than lexical input bytes", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      const physical = join(h.root, "physical");
      await mkdir(join(physical, "child"), { recursive: true });
      await writeInputTree(join(physical, "input"), undefined, "physical input\n");
      await writeInputTree(join(h.cwd, "input"), undefined, "lexical input\n");
      await symlink(join(physical, "child"), join(h.cwd, "alias"));
      await h.apply(ShudJobRegistry, h.config);
      const record: RunJob = await actualRegistry(h.ctx).submitShud(
        { ...h.request, input_dir: "alias/../input" },
        execution.start,
      );
      expect(record.input_dir).toBe(await realpath(join(physical, "input")));
      expect(
        await readFile(join(record.run_dir, "input", "tiny", "nested", "forcing.dat"), "utf8"),
      ).toBe("physical input\n");
      expect(await readFile(join(h.cwd, "input", "nested", "forcing.dat"), "utf8")).toBe(
        "lexical input\n",
      );
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test("session cwd symlink-parent traversal records and creates runs in the physical workspace", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      const physical = join(h.root, "physical");
      await mkdir(join(physical, "child"), { recursive: true });
      await writeInputTree(join(physical, "input"), undefined, "physical workspace input\n");
      await symlink(join(physical, "child"), join(h.root, "alias"));
      await h.apply(ShudJobRegistry, h.config);
      // Keep the literal /../: path.join would erase the distinction this test guards.
      const record: RunJob = await actualRegistry(h.ctx).submitShud(
        { ...h.request, cwd: `${h.root}/alias/..`, input_dir: "input" },
        execution.start,
      );
      expect(record.run_dir).toBe(join(await realpath(physical), "runs", record.run_id));
      expect(record.input_dir).toBe(await realpath(join(physical, "input")));
      expect(
        await readFile(join(record.run_dir, "input", "tiny", "nested", "forcing.dat"), "utf8"),
      ).toBe("physical workspace input\n");
      expect(await readdir(h.root)).not.toContain("runs");
      expect(await readFile(join(h.inputDir, "nested", "forcing.dat"))).toEqual(
        h.originals["nested/forcing.dat"],
      );
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test("a symlinked runs directory is rejected without touching its target", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      const foreign = join(h.root, "foreign");
      await mkdir(foreign);
      await writeFile(join(foreign, "sentinel"), "foreign bytes\n");
      await symlink(foreign, join(h.cwd, "runs"));
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow(/runs/u);
      expect(await readdir(foreign)).toEqual(["sentinel"]);
      expect(await readFile(join(foreign, "sentinel"), "utf8")).toBe("foreign bytes\n");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(registry.list()).toEqual([]);
      expect(execution.handles).toEqual([]);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test.each(["symlink", "fifo"])(
    "an internal %s is rejected before creating runs",
    async (kind) => {
      const h = await submissionFixture();
      const execution = submissionProducer();
      try {
        const unsafe = join(h.inputDir, "nested", "unsafe-entry");
        if (kind === "symlink") {
          const external = join(h.root, "external");
          await writeFile(external, "private input content must not enter errors\n");
          await symlink(external, unsafe);
        } else execFileSync("mkfifo", [unsafe]);
        await h.apply(ShudJobRegistry, h.config);
        const registry = actualRegistry(h.ctx);
        await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow(
          "nested/unsafe-entry",
        );
        expect(await readdir(h.cwd)).not.toContain("runs");
        expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
        expect(execution.handles).toEqual([]);
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );

  test("a canonical run root inside the input tree is rejected before mkdir", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await writeInputTree(h.cwd);
      const alias = join(h.root, "workspace-input-alias");
      await symlink(h.cwd, alias);
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await expect(
        registry.submitShud({ ...h.request, input_dir: alias }, execution.start),
      ).rejects.toThrow(/input/u);
      expect(await readdir(h.cwd)).not.toContain("runs");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(execution.handles).toEqual([]);
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test("a missing project parameter file is rejected before mkdir", async () => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await rm(join(h.inputDir, "tiny.cfg.para"));
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      await expect(registry.submitShud(h.request, execution.start)).rejects.toThrow(
        "tiny.cfg.para",
      );
      expect(await readdir(h.cwd)).not.toContain("runs");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    } finally {
      await execution.finish();
      await h.dispose();
    }
  });

  test.each(["../escape", "nested/project", "/absolute", ".", ".."])(
    "project %j cannot escape its one-component input destination",
    async (project) => {
      const h = await submissionFixture();
      const execution = submissionProducer();
      try {
        await h.apply(ShudJobRegistry, h.config);
        const registry = actualRegistry(h.ctx);
        await expect(
          registry.submitShud({ ...h.request, project }, execution.start),
        ).rejects.toThrow(/project/u);
        expect(await readdir(h.cwd)).not.toContain("runs");
        expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
        expect(execution.handles).toEqual([]);
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );
});

describe("capture destinations preserve original input trees", () => {
  test.each([
    ["stacks", false],
    ["stacks", true],
    ["provenance", false],
    ["provenance", true],
  ] as const)(
    "input rooted at %s rejects before effects; input alias=%s",
    async (destination, aliased) => {
      const h = await submissionFixture();
      const execution = submissionProducer();
      try {
        const input = join(h.cwd, destination);
        await writeInputTree(input);
        const alias = join(h.root, "capture-input-alias");
        if (aliased) await symlink(input, alias);
        await h.apply(ShudJobRegistry, h.config);
        const registry = actualRegistry(h.ctx);
        const inputBefore = await snapshotTree(input);
        const workspaceBefore = await snapshotTree(h.cwd);
        const stateBefore = await snapshotTree(h.stateDir);
        const indexesBefore = registry.indexes.read();
        vi.mocked(io.mkdir).mockClear();
        vi.mocked(io.copyFile).mockClear();
        vi.mocked(io.rename).mockClear();

        await expect(
          registry.submitShud(
            {
              ...h.request,
              project: "tiny",
              input_dir: aliased ? alias : input,
            },
            execution.start,
          ),
        ).rejects.toThrow(/input/u);

        expect(await snapshotTree(input)).toEqual(inputBefore);
        expect(await snapshotTree(h.cwd)).toEqual(workspaceBefore);
        expect(await snapshotTree(h.stateDir)).toEqual(stateBefore);
        expect(registry.indexes.read()).toEqual(indexesBefore);
        expect(registry.list()).toEqual([]);
        expect(execution.handles).toEqual([]);
        expect(io.mkdir).not.toHaveBeenCalled();
        expect(io.copyFile).not.toHaveBeenCalled();
        expect(io.rename).not.toHaveBeenCalled();
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );

  test.each(["stacks", "provenance"])(
    "disjoint %s-input is not confused with a capture destination",
    async (destination) => {
      const h = await submissionFixture();
      const execution = submissionProducer();
      try {
        const input = join(h.cwd, `${destination}-input`);
        await writeInputTree(input);
        const before = await snapshotTree(input);
        await h.apply(ShudJobRegistry, h.config);
        const registry = actualRegistry(h.ctx);
        const record = await registry.submitShud(
          {
            ...h.request,
            project: "tiny",
            input_dir: input,
          },
          execution.start,
        );
        expect(record.input_dir).toBe(await realpath(input));
        expect(record.status).toBe("running");
        expect(record.stack_id).toMatch(/^STACK-/u);
        expect(record.data_id).toMatch(/^DATA-/u);
        expect(await snapshotTree(input)).toEqual(before);
        expect(await snapshotTree(join(record.run_dir, "input", "tiny"))).toEqual(before);
        expect(registry.indexes.read().active).toEqual([
          { run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir },
        ]);
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );

  test.each(["stacks", "provenance"])(
    "input below %s is not itself an output-root overlap",
    async (destination) => {
      const h = await submissionFixture();
      const execution = submissionProducer();
      try {
        const input = join(h.cwd, destination, "original-input");
        await writeInputTree(input);
        const before = await snapshotTree(input);
        await h.apply(ShudJobRegistry, h.config);
        const registry = actualRegistry(h.ctx);
        const pending = registry.submitShud(
          {
            ...h.request,
            project: "tiny",
            input_dir: input,
          },
          execution.start,
        );
        if (destination === "stacks") {
          // The existing lock reader rejects this unrelated directory entry, not input overlap.
          await expect(pending).rejects.toThrow(/Stack capture/u);
          expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
          expect(execution.handles).toEqual([]);
        } else {
          const record = await pending;
          expect(record.status).toBe("running");
          expect(record.input_dir).toBe(await realpath(input));
          expect(record.data_id).toMatch(/^DATA-/u);
          expect(await snapshotTree(join(record.run_dir, "input", "tiny"))).toEqual(before);
          expect((await readdir(join(h.cwd, "provenance"))).sort()).toEqual(
            [`${record.data_id}.json`, "original-input"].sort(),
          );
        }
        expect(await snapshotTree(input)).toEqual(before);
      } finally {
        await execution.finish();
        await h.dispose();
      }
    },
  );
});
