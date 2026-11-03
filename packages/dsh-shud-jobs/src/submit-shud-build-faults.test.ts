import * as io from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import { binaryBytes, buildFixture, names } from "./submit-shud-build/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return {
    ...actual,
    mkdir: vi.fn(actual.mkdir),
    rename: vi.fn(actual.rename),
    rm: vi.fn(actual.rm),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  vi.mocked(io.mkdir).mockReset().mockImplementation(actualIo.mkdir);
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.rm).mockReset().mockImplementation(actualIo.rm);
});

function isBinary(path: unknown) {
  return typeof path === "string" && path.endsWith("/bin/shud");
}

test.each(["bin-directory", "binary-rename"])(
  "%s failure leaves no run, index, capture or fallback",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    let failures = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.mkdir).mockImplementation(async (...args) => {
        if (phase === "bin-directory" && String(args[0]).endsWith("/bin")) {
          failures++;
          throw Object.assign(new Error("injected binary destination denial"), { code: "EACCES" });
        }
        return actualIo.mkdir(...args);
      });
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (phase === "binary-rename" && isBinary(target)) {
          failures++;
          expect(dirname(String(source))).toBe(dirname(String(target)));
          expect(source).not.toBe(target);
          expect(await io.readFile(source)).toEqual(binaryBytes);
          expect((await io.stat(source)).mode & 0o777).toBe(0o755);
          expect(await names(join(h.cwd, "stacks"))).toEqual([]);
          expect(await names(join(h.cwd, "provenance"))).toEqual([]);
          throw Object.assign(new Error("injected binary publication denial"), { code: "EACCES" });
        }
        await actualIo.rename(source, target);
      });
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        h.build.build_id,
      );
      expect(failures).toBe(1);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test("binary publication revalidates run ownership and never captures into a foreign replacement", async () => {
  const h = await buildFixture();
  const execution = submissionProducer();
  let replacement = "";
  try {
    await h.apply(ShudJobRegistry, h.config);
    const registry = actualRegistry(h.ctx);
    vi.mocked(io.rename).mockImplementation(async (source, target) => {
      await actualIo.rename(source, target);
      if (isBinary(target)) {
        replacement = dirname(dirname(String(target)));
        await actualIo.rename(replacement, join(h.root, "owned-run"));
        await actualIo.mkdir(replacement);
        await io.writeFile(join(replacement, "foreign-sentinel"), "foreign run bytes\n");
      }
    });
    await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
      /ownership|retained run path/iu,
    );
    expect(replacement).not.toBe("");
    expect(await io.readdir(replacement)).toEqual(["foreign-sentinel"]);
    expect(await io.readFile(join(replacement, "foreign-sentinel"), "utf8")).toBe(
      "foreign run bytes\n",
    );
    expect(execution.handles).toEqual([]);
    expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
    expect(await names(join(h.cwd, "stacks"))).toEqual([]);
    expect(await names(join(h.cwd, "provenance"))).toEqual([]);
    await h.assertReadonly();
  } finally {
    await execution.finish();
    await h.dispose();
  }
});

test.each(["copy-publication", "rollback"])(
  "shutdown drains accepted binary %s before releasing state ownership",
  async (phase) => {
    const h = await buildFixture();
    const contender = await createHarness();
    const execution = submissionProducer();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let disposing: Promise<void> | undefined;
    let failedRun = "";
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (isBinary(target)) {
          failedRun = dirname(dirname(String(target)));
          if (phase === "copy-publication") {
            entered.release();
            await release.waiting;
          }
          throw new Error("injected binary publication failure");
        }
        await actualIo.rename(source, target);
      });
      vi.mocked(io.rm).mockImplementation(async (path, options) => {
        if (phase === "rollback" && path === failedRun) {
          entered.release();
          await release.waiting;
        }
        await actualIo.rm(path, options);
      });
      pending = registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(
        await Promise.race([entered.waiting.then(() => "held"), pending.then(() => "settled")]),
      ).toBe("held");
      disposing = Promise.resolve(h.ctx.fiber.dispose());
      await expect
        .poll(async () => {
          try {
            await registry.submitShud({ ...h.request, project: "../invalid" }, execution.start);
            return "accepted";
          } catch (error) {
            return error instanceof Error ? error.message : "unknown";
          }
        })
        .toContain("admission is closed");
      await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
      expect(await io.readdir(h.stateDir)).toContain("lock");
      expect(await names(join(h.cwd, "runs"))).toEqual([basename(failedRun)]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      release.release();
      expect(await pending).toBeInstanceOf(Error);
      await disposing;
      expect(await io.readdir(h.stateDir)).not.toContain("lock");
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(execution.handles).toEqual([]);
      await contender.apply(ShudJobRegistry, h.config);
      expect(actualRegistry(contender.ctx).indexes.read()).toEqual({ active: [], completed: [] });
      await h.assertReadonly();
    } finally {
      release.release();
      await pending;
      await disposing;
      await contender.dispose();
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);

test.each(["created", "active", "submitted", "identified", "running"])(
  "later %s failure removes the copied binary but retains the captured build lock",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    let stackId: string | null = null;
    let writes = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          expect(record.build_id).toBe(h.build.build_id);
          stackId = record.stack_id;
          expect(await io.readFile(join(record.run_dir, "bin", "shud"))).toEqual(binaryBytes);
          const selected = { created: 1, submitted: 2, identified: 3, running: 4 };
          writes++;
          if (phase in selected && writes === selected[phase as keyof typeof selected])
            throw new Error(`injected ${phase} failure`);
        }
        if (phase === "active" && target === join(h.stateDir, "active.json"))
          throw new Error("injected active failure");
        await actualIo.rename(source, target);
      });
      await expect(registry.submitShud(h.buildRequest, execution.start)).rejects.toThrow(
        `injected ${phase} failure`,
      );
      expect(stackId).toMatch(/^STACK-/u);
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([`${stackId}.json`]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(registry.list()).toEqual([]);
      await h.assertReadonly();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);
