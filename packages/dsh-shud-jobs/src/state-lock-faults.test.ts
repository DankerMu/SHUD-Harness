import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import { ShudJobRegistry } from "./index.ts";
import { createHarness } from "./test-harness.ts";

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
