import * as io from "node:fs/promises";
import * as fs from "node:fs";
import { join } from "node:path";
import { inspect } from "node:util";
import { beforeEach, expect, test, vi } from "vitest";
import type { RunJob, TaskId } from "@shud-harness/dsh-shud-core";
import { barrier } from "./state-indexes/test-harness.ts";
import {
  OTHER_TASK,
  PRIVATE_PAYLOAD,
  TARGET_TASK,
  UNKNOWN_TASK,
  enteredBeforeCompletion,
  expectQueryFailure,
  observe,
  queryFixture,
  seedQueryRun,
  snapshotQueryTree,
} from "./list-run-jobs/test-harness.ts";

vi.mock("node:fs/promises", async (original) => {
  const actual = await original<typeof io>();
  return { ...actual, readFile: vi.fn(actual.readFile), lstat: vi.fn(actual.lstat) };
});
vi.mock("node:fs", async (original) => {
  const actual = await original<typeof fs>();
  return {
    ...actual,
    readFileSync: vi.fn(actual.readFileSync),
    lstatSync: vi.fn(actual.lstatSync),
  };
});
const nativeIo = await vi.importActual<typeof io>("node:fs/promises");
const nativeFs = await vi.importActual<typeof fs>("node:fs");
beforeEach(() => {
  vi.mocked(io.readFile).mockReset().mockImplementation(nativeIo.readFile);
  vi.mocked(io.lstat).mockReset().mockImplementation(nativeIo.lstat);
  vi.mocked(fs.readFileSync).mockReset().mockImplementation(nativeFs.readFileSync);
  vi.mocked(fs.lstatSync).mockReset().mockImplementation(nativeFs.lstatSync);
});

test("bound task query filters both owned indexes, sorts job ids and returns detached records without writes", async () => {
  const h = await queryFixture();
  try {
    const running = await seedQueryRun(h, "f003", {
      status: "running",
      pid: process.pid,
      pid_started_at: "2026-10-22T03:15:00.000Z",
      task_id: TARGET_TASK,
    });
    await seedQueryRun(h, "0001", { task_id: null });
    const completed = await seedQueryRun(h, "a002", { status: "collected" }, "completed");
    await seedQueryRun(h, "0002", { task_id: OTHER_TASK }, "completed");
    const first = await seedQueryRun(h, "1000", { status: "submitted" });
    await seedQueryRun(h, "0003", {}, "unindexed");
    const corrupt = await seedQueryRun(h, "0004", {}, "unindexed");
    await io.writeFile(join(corrupt.run_dir, "run-job.json"), PRIVATE_PAYLOAD);
    const before = await snapshotQueryTree(h.root);
    const indexes = h.registry.indexes.read();
    const logs = [...h.logs];
    const query = h.registry.listRunJobsByTask;
    const results = await query(TARGET_TASK);
    expect(results).toEqual([first, completed, running]);
    expect(results.map((record) => record.job_id)).toEqual([
      "JOB-20261022T031500-1000",
      "JOB-20261022T031500-a002",
      "JOB-20261022T031500-f003",
    ]);
    results[0].command.push("caller mutation");
    results[0].llm.response_model = "caller mutation";
    results[0].notify.attempts = 99;
    results[0].dsh_job_ids.push("shud-1111111111111111");
    results[0].run_dir = "/caller/mutation";
    results.reverse();
    expect(await query(TARGET_TASK)).toEqual([first, completed, running]);
    expect(await query(UNKNOWN_TASK)).toEqual([]);
    expect(h.registry.indexes.read()).toEqual(indexes);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
    expect(h.logs).toEqual(logs);
    expect(h.followups).toEqual([]);
    expect(h.flushes).toEqual([]);
  } finally {
    await h.close();
  }
}, 15000);

test("empty indexes return an empty list without consulting caller cwd or unindexed disk metadata", async () => {
  const h = await queryFixture();
  try {
    const record = await seedQueryRun(h, "a001", {}, "unindexed");
    await io.writeFile(join(record.run_dir, "run-job.json"), PRIVATE_PAYLOAD);
    const before = await snapshotQueryTree(h.root);
    vi.mocked(io.readFile).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual([]);
    expect(io.readFile).not.toHaveBeenCalled();
    expect(fs.readFileSync).not.toHaveBeenCalled();
    expect(await snapshotQueryTree(h.root)).toEqual(before);
  } finally {
    await h.close();
  }
});

test("all seven core-schema statuses and nullable M2 links remain queryable without linked files or exit evidence", async () => {
  const h = await queryFixture();
  try {
    const statuses = [
      "created",
      "submitted",
      "running",
      "succeeded",
      "failed",
      "cancelled",
      "collected",
    ] as const;
    const expected: RunJob[] = [];
    for (const [index, status] of statuses.entries()) {
      expected.push(
        await seedQueryRun(
          h,
          `a00${index}`,
          {
            status,
            ...(status === "running"
              ? { pid: process.pid, pid_started_at: "2026-10-22T03:15:00.000Z" }
              : {}),
          },
          index % 2 === 0 ? "active" : "completed",
        ),
      );
    }
    // The query validates RunJob, not branded linkage or collector-specific terminal completeness.
    const linked = await seedQueryRun(h, "ffff", {
      stack_id: "schema-valid-unresolved-stack",
      data_id: "schema-valid-unresolved-data",
    });
    expected.push(linked);
    const before = await snapshotQueryTree(h.root);
    const logs = [...h.logs];
    expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual(expected);
    expect(expected.slice(0, 7).map((record) => record.status)).toEqual(statuses);
    expect(expected.every((record) => record.finished_at === null)).toBe(true);
    expect(await snapshotQueryTree(h.root)).toEqual(before);
    expect(h.logs).toEqual(logs);
  } finally {
    await h.close();
  }
}, 15000);

test("invalid, wrong-brand and coercible task ids reject before index traversal or file access without echoing input", async () => {
  const h = await queryFixture();
  try {
    const record = await seedQueryRun(h, "a001");
    await io.writeFile(join(record.run_dir, "run-job.json"), PRIVATE_PAYLOAD);
    const coercion = vi.fn(() => TARGET_TASK);
    const values: unknown[] = [
      "TASK-0001",
      `TASK-${PRIVATE_PAYLOAD}`,
      record.run_id,
      record.job_id,
      null,
      undefined,
      453,
      [TARGET_TASK],
      { toString: coercion },
      { task_id: TARGET_TASK, secret: PRIVATE_PAYLOAD },
    ];
    const indexes = vi.spyOn(h.registry.indexes, "read");
    const before = await snapshotQueryTree(h.root);
    const logs = [...h.logs];
    vi.mocked(io.readFile).mockClear();
    vi.mocked(io.lstat).mockClear();
    vi.mocked(fs.readFileSync).mockClear();
    vi.mocked(fs.lstatSync).mockClear();
    try {
      for (const invalid of values) {
        // Deliberately cross the typed API boundary to exercise runtime brand validation.
        const error = await expectQueryFailure(
          h.registry.listRunJobsByTask(invalid as TaskId),
          "task_id",
        );
        expect(inspect(error, { depth: 12 })).not.toContain(record.run_id);
        expect(inspect(error, { depth: 12 })).not.toContain(record.job_id);
      }
      expect(coercion).not.toHaveBeenCalled();
      expect(indexes).not.toHaveBeenCalled();
      expect(io.readFile).not.toHaveBeenCalled();
      expect(io.lstat).not.toHaveBeenCalled();
      expect(fs.readFileSync).not.toHaveBeenCalled();
      expect(fs.lstatSync).not.toHaveBeenCalled();
      expect(h.logs).toEqual(logs);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
    } finally {
      indexes.mockRestore();
    }
  } finally {
    await h.close();
  }
});

test("each query snapshots owned indexes once rather than rereading disk indexes or discovering later entries", async () => {
  const h = await queryFixture();
  const entered = barrier();
  const release = barrier();
  let pending: Promise<unknown> | undefined;
  try {
    const first = await seedQueryRun(h, "a001");
    await io.writeFile(join(h.stateDir, "active.json"), PRIVATE_PAYLOAD);
    await io.writeFile(join(h.stateDir, "completed.json"), PRIVATE_PAYLOAD);
    let held = false;
    vi.mocked(io.readFile).mockImplementation(async (...args) => {
      if (args[0] === join(first.run_dir, "run-job.json") && !held) {
        held = true;
        entered.release();
        await release.waiting;
      }
      return nativeIo.readFile(...args);
    });
    const reads = vi.spyOn(h.registry.indexes, "read");
    try {
      const query = h.registry.listRunJobsByTask(TARGET_TASK);
      pending = observe(query);
      await enteredBeforeCompletion(entered.waiting, pending);
      const later = await seedQueryRun(h, "a002");
      const before = await snapshotQueryTree(h.root);
      release.release();
      expect(await query).toEqual([first]);
      expect(reads).toHaveBeenCalledTimes(1);
      expect(await snapshotQueryTree(h.root)).toEqual(before);
      expect(await h.registry.listRunJobsByTask(TARGET_TASK)).toEqual([first, later]);
    } finally {
      reads.mockRestore();
    }
  } finally {
    release.release();
    await pending;
    vi.mocked(io.readFile).mockImplementation(nativeIo.readFile);
    await h.close();
  }
}, 15000);
