import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeIo from "node:fs/promises";
import type { RunId } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent, readResult } from "./collect-shud/test-harness.ts";
import { activeGroup, observedStart } from "./detached-shud/test-harness.ts";
import { observeSignals, readyRun } from "./kill-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  seedRun,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { closeRecovery, completedWithinWindow } from "./reconcile-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";

const fault = vi.hoisted(() => ({ path: "", code: "", reads: 0 }));
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, readFile: vi.fn(actual.readFile) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  fault.path = "";
  fault.code = "";
  fault.reads = 0;
  vi.mocked(io.readFile)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.path && fault.code) {
        fault.reads++;
        throw Object.assign(new Error("PRIVATE_WRAPPER_READ_PAYLOAD"), { code: fault.code });
      }
      return actualIo.readFile(...args);
    });
});

const cases = [
  { name: "symlink to a valid live foreign PID", kind: "symlink", diagnostic: "SYMLINK" },
  { name: "directory", kind: "directory", diagnostic: "NOT_REGULAR" },
  { name: "abc token", kind: "token", token: "abc", diagnostic: "INVALID_PID" },
  { name: "zero token", kind: "token", token: "0", diagnostic: "INVALID_PID" },
  { name: "negative token", kind: "token", token: "-3", diagnostic: "INVALID_PID" },
  {
    name: "unsafe integer token",
    kind: "token",
    token: "9007199254740992",
    diagnostic: "INVALID_PID",
  },
  { name: "EACCES read", kind: "read", diagnostic: "EACCES" },
  { name: "EIO read", kind: "read", diagnostic: "EIO" },
] as const;

test.each(cases)(
  "submitted wrapper.pid $name preserves evidence while another entry progresses",
  async (scenario) => {
    const h = await pollFixture();
    let foreignPid: number | undefined;
    let foreignRunId: RunId | undefined;
    let foreignChild: number | undefined;
    let foreignPath: string | undefined;
    let applying: Promise<unknown> | undefined;
    let restoreSignals: (() => void) | undefined;
    try {
      let submittedAt = new Date().toISOString();
      if (scenario.kind === "symlink") {
        const foreign = await readyRun(h);
        foreignPid = foreign.pid;
        foreignRunId = foreign.record.run_id;
        foreignChild = foreign.invocation.pid;
        foreignPath = join(foreign.record.run_dir, "wrapper.pid");
        expect(await io.readFile(foreignPath, "utf8")).toBe(`${foreignPid}\n`);
        // Earlier than both the launch boundary and native lstart: removing only the
        // file guard must reach R3, not an unrelated older-process/clock rejection.
        submittedAt = new Date(
          Math.min(Date.parse(submittedAt), Date.parse(observedStart(foreignPid))) - 1000,
        ).toISOString();
      }
      const record = await seedRun(
        h,
        {
          status: "submitted",
          pid: null,
          pid_started_at: null,
          started_at: null,
          submitted_at: submittedAt,
        },
        async (submitted) => {
          const wrapper = join(submitted.run_dir, "wrapper.pid");
          if (scenario.kind === "symlink") {
            if (!foreignPath) throw new Error("Foreign wrapper fixture was not prepared");
            await io.symlink(foreignPath, wrapper);
          } else if (scenario.kind === "directory") {
            await io.mkdir(wrapper);
          } else {
            await io.writeFile(
              wrapper,
              `${scenario.kind === "token" ? scenario.token : process.pid}\n`,
            );
          }
        },
      );
      // Admit the healthy entry after the faulty one to prove per-entry error isolation.
      const healthy = await seedRun(
        h,
        {
          status: "created",
          pid: null,
          pid_started_at: null,
          started_at: null,
          submitted_at: null,
        },
        async (created) => {
          await io.mkdir(join(created.run_dir, "output"));
          await io.writeFile(join(created.run_dir, "stdout.log"), "");
          await io.writeFile(join(created.run_dir, "stderr.log"), "");
        },
      );
      await h.fiber.dispose();
      await waitForOwnershipRelease(h.stateDir);
      const path = join(record.run_dir, "run-job.json");
      const bytes = await io.readFile(path);
      const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
      const errorsBefore = h.errors.length;
      const signals = observeSignals();
      restoreSignals = signals.restore;
      if (scenario.kind === "read") {
        fault.path = join(record.run_dir, "wrapper.pid");
        fault.code = scenario.diagnostic;
      }
      // Exercise startup alone; do not let normal cadence retry and obscure its diagnostics.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      applying = h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      await completedWithinWindow(applying);

      expect(await readRecord(record.run_dir)).toEqual(record);
      expect(await io.readFile(path)).toEqual(bytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
      await expectAbsent(join(record.run_dir, "run-record.json"));
      await expectAbsent(join(record.run_dir, "exit_code"));
      expect((await readRecord(healthy.run_dir)).status).toBe("collected");
      expect((await readResult(healthy.run_dir)).exit_class).toBe("lost");
      const replacement = actualRegistry(h.ctx);
      if (foreignRunId === undefined) {
        expect(replacement.list()).toEqual([]);
      } else {
        // The genuine foreign R5 entry is adoptable; the faulty submitted entry is not.
        expect(replacement.list()).toMatchObject([
          { kind: "shud", label: foreignRunId, status: "running" },
        ]);
      }
      expect(replacement.indexes.lookup(record.run_id)).toEqual({
        run_id: record.run_id,
        job_id: record.job_id,
        run_dir: record.run_dir,
      });
      expect(signals.events).toEqual([]);
      const diagnostics = h.errors.slice(errorsBefore).join("\n");
      expect(diagnostics).toContain(`Cannot reconcile SHUD run ${record.run_id}`);
      expect(diagnostics).toContain(`SHUD collect wrapper pid: ${scenario.diagnostic}`);
      expect(diagnostics).not.toContain("PRIVATE_WRAPPER_READ_PAYLOAD");
      if (scenario.kind === "read") expect(fault.reads).toBeGreaterThan(0);
      if (foreignPid !== undefined) {
        expect(activeGroup(foreignPid)).toContain(foreignPid);
        expect(activeGroup(foreignPid)).toContain(foreignChild);
        expect((await io.lstat(join(record.run_dir, "wrapper.pid"))).isSymbolicLink()).toBe(true);
        expect(await io.readFile(join(record.run_dir, "wrapper.pid"), "utf8")).toBe(
          `${foreignPid}\n`,
        );
      }
    } finally {
      fault.path = "";
      fault.code = "";
      restoreSignals?.();
      vi.useRealTimers();
      await closeRecovery(h, foreignPid, applying);
    }
  },
  15000,
);
