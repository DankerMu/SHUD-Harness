import * as fs from "node:fs";
import * as io from "node:fs/promises";
import { basename, join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeFs from "node:fs";
import type * as NodeIo from "node:fs/promises";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { captureStackLock } from "@shud-harness/dsh-shud-records";
import { ShudJobRegistry, type Config, type SubmitShudRequest } from "./index.ts";
import { createHarness, producer } from "./test-harness.ts";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  actualRegistry,
  submissionFixture,
  submissionProducer,
} from "./submit-shud/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, rename: vi.fn(actual.rename), rm: vi.fn(actual.rm) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    createReadStream: vi.fn(actual.createReadStream),
    openSync: vi.fn(actual.openSync),
    renameSync: vi.fn(actual.renameSync),
  };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
const actualFs = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(io.rename).mockReset().mockImplementation(actualIo.rename);
  vi.mocked(io.rm).mockReset().mockImplementation(actualIo.rm);
  vi.mocked(fs.createReadStream).mockReset().mockImplementation(actualFs.createReadStream);
  vi.mocked(fs.openSync).mockReset().mockImplementation(actualFs.openSync);
  vi.mocked(fs.renameSync).mockReset().mockImplementation(actualFs.renameSync);
});

async function names(path: string) {
  try {
    return (await io.readdir(path)).sort();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return [];
    throw error;
  }
}

async function preservedEvidence(h: { cwd: string; config: Config; request: SubmitShudRequest }) {
  const lock = captureStackLock(
    { ...h.config, cwd: h.cwd, hostVersion: "previous-host" },
    h.request.llm,
  );
  const path = join(h.cwd, "stacks", `${lock.stack_id}.json`);
  const bytes = await io.readFile(path);
  const stat = await io.stat(path, { bigint: true });
  const foreign = join(h.cwd, "provenance", "DATA-20261029T031500-ffff.json");
  await io.mkdir(join(h.cwd, "provenance"), { recursive: true });
  await io.writeFile(foreign, "unrelated provenance bytes\n");
  return {
    lock,
    foreign,
    async assert() {
      expect(await io.readFile(path)).toEqual(bytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
      expect(await io.readFile(foreign, "utf8")).toBe("unrelated provenance bytes\n");
    },
  };
}

test.each(["created", "active", "submitted", "identified", "running", "parent-start", "startup"])(
  "%s failure removes only this run and provenance, retaining old and new/reused locks",
  async (phase) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      await h.apply(ShudJobRegistry, { ...h.config, maxConcurrentJobsPerOwner: 1 });
      const registry = actualRegistry(h.ctx);
      const evidence = await preservedEvidence(h);
      // Seed a matching immutable lock on alternating phases; all other phases must retain a new one.
      const reused = ["active", "identified", "parent-start"].includes(phase)
        ? captureStackLock({ ...h.config, cwd: h.cwd }, h.request.llm)
        : undefined;
      const reusedPath = reused && join(h.cwd, "stacks", `${reused.stack_id}.json`);
      const reusedBefore = reusedPath && {
        bytes: await io.readFile(reusedPath),
        stat: await io.stat(reusedPath, { bigint: true }),
      };
      let captured: RunJob | undefined;
      let writes = 0;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          captured = record;
          writes++;
          expect(record.data_id).toMatch(/^DATA-/u);
          expect(fs.existsSync(join(h.cwd, "provenance", `${record.data_id}.json`))).toBe(true);
          const selected = { created: 1, submitted: 2, identified: 3, running: 4 };
          if (phase in selected && writes === selected[phase as keyof typeof selected])
            throw new Error(`injected ${phase} failure`);
        }
        if (phase === "active" && target === join(h.stateDir, "active.json"))
          throw new Error("injected active failure");
        await actualIo.rename(source, target);
      });
      if (phase === "parent-start") {
        await h.attachController(false);
        // Exercise the real parent admission limit, not a substitute registration implementation.
        registry.start(producer().spec);
      }
      await expect(
        registry.submitShud(h.request, (record, handle, cadence) => {
          const started = execution.start(record, handle, cadence);
          if (phase !== "startup") return started;
          return {
            ...started,
            started: started.started.then(() => {
              throw new Error("injected startup failure");
            }),
          };
        }),
      ).rejects.toThrow(phase === "parent-start" ? /limit/u : `injected ${phase} failure`);
      expect(captured).toBeDefined();
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([basename(evidence.foreign)]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "stacks"))).toEqual(
        [`${evidence.lock.stack_id}.json`, `${captured?.stack_id}.json`].sort(),
      );
      if (captured) expect(registry.isSubmissionInFlight(captured.run_id)).toBe(false);
      if (reusedPath && reusedBefore) {
        expect(await io.readFile(reusedPath)).toEqual(reusedBefore.bytes);
        expect((await io.stat(reusedPath, { bigint: true })).mtimeNs).toBe(
          reusedBefore.stat.mtimeNs,
        );
      }
      await evidence.assert();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
  15000,
);

test.each(["repository", "corrupt-lock", "provenance-file", "provenance-link", "provenance-write"])(
  "%s capture failure aborts before first created write and preserves foreign evidence",
  async (kind) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    try {
      const config = { ...h.config, stackRepos: { ...h.config.stackRepos } };
      const evidence = await preservedEvidence(h);
      const matching =
        kind === "provenance-write"
          ? captureStackLock({ ...h.config, cwd: h.cwd }, h.request.llm)
          : undefined;
      const retained = await Promise.all(
        (await names(join(h.cwd, "stacks"))).map(async (name) => {
          const path = join(h.cwd, "stacks", name);
          return {
            path,
            bytes: await io.readFile(path),
            mtime: (await io.stat(path, { bigint: true })).mtimeNs,
          };
        }),
      );
      if (kind === "repository") {
        const empty = join(h.root, "not-a-repository");
        await io.mkdir(empty);
        config.stackRepos.rSHUD = empty;
      }
      const corrupt = join(h.cwd, "stacks", "STACK-20261029T031500-ffff.json");
      if (kind === "corrupt-lock") await io.writeFile(corrupt, "not JSON\n");
      const provenance = join(await io.realpath(h.cwd), "provenance");
      if (kind === "provenance-file" || kind === "provenance-link") {
        await io.rename(provenance, join(h.root, "foreign-provenance"));
        if (kind === "provenance-file") await io.writeFile(provenance, "foreign file\n");
        else await io.symlink(join(h.root, "foreign-provenance"), provenance);
      }
      await h.apply(ShudJobRegistry, config);
      let writes = 0;
      let writeDenials = 0;
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) writes++;
        await actualIo.rename(source, target);
      });
      if (kind === "provenance-write")
        vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
          if (String(path).startsWith(`${provenance}/`) && flags === "wx") {
            writeDenials++;
            throw new Error("injected provenance write denial");
          }
          return actualFs.openSync(path, flags, mode);
        });
      await expect(actualRegistry(h.ctx).submitShud(h.request, execution.start)).rejects.toThrow();
      if (kind === "provenance-write") expect(writeDenials).toBe(1);
      expect(writes).toBe(0);
      expect(execution.handles).toEqual([]);
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [], completed: [] });
      for (const saved of retained) {
        expect(await io.readFile(saved.path)).toEqual(saved.bytes);
        expect((await io.stat(saved.path, { bigint: true })).mtimeNs).toBe(saved.mtime);
      }
      if (matching) {
        expect(await names(join(h.cwd, "stacks"))).toHaveLength(2);
        expect(await names(provenance)).toEqual([basename(evidence.foreign)]);
      }
      if (kind === "corrupt-lock") expect(await io.readFile(corrupt, "utf8")).toBe("not JSON\n");
      if (kind === "provenance-file")
        expect(await io.readFile(provenance, "utf8")).toBe("foreign file\n");
      else if (kind === "provenance-link")
        expect((await io.lstat(provenance)).isSymbolicLink()).toBe(true);
      if (kind.startsWith("provenance-") && kind !== "provenance-write") {
        expect(
          await io.readFile(join(h.root, "foreign-provenance", basename(evidence.foreign)), "utf8"),
        ).toBe("unrelated provenance bytes\n");
      } else await evidence.assert();
    } finally {
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["file", "link", "directory", "denied"])(
  "rollback retains foreign or unremovable provenance (%s) and fails closed",
  async (kind) => {
    const h = await submissionFixture();
    const execution = submissionProducer();
    let captured: RunJob | undefined;
    let path = "";
    let cleanupDenials = 0;
    try {
      const provenance = join(await io.realpath(h.cwd), "provenance");
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(io.rename).mockImplementation(async (source, target) => {
        if (String(target).endsWith("/run-job.json")) {
          const record = RunJobSchema.parse(JSON.parse(await io.readFile(source, "utf8")));
          if (record.status === "created") {
            captured = record;
            path = join(provenance, `${record.data_id}.json`);
            expect(fs.existsSync(path)).toBe(true);
            if (kind === "directory") {
              await actualIo.rename(provenance, join(h.root, "owned-provenance"));
              await io.mkdir(provenance);
              await io.writeFile(path, "foreign replacement\n");
            } else if (kind !== "denied") {
              await actualIo.rename(path, join(h.root, "owned-data.json"));
              if (kind === "file") await io.writeFile(path, "foreign replacement\n");
              else {
                await io.writeFile(join(h.root, "foreign-data.json"), "foreign replacement\n");
                await io.symlink(join(h.root, "foreign-data.json"), path);
              }
            }
            throw new Error("injected created failure");
          }
        }
        await actualIo.rename(source, target);
      });
      vi.mocked(io.rm).mockImplementation(async (target, options) => {
        if (kind === "denied" && target === path) {
          cleanupDenials++;
          throw new Error("provenance cleanup denied");
        }
        await actualIo.rm(target, options);
      });
      const error: unknown = await registry
        .submitShud(h.request, execution.start)
        .catch((error: unknown) => error);
      if (kind === "denied") expect(cleanupDenials).toBe(1);
      expect(error).toBeInstanceOf(AggregateError);
      if (!(error instanceof AggregateError)) throw new Error("Expected aggregate cleanup error");
      expect(error.message).toContain("cleanup incomplete");
      expect(captured).toBeDefined();
      if (captured) expect(registry.isSubmissionInFlight(captured.run_id)).toBe(true);
      expect(fs.existsSync(path)).toBe(true);
      if (kind !== "denied") expect(await io.readFile(path, "utf8")).toBe("foreign replacement\n");
      if (kind === "link") expect((await io.lstat(path)).isSymbolicLink()).toBe(true);
      expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
    } finally {
      vi.mocked(io.rm).mockImplementation(actualIo.rm);
      await execution.finish();
      await h.dispose();
    }
  },
);

test.each(["capture", "rollback"])(
  "shutdown drains held provenance %s before releasing state ownership",
  async (phase) => {
    const h = await submissionFixture();
    const contender = await createHarness();
    const execution = submissionProducer();
    const entered = barrier();
    const release = barrier();
    let pending: Promise<unknown> | undefined;
    let disposing: Promise<void> | undefined;
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      if (phase === "capture")
        vi.mocked(fs.createReadStream).mockImplementation((path, options) => {
          const stream = actualFs.createReadStream(path, options);
          if (String(path).includes("/input/tiny/")) {
            const iterator = stream[Symbol.asyncIterator].bind(stream);
            Object.defineProperty(stream, Symbol.asyncIterator, {
              value: async function* () {
                entered.release();
                await release.waiting;
                yield* iterator();
              },
            });
          }
          return stream;
        });
      else
        vi.mocked(io.rm).mockImplementation(async (path, options) => {
          if (String(path).includes("/provenance/DATA-")) {
            entered.release();
            await release.waiting;
          }
          await actualIo.rm(path, options);
        });
      pending = registry
        .submitShud(h.request, () => {
          throw new Error("producer refuses start");
        })
        .catch((error: unknown) => error);
      const first = await Promise.race([
        entered.waiting.then(() => "held"),
        pending.then(() => "settled"),
      ]);
      expect(first).toBe("held");
      disposing = Promise.resolve(h.ctx.fiber.dispose());
      await expect
        .poll(async () => {
          try {
            await registry.submitShud({ ...h.request, project: "../invalid" }, execution.start);
          } catch (error) {
            return error instanceof Error ? error.message : "unknown";
          }
          return "accepted";
        })
        .toContain("admission is closed");
      await expect(contender.apply(ShudJobRegistry, h.config)).rejects.toThrow(h.stateDir);
      expect(await io.readdir(h.stateDir)).toContain("lock");
      expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
      release.release();
      expect(await pending).toBeInstanceOf(Error);
      await disposing;
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      expect(await io.readdir(h.stateDir)).not.toContain("lock");
      await contender.apply(ShudJobRegistry, h.config);
      expect(actualRegistry(contender.ctx).indexes.read()).toEqual({ active: [], completed: [] });
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

test("provenance await revalidates the owned run directory before publishing created", async () => {
  const h = await submissionFixture();
  const execution = submissionProducer();
  let replaced = "";
  try {
    await h.apply(ShudJobRegistry, h.config);
    vi.mocked(fs.renameSync).mockImplementation((source, target) => {
      actualFs.renameSync(source, target);
      if (String(target).includes("/provenance/DATA-")) {
        const runs = actualFs.readdirSync(join(h.cwd, "runs"));
        expect(runs).toHaveLength(1);
        replaced = join(h.cwd, "runs", runs[0]);
        actualFs.renameSync(replaced, join(h.root, "owned-run"));
        actualFs.mkdirSync(replaced);
        actualFs.writeFileSync(join(replaced, "foreign-sentinel"), "foreign run bytes\n");
      }
    });
    await expect(actualRegistry(h.ctx).submitShud(h.request, execution.start)).rejects.toThrow();
    expect(replaced).not.toBe("");
    expect(await io.readdir(replaced)).toEqual(["foreign-sentinel"]);
    expect(await io.readFile(join(replaced, "foreign-sentinel"), "utf8")).toBe(
      "foreign run bytes\n",
    );
    expect(execution.handles).toEqual([]);
    expect(actualRegistry(h.ctx).indexes.read()).toEqual({ active: [], completed: [] });
    expect(await names(join(h.cwd, "stacks"))).toHaveLength(1);
  } finally {
    await execution.finish();
    await h.dispose();
  }
});
