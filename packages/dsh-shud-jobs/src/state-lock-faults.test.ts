import { readFile, readdir, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeFs from "node:fs";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";
import { publishedStore } from "./state-indexes/test-harness.ts";

const fault = vi.hoisted(() => ({ kind: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (command === "ps" && fault.kind === "indeterminate") {
        return { pid: 0, output: [], stdout: "", stderr: "", status: 0, signal: null };
      }
      if (command === "ps" && fault.kind === "inspection-error") {
        return {
          pid: 0,
          output: [],
          stdout: "",
          stderr: "permission denied",
          status: 1,
          signal: null,
        };
      }
      if (command !== "ps" && fault.kind === "missing-primitive") {
        return {
          pid: 0,
          output: [],
          stdout: "",
          stderr: "",
          status: null,
          signal: null,
          error: Object.assign(new Error("missing locking utility"), { code: "ENOENT" }),
        };
      }
      if (command !== "ps" && fault.kind === "primitive-error") {
        return {
          pid: 0,
          output: [],
          stdout: "",
          stderr: "unexpected primitive failure",
          status: 2,
          signal: null,
        };
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof NodeFs>();
  return { ...actual, closeSync: vi.fn(actual.closeSync), unlinkSync: vi.fn(actual.unlinkSync) };
});
const realFs = await vi.importActual<typeof NodeFs>("node:fs");
beforeEach(() => {
  vi.mocked(fs.closeSync).mockReset().mockImplementation(realFs.closeSync);
  vi.mocked(fs.unlinkSync).mockReset().mockImplementation(realFs.unlinkSync);
});
afterEach(() => {
  fault.kind = "";
  vi.unstubAllEnvs();
});

describe("state ownership prerequisites fail closed", () => {
  test.each([
    "missing-ps",
    "indeterminate",
    "inspection-error",
    "missing-primitive",
    "primitive-error",
  ])("%s preserves prior metadata and indexes without publishing jobs", async (kind) => {
    const h = await createHarness();
    const metadata = JSON.stringify({
      pid: process.pid,
      pid_started_at: "Thu Jan  1 00:00:00 1970",
    });
    try {
      await writeFile(join(h.stateDir, "lock"), metadata);
      await writeFile(join(h.stateDir, "active.json"), "[]\n");
      await writeFile(join(h.stateDir, "completed.json"), "[]\n");
      fault.kind = kind;
      if (kind === "missing-ps") vi.stubEnv("PATH", h.cwd);
      await expect(h.apply(ShudJobRegistry, h.config)).rejects.toThrow(
        kind.includes("primitive") ? "Cannot lock stateDir" : /process start identity/u,
      );
      expect(h.ctx.get("jobs")).toBeUndefined();
      expect(await readFile(join(h.stateDir, "lock"), "utf8")).toBe(metadata);
      expect(await readFile(join(h.stateDir, "active.json"), "utf8")).toBe("[]\n");
      expect(await readFile(join(h.stateDir, "completed.json"), "utf8")).toBe("[]\n");
      expect((await readdir(h.stateDir)).filter((name) => name.endsWith(".tmp"))).toEqual([]);
      fault.kind = "";
      vi.unstubAllEnvs();
      await h.apply(ShudJobRegistry, h.config);
    } finally {
      fault.kind = "";
      vi.unstubAllEnvs();
      await h.dispose();
    }
  });
});

describe("release failure outcomes", () => {
  test.each(["close only", "unlink and close"] as const)(
    "%s failure preserves original errors without claiming the guard was released",
    async (phase) => {
      const h = await createHarness();
      try {
        await h.apply(ShudJobRegistry, h.config);
        const store = publishedStore(h.ctx);
        const lockPath = join(h.stateDir, "lock");
        const metadata = await readFile(lockPath, "utf8");
        const active = await readFile(join(h.stateDir, "active.json"));
        const completed = await readFile(join(h.stateDir, "completed.json"));
        const { dev, ino } = realFs.statSync(join(h.stateDir, ".lock-guard"));
        const unlinkFailure = Object.assign(new Error("injected unlink failure"), {
          code: "EACCES",
        });
        const closeFailure = Object.assign(new Error("injected close failure"), { code: "EIO" });
        if (phase === "unlink and close") {
          vi.mocked(fs.unlinkSync).mockImplementation((path) => {
            if (path === lockPath) throw unlinkFailure;
            realFs.unlinkSync(path);
          });
        }
        vi.mocked(fs.closeSync)
          .mockClear()
          .mockImplementationOnce((fd) => {
            // Really close first so this test cannot leak the native descriptor. A thrown
            // close result proves diagnostic uncertainty, not that a real OS failure leaks.
            realFs.closeSync(fd);
            throw closeFailure;
          });
        const closing = store.close();
        const error: unknown = await closing.catch((reason: unknown) => reason);
        expect(error).toBeInstanceOf(Error);
        if (!(error instanceof Error)) throw new Error("close failure was swallowed");
        expect.soft(error.message).toContain(h.stateDir);
        expect.soft(error.message).toContain(lockPath);
        expect.soft(error.message).toMatch(/close/iu);
        expect.soft(error.message).toContain("EIO");
        expect.soft(error.message).toMatch(/guard.*(unknown|uncertain)/iu);
        expect.soft(error.message).not.toMatch(/guard (?:is |was |has been )?released\b/iu);
        if (phase === "unlink and close") {
          expect.soft(error).toBeInstanceOf(AggregateError);
          if (error instanceof AggregateError) {
            expect(error.errors).toHaveLength(2);
            expect(error.errors[0]).toBe(unlinkFailure);
            expect(error.errors[1]).toBe(closeFailure);
          }
          expect.soft(error.message).toContain("EACCES");
          expect.soft(error.message).toMatch(/unlink|remov/iu);
          expect(await readFile(lockPath, "utf8")).toBe(metadata);
        } else {
          expect.soft(error.cause).toBe(closeFailure);
          expect.soft(error.message).toMatch(/metadata.*removed/iu);
          expect(await readdir(h.stateDir)).not.toContain("lock");
        }
        expect(store.close()).toBe(closing);
        await expect(store.close()).rejects.toBe(error);
        expect(fs.closeSync).toHaveBeenCalledTimes(1);
        expect(
          vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath),
        ).toHaveLength(1);
        expect(await readFile(join(h.stateDir, "active.json"))).toEqual(active);
        expect(await readFile(join(h.stateDir, "completed.json"))).toEqual(completed);
        const after = realFs.statSync(join(h.stateDir, ".lock-guard"));
        expect({ dev: after.dev, ino: after.ino }).toEqual({ dev, ino });
      } finally {
        vi.mocked(fs.closeSync).mockImplementation(realFs.closeSync);
        vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
        await h.dispose();
      }
    },
  );

  test("missing metadata remains a release failure without claiming a known retained file", async () => {
    const h = await createHarness();
    try {
      await h.apply(ShudJobRegistry, h.config);
      const store = publishedStore(h.ctx);
      const lockPath = join(h.stateDir, "lock");
      // Model disappearance while still owning the guard, not a mocked ENOENT with a file present.
      realFs.unlinkSync(lockPath);
      let original: unknown;
      vi.mocked(fs.unlinkSync).mockImplementation((path) => {
        try {
          realFs.unlinkSync(path);
        } catch (error) {
          original = error;
          throw error;
        }
      });
      const closing = store.close();
      const error: unknown = await closing.catch((reason: unknown) => reason);
      expect(error).toBeInstanceOf(Error);
      if (!(error instanceof Error)) throw new Error("missing metadata was treated as success");
      expect(original).toMatchObject({ code: "ENOENT" });
      expect.soft(error.cause).toBe(original);
      expect(error.message).toContain(lockPath);
      expect(error.message).toContain("ENOENT");
      expect.soft(error.message).toMatch(/guard.*released/iu);
      expect.soft(error.message).toMatch(/metadata.*(absent|missing|not found)/iu);
      expect.soft(error.message).not.toMatch(/metadata (?:is |was )?(?:retained|remains)\b/iu);
      expect(store.close()).toBe(closing);
      await expect(store.close()).rejects.toBe(error);
      expect(
        vi.mocked(fs.unlinkSync).mock.calls.filter(([path]) => path === lockPath),
      ).toHaveLength(1);
      expect(await readdir(h.stateDir)).not.toContain("lock");
    } finally {
      vi.mocked(fs.unlinkSync).mockImplementation(realFs.unlinkSync);
      await h.dispose();
    }
  });
});
