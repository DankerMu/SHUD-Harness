import * as io from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { terminateGroup } from "./detached-shud/test-harness.ts";
import {
  pollFixture,
  readRecord,
  releaseRun,
  replaceRecord,
  seedRun,
} from "./poll-shud/test-harness.ts";

test.each([0, 13])(
  "online timer settles real exit %s only after durable terminal publication",
  async (code) => {
    const h = await pollFixture(code);
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      // The manual entrypoint shares the dispatcher; no exit evidence exists at this first tick.
      await h.registry.pollOnce();
      expect(producer.completed).toEqual([]);
      await releaseRun(record);
      // No further manual tick: the actual registry-owned timer must notice natural completion.
      await expect.poll(() => producer.completed.length, { timeout: 5000 }).toBe(1);
      await producer.doneObserved;
      const terminal = await readRecord(record.run_dir);
      expect(terminal.status).toBe(code === 0 ? "succeeded" : "failed");
      expect(terminal.exit_code).toBe(code);
      expect(terminal.finished_at).not.toBeNull();
      expect(producer.durableAtSettle).toEqual([terminal]);
      expect(producer.durableAtDone).toEqual([terminal]);
      expect(producer.completed[0].status).toBe(code === 0 ? "completed" : "failed");
      expect(producer.completed[0].detail).toContain(String(code));
      expect(producer.registration.cancellations).toEqual([]);
      await expect
        .poll(() => h.registry.get(producer.registration.handles[0].id).status)
        .toBe(code === 0 ? "completed" : "failed");
      await h.registry.pollOnce();
      expect(producer.attempts).toHaveLength(1);
      expect(h.registry.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
      expect(terminal.notify.status).toBe("pending");
      expect(await io.readdir(record.run_dir)).not.toContain("run-record.json");
      expect(h.flushes).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([0, 13])(
  "published exit %s wins over an existing cancellation request",
  async (code) => {
    const h = await pollFixture(code);
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      const cancelledAt = "2026-10-22T03:15:01.000Z";
      await replaceRecord(record, { cancel_requested_at: cancelledAt });
      // Existing snapshots must finish while the held wrapper still has no exit evidence.
      await h.registry.pollOnce();
      await releaseRun(record);
      await h.registry.pollOnce();
      const terminal = await readRecord(record.run_dir);
      expect(terminal.status).toBe(code === 0 ? "succeeded" : "failed");
      expect(terminal.exit_code).toBe(code);
      expect(terminal.cancel_requested_at).toBe(cancelledAt);
      expect(producer.completed[0].status).toBe(code === 0 ? "completed" : "failed");
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each([false, true])(
  "external SIGKILL without exit evidence settles cancellation=%s distinctly from numeric exit",
  async (cancelRequested) => {
    const h = await pollFixture();
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      if (record.pid === null) throw new Error("Actual wrapper identity is missing");
      if (cancelRequested) {
        await replaceRecord(record, { cancel_requested_at: "2026-10-22T03:15:01.000Z" });
        await h.registry.pollOnce();
      }
      await terminateGroup(record.pid);
      await expect(io.readFile(join(record.run_dir, "exit_code"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await h.registry.pollOnce();
      const terminal = await readRecord(record.run_dir);
      expect(terminal.status).toBe(cancelRequested ? "cancelled" : "failed");
      expect(terminal.exit_code).toBeNull();
      expect(terminal.finished_at).not.toBeNull();
      expect(producer.completed[0].status).toBe(cancelRequested ? "killed" : "failed");
      expect(producer.completed[0].detail).toMatch(cancelRequested ? /cancel/iu : /lost/iu);
      expect(producer.registration.cancellations).toEqual([]);
    } finally {
      await h.close();
    }
  },
  15000,
);

test("a running indexed record settles without any current dsh registration", async () => {
  const h = await pollFixture();
  try {
    const record = await seedRun(h);
    expect(h.registry.list()).toEqual([]);
    await io.writeFile(join(record.run_dir, "exit_code"), "13\n");
    await h.registry.pollOnce();
    const terminal = await readRecord(record.run_dir);
    expect(terminal).toMatchObject({
      status: "failed",
      exit_code: 13,
      dsh_job_id: null,
      dsh_job_ids: [],
    });
    expect(terminal.finished_at).not.toBeNull();
    expect(h.registry.list()).toEqual([]);
    expect(h.registry.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
  } finally {
    await h.close();
  }
});

test.each(["", " \n\t", "13junk", "1.5", "9007199254740992", "NaN"])(
  "invalid present exit bytes %j fail explicitly without inventing an integer or lost outcome",
  async (bytes) => {
    const h = await pollFixture();
    const { producer, pending } = h.start();
    try {
      const record = await pending;
      const evidence = join(record.run_dir, "exit_code");
      await io.writeFile(evidence, bytes);
      await h.registry.pollOnce();
      const terminal = await readRecord(record.run_dir);
      expect(terminal.status).toBe("failed");
      expect(terminal.exit_code).toBeNull();
      expect(producer.completed[0].status).toBe("failed");
      expect(producer.completed[0].detail).toMatch(/invalid|integer|empty/iu);
      expect(producer.completed[0].detail).not.toMatch(/lost/iu);
      expect(await io.readFile(evidence, "utf8")).toBe(bytes);
      expect(await io.readdir(record.run_dir)).not.toContain("collect-error.json");
    } finally {
      await h.close();
    }
  },
  15000,
);

test.each(["created", "submitted", "collected", "delivered", "unreachable"] as const)(
  "poll skips %s residue rather than claiming later reconciliation or notification work",
  async (kind) => {
    const h = await pollFixture();
    try {
      const record = await seedRun(
        h,
        kind === "delivered" || kind === "unreachable"
          ? { notify: { status: kind, attempts: 0, at: null, detail: null } }
          : {
              status: kind,
              ...(kind === "created" || kind === "submitted"
                ? { pid: null, pid_started_at: null, started_at: null }
                : {}),
            },
      );
      const path = join(record.run_dir, "run-job.json");
      const before = await io.readFile(path);
      const stat = await io.stat(path, { bigint: true });
      await io.writeFile(join(record.run_dir, "exit_code"), "0\n");
      await h.registry.pollOnce();
      await h.registry.pollOnce();
      expect(await io.readFile(path)).toEqual(before);
      expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
      expect(h.registry.list()).toEqual([]);
      expect(h.flushes).toEqual([]);
    } finally {
      await h.close();
    }
  },
);

test("terminal records without local completion receipts are not repeatedly rewritten", async () => {
  const h = await pollFixture();
  try {
    const record = await seedRun(h, {
      status: "succeeded",
      exit_code: 0,
      finished_at: "2026-10-22T03:15:02.000Z",
    });
    const path = join(record.run_dir, "run-job.json");
    const before = await io.readFile(path);
    const stat = await io.stat(path, { bigint: true });
    await h.registry.pollOnce();
    await h.registry.pollOnce();
    expect(await io.readFile(path)).toEqual(before);
    expect((await io.stat(path, { bigint: true })).mtimeNs).toBe(stat.mtimeNs);
    expect(h.registry.indexes.lookup(record.run_id)?.run_dir).toBe(record.run_dir);
  } finally {
    await h.close();
  }
});
