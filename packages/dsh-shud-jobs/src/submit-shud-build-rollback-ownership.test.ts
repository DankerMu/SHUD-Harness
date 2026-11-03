import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { beforeEach, expect, test, vi } from "vitest";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { createHarness, producer } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import {
  binaryBytes,
  buildFixture,
  fileSnapshot,
  names,
} from "./submit-shud-build/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    openSync: vi.fn(actual.openSync),
    lstatSync: vi.fn(actual.lstatSync),
    readdirSync: vi.fn(actual.readdirSync),
  };
});
const native = await vi.importActual<typeof NodeIo>("node:fs/promises");
const nativeFs = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(native.rename);
  vi.mocked(io.rm).mockReset().mockImplementation(native.rm);
  vi.mocked(fs.openSync).mockReset().mockImplementation(nativeFs.openSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(nativeFs.lstatSync);
  vi.mocked(fs.readdirSync).mockReset().mockImplementation(nativeFs.readdirSync);
});

function replaceBinaryChild(runDir: string, root: string, kind: string) {
  const bin = join(runDir, "bin");
  expect(nativeFs.readFileSync(join(bin, "shud")).equals(binaryBytes)).toBe(true);
  let path: string;
  if (kind === "bin") {
    nativeFs.renameSync(bin, join(root, "owned-bin-before-late-failure"));
    nativeFs.mkdirSync(bin);
    path = join(bin, "foreign-sentinel");
  } else if (kind === "target") {
    path = join(bin, "shud");
    nativeFs.renameSync(path, join(root, "owned-shud-before-late-failure"));
  } else {
    path = join(bin, kind === "temporary" ? ".shud.tmp" : "foreign-sibling");
  }
  nativeFs.writeFileSync(path, "foreign post-preparation bytes\n");
  return path;
}

const lateCases = [
  ...[
    "provenance",
    "created",
    "active",
    "submitted",
    "identified",
    "running",
    "parent-start",
    "producer",
    "startup",
  ].map((phase) => ({ phase, kind: "target" })),
  { phase: "provenance", kind: "bin" },
  { phase: "created", kind: "temporary" },
  { phase: "startup", kind: "sibling" },
];

test.each(lateCases)(
  "$phase failure retains foreign $kind after binary preparation",
  async ({ phase, kind }) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const primary = new Error(`injected ${phase} failure`);
    let runDir = "";
    let foreign = "";
    let mutations = 0;
    let captured: RunJob | undefined;
    let writes = 0;
    let recursiveRemovals = 0;
    const locks: Array<{ path: string; bytes: Buffer; ino: bigint; mtimeNs: bigint }> = [];
    try {
      await h.apply(ShudJobRegistry, { ...h.config, maxConcurrentJobsPerOwner: 1 });
      const registry = actualRegistry(h.ctx);
      function mutate() {
        expect(runDir).not.toBe("");
        expect(mutations).toBe(0);
        mutations++;
        foreign = replaceBinaryChild(runDir, h.root, kind);
        for (const name of nativeFs.readdirSync(join(h.cwd, "stacks"))) {
          const path = join(h.cwd, "stacks", name);
          const stat = nativeFs.statSync(path, { bigint: true });
          locks.push({
            path,
            bytes: nativeFs.readFileSync(path),
            ino: stat.ino,
            mtimeNs: stat.mtimeNs,
          });
        }
        expect(locks).toHaveLength(1);
      }
      vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
        if (
          phase === "provenance" &&
          String(path).startsWith(`${h.cwd}/provenance/`) &&
          flags === "wx"
        ) {
          mutate();
          throw Object.assign(primary, { code: "EACCES" });
        }
        return nativeFs.openSync(path, flags, mode);
      });
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/bin/shud")) {
          await native.rename(source, target);
          runDir = dirname(dirname(String(target)));
          return;
        }
        if (String(target).endsWith("/run-job.json")) {
          captured = RunJobSchema.parse(JSON.parse(await native.readFile(source, "utf8")));
          writes++;
          const selected = { created: 1, submitted: 2, identified: 3, running: 4 };
          if (phase in selected && writes === selected[phase as keyof typeof selected]) {
            mutate();
            throw primary;
          }
          if (phase === "parent-start" && writes === 2) mutate();
        }
        if (phase === "active" && target === join(h.stateDir, "active.json")) {
          mutate();
          throw primary;
        }
        await native.rename(source, target);
      });
      vi.mocked(io.rm).mockImplementation(async (path, options) => {
        if (path === runDir) recursiveRemovals++;
        await native.rm(path, options);
      });
      if (phase === "parent-start") {
        await h.attachController(false);
        registry.start(producer().spec);
      }
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, (record, handle, cadence) => {
          if (phase === "producer") {
            mutate();
            throw primary;
          }
          const started = execution.start(record, handle, cadence);
          if (phase !== "startup") return started;
          return {
            ...started,
            started: started.started.then(() => {
              mutate();
              throw primary;
            }),
          };
        })
        .catch((error: unknown) => error);
      expect(mutations).toBe(1);
      const launched = ["identified", "running", "startup"].includes(phase);
      expect(execution.executions).toHaveLength(launched ? 1 : 0);
      for (const started of execution.executions) {
        await started.waitForExit();
        expect(started.isGroupActive()).toBe(false);
      }
      if (launched) expect(execution.cancellations).toContain("SHUD submission rolled back");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      for (const handle of execution.handles)
        expect(registry.list().map((job) => job.id)).not.toContain(handle.id);
      // Byte preservation is the semantic oracle; a generic rejection is not sufficient.
      expect(await native.readFile(foreign, "utf8")).toBe("foreign post-preparation bytes\n");
      expect(recursiveRemovals).toBe(0);
      expect(await names(join(h.cwd, "runs"))).toEqual([basename(runDir)]);
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError))
        throw new Error("Expected incomplete ownership cleanup");
      expect(outcome.message).toMatch(/cleanup incomplete.*retained run path/iu);
      const cause: unknown = outcome.errors[0];
      expect(cause).toBeInstanceOf(Error);
      if (!(cause instanceof Error)) throw new Error("Expected preserved primary error");
      expect(cause.message).toMatch(
        phase === "parent-start"
          ? /limit/iu
          : phase === "provenance"
            ? /provenance/iu
            : new RegExp(`injected ${phase} failure`, "u"),
      );
      if (!["provenance", "parent-start", "producer"].includes(phase)) expect(cause).toBe(primary);
      for (const lock of locks) {
        const after = await fileSnapshot(lock.path);
        expect(after.bytes.equals(lock.bytes)).toBe(true);
        expect(after.ino).toBe(lock.ino);
        expect(after.mtimeNs).toBe(lock.mtimeNs);
      }
      if (captured) {
        expect(registry.isSubmissionInFlight(captured.run_id)).toBe(true);
        expect(await names(join(h.cwd, "provenance"))).toEqual([`${captured.data_id}.json`]);
      } else expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);

test.each([
  { operation: "lstat", child: "bin" },
  { operation: "lstat", child: "shud" },
  { operation: "lstat", child: ".shud.tmp" },
  { operation: "readdir", child: "bin" },
])(
  "late rollback $operation uncertainty for $child preserves the run and original failure",
  async ({ operation, child }) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const primary = new Error("injected created failure before ownership inspection");
    let armed = false;
    let runDir = "";
    let target = "";
    let inspections = 0;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, destination) => {
        if (String(destination).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await native.readFile(source, "utf8")));
          if (record.status === "created") {
            runDir = record.run_dir;
            target = child === "bin" ? join(runDir, "bin") : join(runDir, "bin", child);
            armed = true;
            throw primary;
          }
        }
        await native.rename(source, destination);
      });
      vi.mocked(fs.lstatSync).mockImplementation((...args) => {
        if (armed && operation === "lstat" && args[0] === target) {
          inspections++;
          throw Object.assign(new Error("private ownership inspection payload"), {
            code: "EACCES",
          });
        }
        return nativeFs.lstatSync(...args);
      });
      vi.mocked(fs.readdirSync).mockImplementation((...args) => {
        if (armed && operation === "readdir" && args[0] === target) {
          inspections++;
          throw Object.assign(new Error("private ownership inspection payload"), { code: "EIO" });
        }
        return nativeFs.readdirSync(...args);
      });
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(armed).toBe(true);
      armed = false;
      expect(inspections).toBe(1);
      expect((await native.readFile(join(runDir, "bin", "shud"))).equals(binaryBytes)).toBe(true);
      expect(outcome).toBeInstanceOf(AggregateError);
      if (!(outcome instanceof AggregateError))
        throw new Error("Expected uncertain ownership failure");
      expect(outcome.errors[0]).toBe(primary);
      expect(outcome.message).toContain("retained run path");
      expect(outcome.message).not.toContain("private ownership inspection payload");
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
      expect(await names(join(h.cwd, "provenance"))).toHaveLength(1);
      await h.assertReadonly();
    } finally {
      armed = false;
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["owned", "foreign"])(
  "shutdown drains accepted late rollback with %s binary before unlock",
  async (ownership) => {
    const h = await buildFixture();
    const contender = await createHarness();
    const execution = submissionProducer();
    const entered = barrier();
    const release = barrier();
    const primary = new Error("injected running publication failure");
    let pending: Promise<unknown> | undefined;
    let disposing: Promise<void> | undefined;
    let runDir = "";
    let foreign = "";
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await native.readFile(source, "utf8")));
          if (record.status === "running") {
            runDir = record.run_dir;
            if (ownership === "foreign") foreign = replaceBinaryChild(runDir, h.root, "target");
            throw primary;
          }
        }
        await native.rename(source, target);
      });
      pending = registry
        .submitShud(h.buildRequest, (record, handle, cadence) => {
          const started = execution.start(record, handle, cadence);
          return {
            ...started,
            async abort() {
              await started.abort();
              entered.release();
              await release.waiting;
            },
          };
        })
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
      expect(execution.executions).toHaveLength(1);
      expect(execution.executions[0].isGroupActive()).toBe(false);
      expect(await io.readdir(h.stateDir)).toContain("lock");
      await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
      expect(await names(join(h.cwd, "runs"))).toEqual([basename(runDir)]);
      expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
      expect(await names(join(h.cwd, "provenance"))).toHaveLength(1);
      release.release();
      const outcome = await pending;
      await disposing;
      expect(await io.readdir(h.stateDir)).not.toContain("lock");
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      if (ownership === "foreign") {
        expect(await native.readFile(foreign, "utf8")).toBe("foreign post-preparation bytes\n");
        expect(outcome).toBeInstanceOf(AggregateError);
        if (!(outcome instanceof AggregateError)) throw new Error("Expected retained run failure");
        expect(outcome.errors[0]).toBe(primary);
        expect(outcome.message).toContain("retained run path");
        expect(await names(join(h.cwd, "provenance"))).toHaveLength(1);
      } else {
        expect(outcome).toBe(primary);
        expect(await names(join(h.cwd, "runs"))).toEqual([]);
        expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      }
      expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
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
