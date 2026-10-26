import * as io from "node:fs/promises";
import { renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import type * as NodeIo from "node:fs/promises";
import { generateRunIdentifiers } from "@shud-harness/dsh-shud-core";
import { activeGroup } from "./detached-shud/test-harness.ts";
import { waitForRecovery } from "./reconcile-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  seedRun,
} from "./poll-shud/test-harness.ts";

const fault = vi.hoisted(() => ({
  mode: "",
  pid: 0,
  exitPath: "",
  code: 13,
  probes: 0,
  unreadable: "",
}));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      if (fault.mode && command === "ps" && args[0] === "-p" && args[1] === String(fault.pid)) {
        fault.probes++;
        if (fault.mode === "uncertain")
          return {
            pid: 0,
            output: [],
            stdout: "indeterminate inspection\n",
            stderr: "",
            status: 0,
            signal: null,
          };
        if (fault.mode === "publish") {
          writeFileSync(`${fault.exitPath}.publication`, `${fault.code}\n`);
          renameSync(`${fault.exitPath}.publication`, fault.exitPath);
        }
        const requested = args.join(" ");
        const native = actual.spawnSync(command, ["-p", String(fault.pid), "-o", "lstart="], {
          ...options,
          encoding: "utf8",
        });
        const stamp = fault.mode === "zombie" ? native.stdout.trim() : "Thu Jan  1 00:00:01 1970";
        const state = fault.mode === "zombie" ? "Z" : "S";
        const stdout = requested.includes("lstart=")
          ? `${stamp}${requested.includes("stat=") ? ` ${state}` : ""}\n`
          : `${state}\n`;
        return { ...native, stdout, stderr: "", status: 0, signal: null };
      }
      return actual.spawnSync(command, args, options);
    },
  };
});
vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof NodeIo>();
  return { ...actual, open: vi.fn(actual.open) };
});
const actualIo = await vi.importActual<typeof NodeIo>("node:fs/promises");
beforeEach(() => {
  fault.mode = "";
  fault.pid = 0;
  fault.exitPath = "";
  fault.probes = 0;
  fault.unreadable = "";
  vi.mocked(io.open)
    .mockReset()
    .mockImplementation(async (...args) => {
      if (args[0] === fault.unreadable)
        throw Object.assign(new Error("injected unreadable exit evidence"), { code: "EACCES" });
      return actualIo.open(...args);
    });
});

test.each([0, 13])(
  "exit %s published inside a death-identity probe beats cancellation on the mandatory reread",
  async (code) => {
    const h = await pollFixture();
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      if (record.pid === null) throw new Error("No actual wrapper identity");
      await replaceRecord(record, { cancel_requested_at: "2026-10-22T03:15:01.000Z" });
      // Drain any pre-mutation snapshot while the wrapper is still live and no exit is published.
      await h.registry.pollOnce();
      fault.pid = record.pid;
      fault.exitPath = join(record.run_dir, "exit_code");
      fault.code = code;
      fault.mode = "publish";
      await h.registry.pollOnce();
      expect(fault.probes).toBeGreaterThan(0);
      const terminal = producer.durableAtSettle[0];
      expect(terminal.status).toBe(code === 0 ? "succeeded" : "failed");
      expect(terminal.exit_code).toBe(code);
      expect(producer.completed[0].status).toBe(code === 0 ? "completed" : "failed");
      expect(activeGroup(record.pid)).toContain(record.pid);
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      fault.mode = "";
      await h.close();
    }
  },
  15000,
);

test.each(["zombie", "different"])(
  "observed %s execution identity with no exit evidence is lost, without signaling the process",
  async (mode) => {
    const h = await pollFixture();
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      if (record.pid === null) throw new Error("No actual wrapper identity");
      fault.pid = record.pid;
      fault.mode = mode;
      await h.registry.pollOnce();
      expect(fault.probes).toBeGreaterThan(0);
      expect(producer.durableAtSettle[0]).toMatchObject({ status: "failed", exit_code: null });
      expect(producer.completed[0].detail).toMatch(/lost/iu);
      // Only the OS inspection seam is faulted; normal poll must not signal the actual held group.
      expect(activeGroup(record.pid)).toContain(record.pid);
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      fault.mode = "";
      await h.close();
    }
  },
  15000,
);

test("equivalent ISO representations of the observed second-resolution stamp remain the same live process", async () => {
  const h = await pollFixture();
  const { producer, pending } = h.start();
  try {
    const record = await pending;
    if (!record.pid_started_at) throw new Error("No genuine wrapper timestamp");
    const equivalent = record.pid_started_at.replace(".000Z", "Z");
    expect(equivalent).not.toBe(record.pid_started_at);
    expect(Date.parse(equivalent)).toBe(Date.parse(record.pid_started_at));
    const written = await replaceRecord(record, { pid_started_at: equivalent });
    await h.registry.pollOnce();
    expect(await readRecord(record.run_dir)).toEqual(written);
    expect(producer.completed).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test("uncertain process inspection preserves the running record and completion while another entry progresses", async () => {
  const h = await pollFixture();
  const first = h.start();
  const healthy = h.start();
  try {
    const [record, other] = await Promise.all([first.pending, healthy.pending]);
    if (record.pid === null) throw new Error("No actual wrapper identity");
    const path = join(record.run_dir, "run-job.json");
    const bytes = await io.readFile(path);
    fault.pid = record.pid;
    fault.mode = "uncertain";
    await releaseRun(other);
    await waitForRecovery(async () => {
      await h.registry.pollOnce();
      expect(await io.readFile(path)).toEqual(bytes);
      expect(first.producer.completed).toEqual([]);
      expect(first.producer.registration.cancellations).toEqual([]);
      return healthy.producer.completed.length === 1;
    }, "healthy producer completion while uncertain inspection remains isolated");
    expect(await io.readFile(path)).toEqual(bytes);
    expect(first.producer.completed).toEqual([]);
    expect(first.producer.registration.cancellations).toEqual([]);
    expect(healthy.producer.durableAtSettle[0].status).toBe("succeeded");
    expect(healthy.producer.completed).toHaveLength(1);
    expect(h.errors.length).toBeGreaterThan(0);
  } finally {
    fault.mode = "";
    await h.close();
  }
}, 15000);

test("unreadable present exit evidence is failed with a diagnostic, not absent or lost", async () => {
  const h = await pollFixture();
  const { producer, pending } = h.start();
  try {
    const record = await pending;
    fault.unreadable = join(record.run_dir, "exit_code");
    await io.writeFile(fault.unreadable, "13\n");
    await h.registry.pollOnce();
    expect(await readRecord(record.run_dir)).toMatchObject({ status: "failed", exit_code: null });
    expect(producer.completed[0].detail).toMatch(/unreadable|EACCES|read/iu);
    expect(producer.completed[0].detail).not.toMatch(/lost/iu);
    expect(await actualIo.readFile(fault.unreadable, "utf8")).toBe("13\n");
  } finally {
    fault.unreadable = "";
    await h.close();
  }
}, 15000);

test.each(["invalid", "unreadable"] as const)(
  "disk-only %s exit evidence logs explicit diagnostics without consuming the evidence",
  async (kind) => {
    const h = await pollFixture();
    try {
      const record = await seedRun(h);
      const exitPath = join(record.run_dir, "exit_code");
      const bytes =
        kind === "invalid" ? "diagnostic-coverage-private-payload\n" : "-314159265358979\n";
      // Publish and arm the read fault in one synchronous turn, before a timer can read valid bytes.
      writeFileSync(exitPath, bytes);
      if (kind === "unreadable") fault.unreadable = exitPath;
      expect(h.registry.list()).toEqual([]);
      expect(h.producers).toEqual([]);

      await h.registry.pollOnce();

      const diagnostics = h.errors.filter((message) => message.includes(exitPath));
      expect(diagnostics).toHaveLength(1);
      expect(diagnostics[0]).toContain(exitPath);
      expect(diagnostics[0]).toContain(
        kind === "invalid" ? "Invalid exit_code integer" : "Unreadable exit_code",
      );
      if (kind === "unreadable") {
        expect(diagnostics[0]).toContain("EACCES");
        expect(diagnostics[0]).toContain("injected unreadable exit evidence");
      }
      expect(diagnostics[0]).not.toContain(bytes.trim());
      const terminal = await readRecord(record.run_dir);
      expect(terminal).toMatchObject({
        status: "failed",
        exit_code: null,
        dsh_job_id: null,
        dsh_job_ids: [],
      });
      expect(terminal.finished_at).not.toBeNull();
      expect(await actualIo.readFile(exitPath, "utf8")).toBe(bytes);
      expect(h.registry.list()).toEqual([]);
      await expect(h.registry.collectShud(record.run_id)).rejects.toThrow(/exit evidence/iu);
      expect(await io.readdir(record.run_dir)).toContain("collect-error.json");
    } finally {
      fault.unreadable = "";
      await h.close();
    }
  },
);

test.each(["corrupt", "run-id", "job-id", "run-dir"])(
  "%s record disagreement is preserved and isolated from a healthy entry",
  async (kind) => {
    const h = await pollFixture();
    const bad = h.start();
    const good = h.start();
    try {
      const [record, healthy] = await Promise.all([bad.pending, good.pending]);
      const ids = generateRunIdentifiers();
      const changed =
        kind === "run-id"
          ? { ...record, run_id: ids.run_id }
          : kind === "job-id"
            ? { ...record, job_id: ids.job_id }
            : { ...record, run_dir: join(h.root, "foreign-run") };
      const bytes = kind === "corrupt" ? "{not-json" : JSON.stringify(changed);
      const path = join(record.run_dir, "run-job.json");
      await io.writeFile(`${path}.corruption`, bytes);
      await io.rename(`${path}.corruption`, path);
      // Drain accepted valid snapshots before exit evidence can authorize a terminal write.
      await h.registry.pollOnce();
      await io.writeFile(join(record.run_dir, "exit_code"), "0\n");
      await releaseRun(healthy);
      await waitForRecovery(async () => {
        await h.registry.pollOnce();
        expect(await io.readFile(path, "utf8")).toBe(bytes);
        expect(bad.producer.completed).toEqual([]);
        expect(bad.producer.registration.cancellations).toEqual([]);
        return good.producer.completed.length === 1;
      }, "healthy producer completion while record disagreement remains isolated");
      expect(await io.readFile(path, "utf8")).toBe(bytes);
      expect(bad.producer.completed).toEqual([]);
      expect(bad.producer.registration.cancellations).toEqual([]);
      expect(h.registry.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
      expect(good.producer.durableAtSettle[0].status).toBe("succeeded");
      expect(good.producer.completed).toHaveLength(1);
      expect(h.errors.length).toBeGreaterThan(0);
    } finally {
      await h.close();
    }
  },
  15000,
);
