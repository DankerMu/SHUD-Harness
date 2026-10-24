import { renameSync, writeFileSync } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { beforeEach, expect, test, vi } from "vitest";
import type * as NodeChild from "node:child_process";
import { KILL_GRACE_PERIOD_MS } from "@shud-harness/dsh-shud-core";
import { ShudJobRegistry } from "./index.ts";
import { expectAbsent, readResult } from "./collect-shud/test-harness.ts";
import {
  activeGroup,
  installFakeShud,
  observedStart,
  terminateGroup,
} from "./detached-shud/test-harness.ts";
import { observeSignals } from "./kill-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  seedRun,
  waitForOwnershipRelease,
} from "./poll-shud/test-harness.ts";
import { actualRegistry } from "./submit-shud/test-harness.ts";
import { stopAtSubmitted, stopWhileRunning } from "./reconcile-shud/test-harness.ts";
import { deliveredWake, expectSingleWake } from "./wake-shud/test-harness.ts";

const publication = vi.hoisted(() => ({ pid: 0, path: "", probes: 0 }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof NodeChild>();
  return {
    ...actual,
    spawnSync(command: string, args: readonly string[], options: NodeChild.SpawnSyncOptions) {
      const result = actual.spawnSync(command, args, options);
      if (
        publication.path &&
        command === "ps" &&
        args[0] === "-p" &&
        args[1] === String(publication.pid)
      ) {
        publication.probes++;
        writeFileSync(`${publication.path}.publication`, "19\n");
        renameSync(`${publication.path}.publication`, publication.path);
      }
      return result;
    },
  };
});
beforeEach(() => {
  publication.pid = 0;
  publication.path = "";
  publication.probes = 0;
});

test.each([
  [0, "ok"],
  [19, "cvode"],
] as const)(
  "submitted exit %s while the host is down is collected as %s during apply",
  async (code, exitClass) => {
    const h = await pollFixture(code);
    try {
      const { record, submitted, producer } = await stopAtSubmitted(h);
      await releaseRun(record);
      await producer.executions[0].waitForExit();
      const invocationPath = join(record.run_dir, "invocation.json");
      const invocation = await io.readFile(invocationPath);
      const mtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      expect(await readRecord(record.run_dir)).toEqual(submitted);
      await expectAbsent(join(record.run_dir, "run-record.json"));

      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      expect(replacement).not.toBe(h.registry);
      expect(await readResult(record.run_dir)).toMatchObject({
        run_id: record.run_id,
        job_id: record.job_id,
        exit_code: code,
        exit_class: exitClass,
      });
      const collected = await readRecord(record.run_dir);
      expect(collected.status).toBe("collected");
      expect(collected.notify).toEqual(submitted.notify);
      expect(collected.dsh_job_id).toBe(submitted.dsh_job_id);
      expect(collected.dsh_job_ids).toEqual(submitted.dsh_job_ids);
      expect(replacement.list()).toEqual([]);
      expect(await io.readFile(invocationPath)).toEqual(invocation);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(mtime);
      expect(await io.readFile(join(record.run_dir, "exit_code"), "utf8")).toBe(`${code}\n`);
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([999, -1000])(
  "submitted live wrapper is promoted using the actual submission clock with offset %sms",
  async (offset) => {
    const h = await pollFixture();
    let restoreSignals: (() => void) | undefined;
    try {
      const { record, submitted, pid, invocation, stamp } = await stopAtSubmitted(h, offset);
      const invocationPath = join(record.run_dir, "invocation.json");
      const bytes = await io.readFile(invocationPath);
      const mtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      const signals = observeSignals();
      restoreSignals = signals.restore;

      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      const replacement = actualRegistry(h.ctx);
      expect(replacement).not.toBe(h.registry);
      const registrations = replacement.list();
      expect(registrations).toHaveLength(1);
      const adopted = registrations[0];
      if (!adopted) throw new Error("Promoted R3 run has no takeover registration");
      expect(adopted.id).not.toBe(submitted.dsh_job_id);
      expect(adopted.owner).toBeUndefined();
      expect(adopted).toMatchObject({ kind: "shud", label: record.run_id, status: "running" });
      expect(await readRecord(record.run_dir)).toEqual({
        ...submitted,
        status: "running",
        pid,
        pid_started_at: stamp,
        started_at: stamp,
        dsh_job_id: adopted.id,
        dsh_job_ids: [...submitted.dsh_job_ids, adopted.id],
      });
      expect(activeGroup(pid)).toContain(pid);
      expect(activeGroup(pid)).toContain(invocation.pid);
      expect(signals.events).toEqual([]);
      expect(replacement.list().map((job) => job.id)).toEqual([adopted.id]);
      expect(await io.readFile(invocationPath)).toEqual(bytes);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(mtime);
      await expectAbsent(join(record.run_dir, "exit_code"));
      await expectAbsent(join(record.run_dir, "run-record.json"));
    } finally {
      restoreSignals?.();
      await h.close();
    }
  },
  15000,
);

test("submitted wrapper from an earlier second is lost without signaling the live group", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    const { record, submitted: prior, pid, invocation } = await stopAtSubmitted(h);
    // The process already exists; a submission two wall-clock seconds ahead is definitely later.
    const submitted = await replaceRecord(prior, {
      submitted_at: new Date(Math.floor(Date.now() / 1000) * 1000 + 2000).toISOString(),
    });
    const signals = observeSignals();
    restoreSignals = signals.restore;

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(await readResult(record.run_dir)).toMatchObject({ exit_code: null, exit_class: "lost" });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.pid).toBeNull();
    expect(collected.pid_started_at).toBeNull();
    expect(collected.started_at).toBeNull();
    expect(collected.notify).toEqual(submitted.notify);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
  } finally {
    restoreSignals?.();
    await h.close();
  }
}, 15000);

test("submitted without a committed wrapper is collected as lost without respawn", async () => {
  const h = await pollFixture();
  try {
    await installFakeShud(h.shudBin, 0);
    const record = await seedRun(
      h,
      {
        status: "submitted",
        pid: null,
        pid_started_at: null,
        started_at: null,
        submitted_at: "2026-10-22T03:15:00.999Z",
      },
      async (submitted) => {
        await io.mkdir(join(submitted.run_dir, "output"));
        await io.writeFile(join(submitted.run_dir, "stdout.log"), "");
        await io.writeFile(join(submitted.run_dir, "stderr.log"), "");
        // An uncommitted temporary PID file is not evidence that a wrapper started.
        await io.writeFile(join(submitted.run_dir, "wrapper.pid.tmp"), `${process.pid}\n`);
      },
    );
    await h.fiber.dispose();
    await waitForOwnershipRelease(h.stateDir);

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(await readResult(record.run_dir)).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      status: "failed",
      exit_code: null,
      exit_class: "lost",
    });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.notify).toEqual(record.notify);
    expect(collected.pid).toBeNull();
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    await expectAbsent(join(record.run_dir, "wrapper.pid"));
    await expectAbsent(join(record.run_dir, "invocation.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
    expect(await io.readFile(join(record.run_dir, "wrapper.pid.tmp"), "utf8")).toBe(
      `${process.pid}\n`,
    );
  } finally {
    await h.close();
  }
}, 15000);

test("submitted exit 19 appearing during the non-live wrapper probe wins on the second read", async () => {
  const h = await pollFixture();
  try {
    const { record, submitted, pid, producer } = await stopAtSubmitted(h);
    await terminateGroup(pid);
    await producer.executions[0].waitForExit();
    await expectAbsent(join(record.run_dir, "exit_code"));
    publication.pid = pid;
    publication.path = join(record.run_dir, "exit_code");

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(publication.probes).toBeGreaterThan(0);
    expect(await readResult(record.run_dir)).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      exit_code: 19,
      exit_class: "cvode",
    });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.exit_code).toBe(19);
    expect(collected.notify).toEqual(submitted.notify);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    expect(await io.readFile(publication.path, "utf8")).toBe("19\n");
  } finally {
    publication.path = "";
    await h.close();
  }
}, 15000);

test("submitted without a timestamp retains live evidence and logs while another entry progresses", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    const healthy = await seedRun(
      h,
      {
        status: "created",
        pid: null,
        pid_started_at: null,
        submitted_at: null,
        started_at: null,
      },
      async (created) => {
        await io.mkdir(join(created.run_dir, "output"));
        await io.writeFile(join(created.run_dir, "stdout.log"), "");
        await io.writeFile(join(created.run_dir, "stderr.log"), "");
      },
    );
    const { record, submitted, pid, invocation } = await stopAtSubmitted(h);
    await replaceRecord(submitted, { submitted_at: null });
    const path = join(record.run_dir, "run-job.json");
    const bytes = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    const errorsBefore = h.errors.length;
    await expectAbsent(join(record.run_dir, "exit_code"));
    const signals = observeSignals();
    restoreSignals = signals.restore;

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect((await readResult(healthy.run_dir)).exit_class).toBe("lost");
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    expect(h.errors.length).toBeGreaterThan(errorsBefore);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
  } finally {
    restoreSignals?.();
    await h.close();
  }
}, 15000);

test("submitted numeric exit still wins when its unused submission timestamp is absent", async () => {
  const h = await pollFixture();
  try {
    const { record, submitted, producer } = await stopAtSubmitted(h);
    await replaceRecord(submitted, { submitted_at: null });
    await releaseRun(record);
    await producer.executions[0].waitForExit();

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(await readResult(record.run_dir)).toMatchObject({ exit_code: 0, exit_class: "ok" });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.submitted_at).toBeNull();
    expect(collected.notify).toEqual(submitted.notify);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test("matching live running identity survives R5 registration publication at replacement readiness", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    const { record, pid, invocation } = await stopWhileRunning(h);
    const path = join(record.run_dir, "run-job.json");
    const invocationPath = join(record.run_dir, "invocation.json");
    const receipt = await io.readFile(invocationPath);
    const receiptMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
    const signals = observeSignals();
    restoreSignals = signals.restore;
    // Hold only normal interval ticks: awaited apply must be sufficient without help from polling.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    expect(replacement).not.toBe(h.registry);
    const registrations = replacement.list();
    expect(registrations).toHaveLength(1);
    const adopted = registrations[0];
    if (!adopted) throw new Error("R5 takeover did not publish a registration");
    expect(adopted.id).not.toBe(record.dsh_job_id);
    expect(adopted.owner).toBeUndefined();
    expect(adopted).toMatchObject({ kind: "shud", label: record.run_id, status: "running" });
    expect(await readRecord(record.run_dir)).toEqual({
      ...record,
      dsh_job_id: adopted.id,
      dsh_job_ids: [...record.dsh_job_ids, adopted.id],
    });
    const bytes = await io.readFile(path);
    const mtime = (await io.stat(path, { bigint: true })).mtimeNs;
    await replacement.pollOnce();
    expect(await io.readFile(path)).toEqual(bytes);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(mtime);
    expect(await io.readFile(invocationPath)).toEqual(receipt);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(receiptMtime);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);
    expect(replacement.list().map((job) => job.id)).toEqual([adopted.id]);
    await expectAbsent(join(record.run_dir, "run-record.json"));
    await expectAbsent(join(record.run_dir, "exit_code"));
  } finally {
    restoreSignals?.();
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test.each([
  [0, "ok"],
  [19, "cvode"],
] as const)(
  "running exit %s during downtime is collected as %s before replacement readiness",
  async (code, exitClass) => {
    const h = await pollFixture(code);
    try {
      const { record, producer } = await stopWhileRunning(h);
      await releaseRun(record);
      await producer.executions[0].waitForExit();
      expect(await readRecord(record.run_dir)).toEqual(record);
      await expectAbsent(join(record.run_dir, "run-record.json"));
      const invocationPath = join(record.run_dir, "invocation.json");
      const receipt = await io.readFile(invocationPath);
      const mtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      expect(await readResult(record.run_dir)).toMatchObject({
        run_id: record.run_id,
        job_id: record.job_id,
        exit_code: code,
        exit_class: exitClass,
      });
      const collected = await readRecord(record.run_dir);
      expect(collected.status).toBe("collected");
      expect(collected.exit_code).toBe(code);
      expect(collected.notify).toEqual(record.notify);
      expect(collected.dsh_job_id).toBe(record.dsh_job_id);
      expect(collected.dsh_job_ids).toEqual(record.dsh_job_ids);
      expect(actualRegistry(h.ctx).list()).toEqual([]);
      expect(await io.readFile(invocationPath)).toEqual(receipt);
      expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(mtime);
      const resultPath = join(record.run_dir, "run-record.json");
      const resultBytes = await io.readFile(resultPath);
      const resultMtime = (await io.stat(resultPath, { bigint: true })).mtimeNs;
      expect((await readResult(record.run_dir)).artifacts.files).toEqual([]);
      await h.mountSessionController();
      const replacement = actualRegistry(h.ctx);
      await deliveredWake(replacement, record.run_dir);
      expectSingleWake(h, record.run_id, exitClass, 0);
      expect((await readRecord(record.run_dir)).notify).toMatchObject({
        status: "delivered",
        attempts: 0,
      });
      expect(replacement.indexes.read()).toEqual({
        active: [],
        completed: [{ run_id: record.run_id, job_id: record.job_id, run_dir: record.run_dir }],
      });
      expect(await io.readFile(resultPath)).toEqual(resultBytes);
      expect((await io.stat(resultPath, { bigint: true })).mtimeNs).toBe(resultMtime);
      expect(await io.readFile(invocationPath)).toEqual(receipt);
    } finally {
      try {
        await h.close();
      } finally {
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test.each([
  { identity: "dead", cancelled: false, exitClass: "lost" },
  { identity: "reused", cancelled: false, exitClass: "lost" },
  { identity: "dead", cancelled: true, exitClass: "cancelled" },
  { identity: "reused", cancelled: true, exitClass: "cancelled" },
] as const)(
  "running $identity identity with cancellation=$cancelled is collected as $exitClass without signals",
  async ({ identity, cancelled, exitClass }) => {
    const h = await pollFixture();
    let restoreSignals: (() => void) | undefined;
    try {
      const { record, pid, invocation, producer } = await stopWhileRunning(h);
      const checkpoint = await replaceRecord(record, {
        ...(identity === "reused" ? { pid_started_at: "1970-01-01T00:00:01.000Z" } : {}),
        cancel_requested_at: cancelled ? "2026-10-22T03:15:01.000Z" : null,
      });
      if (identity === "dead") {
        await terminateGroup(pid);
        await producer.executions[0].waitForExit();
      }
      await expectAbsent(join(record.run_dir, "exit_code"));
      const invocationPath = join(record.run_dir, "invocation.json");
      const receipt = await io.readFile(invocationPath);
      const signals = observeSignals();
      restoreSignals = signals.restore;
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

      await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
      expect(await readResult(record.run_dir)).toMatchObject({
        run_id: record.run_id,
        job_id: record.job_id,
        exit_code: null,
        exit_class: exitClass,
      });
      const collected = await readRecord(record.run_dir);
      expect(collected.status).toBe("collected");
      expect(collected.exit_code).toBeNull();
      expect(collected.cancel_requested_at).toBe(checkpoint.cancel_requested_at);
      expect(collected.notify).toEqual(checkpoint.notify);
      expect(signals.events).toEqual([]);
      expect(actualRegistry(h.ctx).list()).toEqual([]);
      expect(await io.readFile(invocationPath)).toEqual(receipt);
      if (identity === "reused") {
        expect(activeGroup(pid)).toContain(pid);
        expect(activeGroup(pid)).toContain(invocation.pid);
      } else expect(activeGroup(pid)).toEqual([]);
    } finally {
      restoreSignals?.();
      try {
        await h.close();
      } finally {
        vi.useRealTimers();
      }
    }
  },
  15000,
);

test("running exit 19 published during the non-live probe beats cancellation at readiness", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    const { record, pid, producer } = await stopWhileRunning(h);
    const checkpoint = await replaceRecord(record, {
      cancel_requested_at: "2026-10-22T03:15:01.000Z",
    });
    await terminateGroup(pid);
    await producer.executions[0].waitForExit();
    await expectAbsent(join(record.run_dir, "exit_code"));
    publication.pid = pid;
    publication.path = join(record.run_dir, "exit_code");
    const signals = observeSignals();
    restoreSignals = signals.restore;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(publication.probes).toBeGreaterThan(0);
    expect(await readResult(record.run_dir)).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      exit_code: 19,
      exit_class: "cvode",
    });
    const collected = await readRecord(record.run_dir);
    // Collection can recover numeric evidence itself; this also proves settlement reread it.
    expect(collected.exit_code).toBe(19);
    expect(collected.status).toBe("collected");
    expect(collected.cancel_requested_at).toBe(checkpoint.cancel_requested_at);
    expect(collected.notify).toEqual(checkpoint.notify);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    expect(signals.events).toEqual([]);
  } finally {
    publication.path = "";
    restoreSignals?.();
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("expired recovered cancellation kills the resistant group before replacement readiness without new grace", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    await installFakeShud(h.shudBin, 0, "resistant");
    const { record, pid, invocation, producer } = await stopWhileRunning(h);
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(observedStart(pid)).toBe(record.pid_started_at);
    const checkpoint = await replaceRecord(record, {
      cancel_requested_at: new Date(Date.now() - KILL_GRACE_PERIOD_MS - 1000).toISOString(),
    });
    await expectAbsent(join(record.run_dir, "exit_code"));
    const invocationPath = join(record.run_dir, "invocation.json");
    const receipt = await io.readFile(invocationPath);
    const receiptMtime = (await io.stat(invocationPath, { bigint: true })).mtimeNs;
    const signals = observeSignals();
    restoreSignals = signals.restore;
    // Only startup may advance recovery; native process execution and the grace clock stay real.
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
    const started = performance.now();

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    expect(performance.now() - started).toBeLessThan(KILL_GRACE_PERIOD_MS);
    expect(signals.events).toContainEqual({ pid: -pid, signal: "SIGKILL" });
    expect(signals.events.every((event) => event.pid === -pid)).toBe(true);
    expect(activeGroup(pid)).toEqual([]);
    await producer.executions[0].waitForExit();
    expect(await readResult(record.run_dir)).toMatchObject({
      run_id: record.run_id,
      job_id: record.job_id,
      exit_code: null,
      exit_class: "cancelled",
    });
    const collected = await readRecord(record.run_dir);
    expect(collected.status).toBe("collected");
    expect(collected.exit_code).toBeNull();
    expect(collected.cancel_requested_at).toBe(checkpoint.cancel_requested_at);
    expect(collected.notify).toEqual(checkpoint.notify);
    expect(collected.dsh_job_id).toBe(checkpoint.dsh_job_id);
    expect(collected.dsh_job_ids).toEqual(checkpoint.dsh_job_ids);
    expect(actualRegistry(h.ctx).list()).toEqual([]);
    expect(await io.readFile(invocationPath)).toEqual(receipt);
    expect((await io.stat(invocationPath, { bigint: true })).mtimeNs).toBe(receiptMtime);
  } finally {
    restoreSignals?.();
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);

test("replacement recovers a live submitted wrapper with the untouched real submission timestamp", async () => {
  const h = await pollFixture();
  let restoreSignals: (() => void) | undefined;
  try {
    const { record, submitted, pid, invocation, stamp } = await stopAtSubmitted(h);
    expect(submitted.submitted_at).toBe(record.submitted_at);
    const signals = observeSignals();
    restoreSignals = signals.restore;
    vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });

    await h.apply(ShudJobRegistry, { ...h.config, pumpPollMs: 7 });
    const replacement = actualRegistry(h.ctx);
    const registrations = replacement.list();
    expect(registrations).toHaveLength(1);
    const adopted = registrations[0];
    if (!adopted) throw new Error("Promoted R3 run has no takeover registration");
    expect(adopted.id).not.toBe(submitted.dsh_job_id);
    expect(adopted.owner).toBeUndefined();
    expect(adopted).toMatchObject({ kind: "shud", label: record.run_id, status: "running" });
    expect(await readRecord(record.run_dir)).toEqual({
      ...submitted,
      status: "running",
      pid,
      pid_started_at: stamp,
      started_at: stamp,
      dsh_job_id: adopted.id,
      dsh_job_ids: [...submitted.dsh_job_ids, adopted.id],
    });
    expect(activeGroup(pid)).toContain(pid);
    expect(activeGroup(pid)).toContain(invocation.pid);
    expect(signals.events).toEqual([]);
    expect(replacement.list().map((job) => job.id)).toEqual([adopted.id]);
    await expectAbsent(join(record.run_dir, "run-record.json"));
  } finally {
    restoreSignals?.();
    try {
      await h.close();
    } finally {
      vi.useRealTimers();
    }
  }
}, 15000);
