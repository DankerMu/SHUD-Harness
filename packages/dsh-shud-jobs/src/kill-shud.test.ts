import { readFileSync } from "node:fs";
import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test, vi } from "vitest";
import { RunJobSchema, type RunJob } from "@shud-harness/dsh-shud-core";
import { JobId } from "@deepseek-ai/dsh-jobs";
import { activeGroup, readInvocation } from "./detached-shud/test-harness.ts";
import { pollFixture, waitForEvidence } from "./poll-shud/test-harness.ts";
import {
  observeSignals,
  readDurable,
  readyRun,
  releaseBeforePoll,
} from "./kill-shud/test-harness.ts";
import { producer as parentProducer } from "./test-harness.ts";

test.each(["cancelled by the user", "stop this model experiment", "jobs service disposed"])(
  "public kill reason %s durably records intent before signaling and settles only after terminal publication",
  async (reason) => {
    const h = await pollFixture();
    const groupsAtSettle: number[][] = [];
    const { producer, pending } = h.start((_outcome, durable) => {
      if (durable.pid === null) throw new Error("Settled real execution has no wrapper identity");
      groupsAtSettle.push(activeGroup(durable.pid));
    });
    let restoreKill: (() => void) | undefined;
    try {
      const running = await pending;
      if (running.pid === null || running.dsh_job_id === null) {
        throw new Error("Real submission did not publish execution and registration identities");
      }
      const pid = running.pid;
      const id = producer.registration.handles[0].id;
      expect(id).toBe(running.dsh_job_id);
      waitForEvidence(running.run_dir, "invocation.json");
      const invocation = await readInvocation(running.run_dir);
      if (!invocation) throw new Error("Held SHUD did not publish its invocation");
      expect(activeGroup(pid)).toEqual(expect.arrayContaining([pid, invocation.pid]));
      await expect(io.readFile(join(running.run_dir, "exit_code"))).rejects.toMatchObject({
        code: "ENOENT",
      });

      const readDurable = () =>
        RunJobSchema.parse(JSON.parse(readFileSync(join(running.run_dir, "run-job.json"), "utf8")));
      const signals: Array<{ pid: number; signal: string | number; durable: RunJob }> = [];
      const realKill = process.kill.bind(process);
      const kill = vi.spyOn(process, "kill").mockImplementation((target, signal) => {
        // Observe disk at the actual system boundary, then forward every signal unchanged.
        if (signal !== 0)
          signals.push({ pid: target, signal: signal ?? "SIGTERM", durable: readDurable() });
        return realKill(target, signal);
      });
      restoreKill = () => kill.mockRestore();

      const result = h.registry.kill(id, h.ownerId, reason);
      expect(result).toBe("requested");
      // This is the initial RED discriminator: inherited kill returns requested but never writes intent.
      const intent = readDurable();
      expect(intent.cancel_requested_at).toEqual(expect.any(String));
      expect(intent).toEqual({ ...running, cancel_requested_at: intent.cancel_requested_at });
      expect(signals).toEqual([{ pid: -pid, signal: "SIGTERM", durable: intent }]);
      expect(producer.registration.cancellations).toEqual([]);
      expect(producer.completed).toEqual([]);

      // The existing live cadence, not cancellation itself, owns terminal persistence and done.
      await expect.poll(() => producer.completed.length, { timeout: 5000 }).toBe(1);
      await producer.doneObserved;
      const terminal = producer.durableAtSettle[0];
      expect(terminal.finished_at).toEqual(expect.any(String));
      expect(terminal).toEqual({
        ...intent,
        status: "cancelled",
        exit_code: null,
        finished_at: terminal.finished_at,
      });
      expect(producer.durableAtDone).toEqual([terminal]);
      expect(producer.completed[0].status).toBe("killed");
      expect(groupsAtSettle).toEqual([[]]);
      expect(activeGroup(pid)).toEqual([]);
      expect(producer.registration.cancellations).toEqual([]);
      await expect.poll(() => h.registry.get(id, h.ownerId).status).toBe("killed");
    } finally {
      restoreKill?.();
      // Existing cleanup terminates/reaps every owned execution even when inherited kill leaves it live.
      await h.close();
    }
  },
  15000,
);

test.each([0, 13])(
  "published natural exit %s wins over a synchronous public kill",
  async (code) => {
    const h = await pollFixture(code);
    try {
      const { record, id, producer } = await readyRun(h);
      releaseBeforePoll(record.run_dir);
      expect(readDurable(record.run_dir).status).toBe("running");
      expect(h.registry.kill(id, h.ownerId, "natural exit race")).toBe("requested");
      const intent = readDurable(record.run_dir).cancel_requested_at;
      expect(intent).toEqual(expect.any(String));
      await expect.poll(() => producer.completed.length).toBe(1);
      await producer.doneObserved;
      expect(producer.durableAtSettle[0]).toMatchObject({
        status: code === 0 ? "succeeded" : "failed",
        exit_code: code,
        cancel_requested_at: intent,
      });
      expect(producer.durableAtDone).toEqual(producer.durableAtSettle);
      expect(producer.completed[0].status).toBe(code === 0 ? "completed" : "failed");
      expect(producer.registration.cancellations).toEqual([]);
      expect(await h.registry.collectShud(record.run_id)).toMatchObject({
        exit_code: code,
        exit_class: code === 0 ? "ok" : "input",
      });
    } finally {
      await h.close();
    }
  },
  15000,
);

test("already-finished public kill preserves committed metadata and sends no signal", async () => {
  const h = await pollFixture();
  let signals: ReturnType<typeof observeSignals> | undefined;
  try {
    const { record, id, producer } = await readyRun(h);
    releaseBeforePoll(record.run_dir);
    await expect.poll(() => producer.completed.length).toBe(1);
    await h.registry.collectShud(record.run_id);
    await expect.poll(() => h.registry.get(id, h.ownerId).status).toBe("completed");
    const paths = ["run-job.json", "run-record.json"].map((name) => join(record.run_dir, name));
    const before = await Promise.all(
      paths.map(async (path) => ({
        bytes: await io.readFile(path),
        mtime: (await io.stat(path, { bigint: true })).mtimeNs,
      })),
    );
    signals = observeSignals();
    expect(h.registry.kill(id, h.ownerId, "too late")).toBe("already-finished");
    for (const [index, path] of paths.entries()) {
      expect(await io.readFile(path)).toEqual(before[index].bytes);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(before[index].mtime);
    }
    expect(readDurable(record.run_dir).cancel_requested_at).toBeNull();
    expect(signals.events).toEqual([]);
    expect(producer.registration.cancellations).toEqual([]);
  } finally {
    signals?.restore();
    await h.close();
  }
}, 15000);

test.each(["bash", "shud"])(
  "arbitrary kind %s registrations retain parent kill/access semantics",
  async (kind) => {
    const h = await pollFixture();
    let signals: ReturnType<typeof observeSignals> | undefined;
    try {
      const { record, pid } = await readyRun(h);
      await h.attachController(false);
      const ordinary = parentProducer(h.ownerId);
      const id = h.registry.start({ ...ordinary.spec, kind });
      const before = await io.readFile(join(record.run_dir, "run-job.json"));
      const indexes = h.registry.indexes.read();
      signals = observeSignals();
      expect(() => h.registry.kill(JobId("shud-0000000000000000"), h.ownerId)).toThrow(
        /unknown job/u,
      );
      expect(() => h.registry.kill(id, h.otherId, "unauthorized")).toThrow(/another session/u);
      expect(ordinary.cancels).toEqual([]);
      expect(h.registry.kill(id, h.ownerId, "ordinary cancellation")).toBe("requested");
      const outcome = await h.registry.wait(id, 1000, h.ownerId);
      expect(outcome.status).toBe("killed");
      expect(outcome.detail).toContain("ordinary cancellation");
      expect(ordinary.cancels).toEqual(["ordinary cancellation"]);
      expect(h.registry.kill(id, h.ownerId)).toBe("already-finished");
      expect(await io.readFile(join(record.run_dir, "run-job.json"))).toEqual(before);
      expect(h.registry.indexes.read()).toEqual(indexes);
      expect(activeGroup(pid)).toContain(pid);
      expect(signals.events).toEqual([]);
    } finally {
      signals?.restore();
      await h.close();
    }
  },
  15000,
);
