import * as fs from "node:fs";
import { join } from "node:path";
import type * as NodeFs from "node:fs";
import { beforeEach, expect, test, vi } from "vitest";
import { ShudJobRegistry } from "./index.ts";
import { actualRegistry, submissionProducer } from "./submit-shud/test-harness.ts";
import { buildFixture, names } from "./submit-shud-build/test-harness.ts";

vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return {
    ...actual,
    accessSync: vi.fn(actual.accessSync),
    openSync: vi.fn(actual.openSync),
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
    closeSync: vi.fn(actual.closeSync),
  };
});
const native = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.accessSync).mockReset().mockImplementation(native.accessSync);
  vi.mocked(fs.openSync).mockReset().mockImplementation(native.openSync);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(native.readFileSync);
  vi.mocked(fs.readSync).mockReset().mockImplementation(native.readSync);
  vi.mocked(fs.closeSync).mockReset().mockImplementation(native.closeSync);
});

// These are the existing records verifier's OS boundaries, reached only through submitShud.
// Copy-specific descriptor/stream boundaries are intentionally not invented before implementation.
test.each(["execute-permission", "record-read", "binary-open", "binary-read", "binary-close"])(
  "%s failure aborts the build transaction without claiming a failed close succeeded",
  async (phase) => {
    const h = await buildFixture();
    const execution = submissionProducer();
    const live = new Set<number>();
    let faults = 0;
    const denied = () => {
      faults++;
      throw Object.assign(new Error("private source IO payload"), { code: "EACCES" });
    };
    try {
      await h.apply(ShudJobRegistry, h.config);
      const registry = actualRegistry(h.ctx);
      vi.mocked(fs.accessSync).mockImplementation((path, mode) => {
        if (phase === "execute-permission" && path === h.source && mode === fs.constants.X_OK)
          denied();
        return native.accessSync(path, mode);
      });
      vi.mocked(fs.readFileSync).mockImplementation((...args) => {
        if (phase === "record-read" && args[0] === h.recordPath) denied();
        return native.readFileSync(...args);
      });
      vi.mocked(fs.openSync).mockImplementation((path, flags, mode) => {
        if (phase === "binary-open" && path === h.source) denied();
        const fd = native.openSync(path, flags, mode);
        if (path === h.source) live.add(fd);
        return fd;
      });
      vi.mocked(fs.readSync).mockImplementation((...args) => {
        if (phase === "binary-read" && live.has(args[0])) denied();
        return native.readSync(...args);
      });
      vi.mocked(fs.closeSync).mockImplementation((fd) => {
        if (phase === "binary-close" && live.has(fd)) denied();
        native.closeSync(fd);
        live.delete(fd);
      });
      const outcome: unknown = await registry
        .submitShud(h.buildRequest, execution.start)
        .catch((error: unknown) => error);
      expect(outcome).toBeInstanceOf(Error);
      if (!(outcome instanceof Error)) throw new Error("Build IO failure unexpectedly executed");
      expect(outcome.message).toContain(h.build.build_id);
      expect(outcome.message).toMatch(/target|permission|EACCES|open|read|close|executable/iu);
      expect(outcome.message).not.toContain("private source IO payload");
      expect(faults).toBe(phase === "binary-close" ? 2 : 1);
      expect(live.size).toBe(phase === "binary-close" ? 1 : 0);
      // Existing records verification attempts cleanup after its first failed close.
      // Both injected attempts fail before the syscall: neither proves this fd closed.
      for (const fd of live) expect(native.fstatSync(fd).isFile()).toBe(true);
      expect(execution.handles).toEqual([]);
      expect(registry.indexes.read()).toEqual({ active: [], completed: [] });
      expect(await names(join(h.cwd, "runs"))).toEqual([]);
      expect(await names(join(h.cwd, "stacks"))).toEqual([]);
      expect(await names(join(h.cwd, "provenance"))).toEqual([]);
      await h.assertReadonly();
    } finally {
      for (const fd of live) native.closeSync(fd);
      live.clear();
      await execution.finish();
      await h.dispose();
    }
  },
);
